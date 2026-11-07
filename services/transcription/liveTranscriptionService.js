import { createGeminiClient, GEMINI_MODELS } from "../../configs/gemini.js";

/**
 * LiveTranscriptionSession manages a live WebSocket transcription session with gemini-3.5-transcribe-live.
 * Provides real-time speech-to-text, interim and final transcription broadcasts,
 * and seamless 10-minute session rotation.
 */
export class LiveTranscriptionSession {
  constructor({
    sessionId,
    socket,
    organization = null,
    user = null,
    customVocabulary = [],
    languageCodes = ["en-IN", "hi-IN", "te-IN"],
    onTranscriptInterim = null,
    onTranscriptFinal = null,
    onError = null,
  }) {
    this.sessionId = sessionId;
    this.socket = socket;
    this.organization = organization;
    this.user = user;
    this.customVocabulary = customVocabulary;
    this.languageCodes = languageCodes;
    this.onTranscriptInterim = onTranscriptInterim;
    this.onTranscriptFinal = onTranscriptFinal;
    this.onError = onError;

    this.liveModel = GEMINI_MODELS.LIVE_TRANSCRIBE;
    this.ai = null;
    this.liveSession = null;
    this.isActive = false;
    this.isConnecting = false;
    this.pendingChunksQueue = [];
    this.sessionStartTime = null;
    this.rotationTimer = null;
    this.accumulatedLiveTranscript = "";
    this.lastInterimText = "";
  }

  /**
   * Initializes the WebSocket connection to Gemini 3.5 Transcribe Live.
   */
  async start() {
    if (this.isActive || this.isConnecting) return;
    this.isConnecting = true;

    try {
      this.ai = createGeminiClient(this.organization);

      const config = {
        responseModalities: ["TEXT"],
        inputAudioTranscription: {
          languageCodes: this.languageCodes,
          customVocabulary: this.customVocabulary,
        },
      };

      this.sessionStartTime = Date.now();

      this.liveSession = await this.ai.live.connect({
        model: this.liveModel,
        config,
        callbacks: {
          onopen: () => {
            console.log(
              `[LiveTranscription] Connected to ${this.liveModel} for session ${this.sessionId}`,
            );
          },
          onmessage: async (serverMsg) => {
            this.handleServerMessage(serverMsg);
          },
          onerror: (err) => {
            console.error(
              `[LiveTranscription] Error in session ${this.sessionId}:`,
              err?.message || err,
            );
            if (typeof this.onError === "function") this.onError(err);
            this.emitSocket("conversation:error", {
              sessionId: this.sessionId,
              message: err?.message || "Live transcription error",
            });
          },
          onclose: (closeEvt) => {
            console.log(
              `[LiveTranscription] Session closed for ${this.sessionId}`,
            );
            this.isActive = false;
          },
        },
      });

      this.isActive = true;
      this.isConnecting = false;

      // Flush buffered chunks
      if (this.pendingChunksQueue.length > 0) {
        console.log(
          `[LiveTranscription] Flushing ${this.pendingChunksQueue.length} pre-buffered chunks for ${this.sessionId}`,
        );
        while (this.pendingChunksQueue.length > 0) {
          const chunk = this.pendingChunksQueue.shift();
          this.sendAudioChunk(chunk);
        }
      }

      // Schedule controlled session rotation at 9.5 minutes (570,000 ms) before the 10m ceiling
      this.scheduleSessionRotation();

      // NOTE: `conversation:ready` is emitted once by conversationSocket (handleStart).
      // It is intentionally NOT emitted here, because start() is also re-run by
      // rotateSession() mid-recording and must not re-announce readiness to the client.
    } catch (err) {
      this.isConnecting = false;
      this.isActive = false;
      console.error(
        `[LiveTranscription] Failed to start live session for ${this.sessionId}:`,
        err,
      );
      throw err;
    }
  }

  /**
   * Handles incoming WebSocket messages from Gemini Transcribe Live.
   * @param {Object} serverMsg
   */
  handleServerMessage(serverMsg) {
    if (!serverMsg) return;

    if (serverMsg.goAway) {
      console.warn(
        `[LiveTranscription] goAway signal received for ${this.sessionId}. Triggering session rotation.`,
      );
      this.rotateSession();
      return;
    }

    const content = serverMsg.serverContent;
    if (!content) return;

    const rawInterim =
      content.interimInputTranscription || serverMsg.interimInputTranscription;
    const rawFinal = content.inputTranscription || serverMsg.inputTranscription;

    const interimText =
      typeof rawInterim?.text === "string" ? rawInterim.text : null;
    const finalText = typeof rawFinal?.text === "string" ? rawFinal.text : null;

    // 1. Interim Transcription Update
    if (interimText && (!rawInterim?.finished || !finalText)) {
      this.lastInterimText = interimText;
      const payload = {
        sessionId: this.sessionId,
        role: "user",
        text: interimText,
        isFinal: false,
        timestamp: Date.now(),
      };

      if (typeof this.onTranscriptInterim === "function") {
        this.onTranscriptInterim(payload);
      }

      this.emitSocket("conversation:transcript_interim", payload);
    }

    // 2. Final Committed User Speech Segment
    if (finalText) {
      this.lastInterimText = "";
      this.accumulatedLiveTranscript = (
        this.accumulatedLiveTranscript
          ? `${this.accumulatedLiveTranscript} ${finalText.trim()}`
          : finalText.trim()
      ).trim();

      const payload = {
        sessionId: this.sessionId,
        role: "user",
        text: finalText.trim(),
        isFinal: true,
        fullCommitted: this.accumulatedLiveTranscript,
        timestamp: Date.now(),
      };

      if (typeof this.onTranscriptFinal === "function") {
        this.onTranscriptFinal(payload);
      }

      this.emitSocket("conversation:transcript_final", payload);
    }
  }

  /**
   * Streams a 16kHz PCM16 audio chunk (base64 or Buffer) to Gemini Live.
   * @param {string|Buffer} base64OrBufferChunk
   */
  sendAudioChunk(base64OrBufferChunk) {
    if (!base64OrBufferChunk) return;

    const base64Data = Buffer.isBuffer(base64OrBufferChunk)
      ? base64OrBufferChunk.toString("base64")
      : base64OrBufferChunk;

    if (!this.isActive || !this.liveSession) {
      if (this.pendingChunksQueue.length < 200) {
        this.pendingChunksQueue.push(base64Data);
      }
      return;
    }

    try {
      this.liveSession.sendRealtimeInput({
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: base64Data,
        },
      });
    } catch (err) {
      console.warn(
        `[LiveTranscription] Error streaming chunk for ${this.sessionId}:`,
        err.message,
      );
    }
  }

  /**
   * Schedules a session rotation before the 10-minute live boundary.
   */
  scheduleSessionRotation() {
    if (this.rotationTimer) clearTimeout(this.rotationTimer);
    // Rotate after 9.5 minutes (570,000ms)
    this.rotationTimer = setTimeout(() => {
      this.rotateSession();
    }, 570000);
  }

  /**
   * Seamlessly closes current session and reconnects a fresh one.
   */
  async rotateSession() {
    if (!this.isActive) return;
    console.log(
      `[LiveTranscription] Rotating live session for ${this.sessionId} (approaching 10m ceiling)`,
    );

    const oldSession = this.liveSession;
    this.isActive = false;

    try {
      await this.start();
      if (oldSession) {
        try {
          oldSession.close();
        } catch {}
      }
    } catch (err) {
      console.error(
        `[LiveTranscription] Session rotation failed for ${this.sessionId}:`,
        err.message,
      );
    }
  }

  /**
   * Emits an event to the client socket if connected.
   */
  emitSocket(eventName, data) {
    if (this.socket && typeof this.socket.emit === "function") {
      this.socket.emit(eventName, data);
    }
  }

  /**
   * Closes the live transcription session gracefully.
   */
  close() {
    this.isActive = false;
    this.isConnecting = false;
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    this.pendingChunksQueue = [];
    if (this.liveSession) {
      try {
        this.liveSession.close();
      } catch (err) {
        console.warn(
          `[LiveTranscription] Error closing session for ${this.sessionId}:`,
          err.message,
        );
      }
      this.liveSession = null;
    }
  }
}

export default LiveTranscriptionSession;
