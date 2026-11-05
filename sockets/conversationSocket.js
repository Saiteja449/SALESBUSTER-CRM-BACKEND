import audioBufferService from "../services/audio/audioBufferService.js";
import { LiveTranscriptionSession } from "../services/transcription/liveTranscriptionService.js";
import conversationFinalizationService from "../services/conversation/conversationFinalizationService.js";
import { getMasterModels } from "../services/tenantManager.js";

/**
 * Registers standardized Conversation Capture socket event listeners.
 * Also registers backward-compatible aliases for legacy mobile events.
 * @param {import("socket.io").Socket} socket
 */
export function registerConversationSocketHandlers(socket) {
  /**
   * Helper to resolve tenant organization document
   */
  const resolveOrganization = async () => {
    try {
      const { Organization: MasterOrg } = getMasterModels();
      const orgId = socket.user?.organizationId;
      return orgId ? await MasterOrg.findById(orgId).lean() : null;
    } catch (e) {
      return null;
    }
  };

  // =========================================================================
  // 1. conversation:start (Alias: event_voice_start)
  // =========================================================================
  const handleStart = async (data = {}) => {
    try {
      const sessionId =
        data.sessionId ||
        `conv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const eventId = data.eventId || null;
      const eventName = data.eventName || "";
      const customVocabulary = data.customVocabulary || [eventName].filter(Boolean);

      console.log(
        `[ConversationSocket] Starting capture session ${sessionId} for user ${socket.user?.id || socket.user?._id}`
      );

      // Close pre-existing session if active on this socket
      if (socket.conversationCaptureSession) {
        try {
          socket.conversationCaptureSession.liveTranscriber?.close();
        } catch {}
        socket.conversationCaptureSession = null;
      }

      const organization = await resolveOrganization();

      // Start disk & memory audio buffer
      audioBufferService.startSession({
        sessionId,
        userId: socket.user?.id || socket.user?._id,
        organizationId: socket.user?.organizationId,
      });

      // Start Model 1: Live Transcription with gemini-3.5-transcribe-live
      const liveTranscriber = new LiveTranscriptionSession({
        sessionId,
        socket,
        organization,
        user: socket.user,
        customVocabulary,
        onTranscriptInterim: (interimData) => {
          // Can optionally trigger lightweight provisional extraction suggestions
        },
        onError: (err) => {
          console.warn(`[ConversationSocket] Live transcriber error for ${sessionId}:`, err.message);
        },
      });

      await liveTranscriber.start();

      socket.conversationCaptureSession = {
        sessionId,
        eventId,
        eventName,
        organization,
        user: socket.user,
        liveTranscriber,
        startedAt: Date.now(),
        isPaused: false,
      };

      socket.emit("conversation:ready", {
        sessionId,
        status: "ready",
        model: liveTranscriber.liveModel,
        startedAt: Date.now(),
      });
      // Legacy alias
      socket.emit("bi_voice_ready", {
        sessionId,
        model: liveTranscriber.liveModel,
        provider: "gemini",
      });
    } catch (err) {
      console.error("[ConversationSocket] Error in conversation:start:", err);
      socket.emit("conversation:error", {
        sessionId: data?.sessionId || null,
        message: err.message || "Failed to initialize conversation session",
      });
      socket.emit("bi_voice_error", {
        message: err.message || "Failed to initialize conversation session",
      });
    }
  };

  // =========================================================================
  // 2. conversation:audio_chunk (Alias: event_voice_audio_in)
  // =========================================================================
  const handleAudioChunk = (chunkPayload) => {
    const session = socket.conversationCaptureSession;
    if (!session || session.isPaused) return;

    let base64Data = null;
    let sequenceNumber = null;
    let timestamp = null;

    if (typeof chunkPayload === "string") {
      base64Data = chunkPayload;
    } else if (chunkPayload && typeof chunkPayload === "object") {
      base64Data = chunkPayload.data || chunkPayload.chunk || null;
      sequenceNumber = chunkPayload.sequenceNumber ?? chunkPayload.seq ?? null;
      timestamp = chunkPayload.timestamp ?? null;
    }

    if (!base64Data) return;

    // Buffer chunk on server for finalization
    audioBufferService.pushChunk({
      sessionId: session.sessionId,
      sequenceNumber,
      timestamp,
      data: base64Data,
    });

    // Stream chunk to live transcription model
    if (session.liveTranscriber) {
      session.liveTranscriber.sendAudioChunk(base64Data);
    }
  };

  // =========================================================================
  // 3. conversation:pause & conversation:resume
  // =========================================================================
  const handlePause = () => {
    if (socket.conversationCaptureSession) {
      socket.conversationCaptureSession.isPaused = true;
      socket.emit("conversation:status", { state: "paused" });
    }
  };

  const handleResume = () => {
    if (socket.conversationCaptureSession) {
      socket.conversationCaptureSession.isPaused = false;
      socket.emit("conversation:status", { state: "listening" });
    }
  };

  // =========================================================================
  // 4. conversation:stop (Alias: event_voice_stop)
  // =========================================================================
  const handleStop = async (data = {}) => {
    const session = socket.conversationCaptureSession;
    const sessionId = data.sessionId || session?.sessionId;

    if (!sessionId) {
      console.warn("[ConversationSocket] Stop requested but no active sessionId found");
      return;
    }

    console.log(`[ConversationSocket] Stop received for session: ${sessionId}`);

    let liveTranscript = "";
    let liveDurationSec = 0;

    if (session) {
      liveDurationSec = (Date.now() - session.startedAt) / 1000;
      if (session.liveTranscriber) {
        liveTranscript = session.liveTranscriber.accumulatedLiveTranscript || "";
        session.liveTranscriber.close();
      }
      socket.conversationCaptureSession = null;
    }

    const clientTranscript = (data?.liveTranscript || data?.transcript || data?.committedTranscript || "").trim();
    if (clientTranscript && clientTranscript.length > liveTranscript.length) {
      liveTranscript = clientTranscript;
    }

    const organization = session?.organization || (await resolveOrganization());
    const user = session?.user || socket.user;
    const eventId = data.eventId || session?.eventId || null;

    try {
      // Trigger post-processing: Model 2 (Diarization) -> Model 3 (Extraction & Summary) -> DB
      await conversationFinalizationService.finalizeConversation({
        sessionId,
        socket,
        organization,
        user,
        eventId,
        liveTranscript,
        liveDurationSec,
      });
    } catch (err) {
      console.error(`[ConversationSocket] Finalization failed for ${sessionId}:`, err);
      socket.emit("conversation:error", {
        sessionId,
        message: err.message || "Failed to finalize conversation",
      });
      socket.emit("bi_voice_error", {
        message: err.message || "Failed to finalize conversation",
      });
    }
  };

  // Register Standardized Events
  socket.on("conversation:start", handleStart);
  socket.on("conversation:audio_chunk", handleAudioChunk);
  socket.on("conversation:pause", handlePause);
  socket.on("conversation:resume", handleResume);
  socket.on("conversation:stop", handleStop);

  // Register Backwards-Compatible Legacy Aliases
  socket.on("event_voice_start", handleStart);
  socket.on("event_voice_audio_in", handleAudioChunk);
  socket.on("event_voice_stop", handleStop);

  // Disconnect Cleanup
  socket.on("disconnect", () => {
    if (socket.conversationCaptureSession?.liveTranscriber) {
      socket.conversationCaptureSession.liveTranscriber.close();
      socket.conversationCaptureSession = null;
    }
  });
}

export default registerConversationSocketHandlers;

