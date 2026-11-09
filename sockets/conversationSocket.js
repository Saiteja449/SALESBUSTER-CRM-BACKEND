import audioBufferService from "../services/audio/audioBufferService.js";
import { LiveTranscriptionSession } from "../services/transcription/liveTranscriptionService.js";
import conversationFinalizationService from "../services/conversation/conversationFinalizationService.js";
import { getMasterModels } from "../services/tenantManager.js";

/**
 * Registers Conversation Capture socket event listeners (single canonical `conversation:*` set).
 * Client -> server: conversation:start | conversation:audio_chunk | conversation:stop
 * Server -> client: conversation:ready | conversation:error | conversation:transcript_interim |
 *                   conversation:transcript_final | conversation:processing | conversation:completed
 * Implements session-level idempotency and protects active sessions against duplicate triggers.
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
  // 1. conversation:start
  // =========================================================================
  const handleStart = async (data = {}) => {
    try {
      const sessionId =
        data.sessionId ||
        `conv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const eventId = data.eventId || null;
      const eventName = data.eventName || "";
      const customVocabulary =
        data.customVocabulary || [eventName].filter(Boolean);

      // Session-Level Idempotency Check:
      // If an active session already exists on this socket
      if (socket.conversationCaptureSession) {
        const current = socket.conversationCaptureSession;

        // Same session ID arriving again (e.g. client retried conversation:start)
        if (data.sessionId && current.sessionId === data.sessionId) {
          console.log(
            `[ConversationSocket] Duplicate start for active session ${sessionId}. Re-emitting ready without re-initializing.`,
          );
          socket.emit("conversation:ready", {
            sessionId: current.sessionId,
            status: "ready",
            model: current.liveTranscriber?.liveModel || "gemini-3.8-live",
            startedAt: current.startedAt,
          });
          return;
        }

        // Rapid duplicate start within 1.5s window
        if (Date.now() - current.startedAt < 1500) {
          console.log(
            `[ConversationSocket] Rapid duplicate start on socket for session ${current.sessionId}. Preserving active session.`,
          );
          socket.emit("conversation:ready", {
            sessionId: current.sessionId,
            status: "ready",
            model: current.liveTranscriber?.liveModel || "gemini-3.8-live",
            startedAt: current.startedAt,
          });
          return;
        }

        // Truly a new subsequent session: cleanly close pre-existing live transcriber
        console.log(
          `[ConversationSocket] Closing pre-existing session ${current.sessionId} for new session ${sessionId}`,
        );
        try {
          current.liveTranscriber?.close();
        } catch {}
        socket.conversationCaptureSession = null;
      }

      console.log(
        `[ConversationSocket] Starting capture session ${sessionId} for user ${socket.user?.id || socket.user?._id}`,
      );

      const organization = await resolveOrganization();

      // Start disk & memory audio buffer
      audioBufferService.startSession({
        sessionId,
        userId: socket.user?.id || socket.user?._id,
        organizationId: socket.user?.organizationId,
      });

      // One Gemini Live session handles transcription and structured field capture.
      const liveTranscriber = new LiveTranscriptionSession({
        sessionId,
        socket,
        organization,
        user: socket.user,
        customVocabulary,
        eventId,
        eventName,
        onTranscriptInterim: (interimData) => {
          // Provisional updates emitted by liveTranscriber
        },
        onError: (err) => {
          console.warn(
            `[ConversationSocket] Live transcriber error for ${sessionId}:`,
            err.message,
          );
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
        audioChunkCount: 0,
      };

      socket.emit("conversation:ready", {
        sessionId,
        status: "ready",
        model: liveTranscriber.liveModel,
        startedAt: Date.now(),
      });
    } catch (err) {
      console.error("[ConversationSocket] Error in conversation:start:", err);
      socket.emit("conversation:error", {
        sessionId: data?.sessionId || null,
        message: err.message || "Failed to initialize conversation session",
      });
    }
  };

  // =========================================================================
  // 2. conversation:audio_chunk
  // =========================================================================
  const handleAudioChunk = (chunkPayload) => {
    const session = socket.conversationCaptureSession;
    if (!session) return;

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

    session.audioChunkCount += 1;

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
  // 3. conversation:stop
  // =========================================================================
  const handleStop = async (data = {}) => {
    const session = socket.conversationCaptureSession;
    const sessionId =
      data.sessionId || session?.sessionId || socket._lastActiveSessionId;

    if (!sessionId) {
      console.warn(
        "[ConversationSocket] Stop requested but no active sessionId found",
      );
      return;
    }

    console.log(`[ConversationSocket] Stop received for session: ${sessionId} (audioChunks=${session?.audioChunkCount || 0}, transcriptChars=${session?.liveTranscriber?.accumulatedLiveTranscript?.length || 0})`);
    socket._lastActiveSessionId = sessionId;

    let liveTranscript = "";
    let liveDurationSec = 0;

    if (session && session.sessionId === sessionId) {
      liveDurationSec = (Date.now() - session.startedAt) / 1000;
      if (session.liveTranscriber) {
        liveTranscript =
          session.liveTranscriber.accumulatedLiveTranscript || "";
        try {
          session.liveTranscriber.close();
        } catch {}
      }
      socket.conversationCaptureSession = null;
    }

    const clientTranscript = (
      data?.liveTranscript ||
      data?.transcript ||
      data?.committedTranscript ||
      ""
    ).trim();
    if (clientTranscript && clientTranscript.length > liveTranscript.length) {
      liveTranscript = clientTranscript;
    }

    const organization = session?.organization || (await resolveOrganization());
    const user = session?.user || socket.user;
    const eventId = data.eventId || session?.eventId || null;

    try {
      // Persist the transcript and structured fields collected by the live model.
      await conversationFinalizationService.finalizeConversation({
        sessionId,
        socket,
        organization,
        user,
        eventId,
        liveTranscript,
        liveCaptureData: session?.liveTranscriber?.latestContact || {},
        liveDurationSec,
      });
    } catch (err) {
      console.error(
        `[ConversationSocket] Finalization failed for ${sessionId}:`,
        err,
      );
      socket.emit("conversation:error", {
        sessionId,
        message: err.message || "Failed to finalize conversation",
      });
    }
  };

  socket.on("conversation:start", handleStart);
  socket.on("conversation:audio_chunk", handleAudioChunk);
  socket.on("conversation:stop", handleStop);

  // Disconnect Cleanup
  socket.on("disconnect", () => {
    if (socket.conversationCaptureSession?.liveTranscriber) {
      try {
        socket.conversationCaptureSession.liveTranscriber.close();
      } catch {}
      socket.conversationCaptureSession = null;
    }
  });
}

export default registerConversationSocketHandlers;
