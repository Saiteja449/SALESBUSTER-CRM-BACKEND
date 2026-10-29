/**
 * Correlated Voice Telemetry & Timing Logger
 * Instruments session startup, turn processing, tool latency, and audio delivery
 * without exposing sensitive CRM data or audio payloads.
 */

export class VoiceTelemetry {
  constructor({ sessionId, socketId, orgId, userId, provider = "gemini" }) {
    this.sessionId = sessionId || `vses_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.socketId = socketId;
    this.orgId = orgId;
    this.userId = userId;
    this.provider = provider;
    this.sessionStartTime = Date.now();
    this.activeTurns = new Map();
  }

  logEvent(event, details = {}) {
    const timestamp = Date.now();
    const elapsedSinceSessionStart = timestamp - this.sessionStartTime;

    // Filter out any potential sensitive payload fields
    const safeDetails = { ...details };
    delete safeDetails.data;
    delete safeDetails.audio;
    delete safeDetails.base64;
    delete safeDetails.args;
    delete safeDetails.result;
    delete safeDetails.password;
    delete safeDetails.apiKey;

    const logEntry = {
      tag: "VOICE_TELEMETRY",
      event,
      sessionId: this.sessionId,
      provider: this.provider,
      elapsedMs: elapsedSinceSessionStart,
      ...safeDetails,
    };

    console.log(JSON.stringify(logEntry));
    return logEntry;
  }

  startTurn(turnId = `turn_${Date.now()}`) {
    const turnData = {
      turnId,
      startTime: Date.now(),
      firstResponseTime: null,
      firstAudioTime: null,
      tools: [],
    };
    this.activeTurns.set(turnId, turnData);
    this.logEvent("turn_start", { turnId });
    return turnId;
  }

  recordFirstProviderResponse(turnId) {
    const turn = this.activeTurns.get(turnId);
    if (turn && !turn.firstResponseTime) {
      turn.firstResponseTime = Date.now();
      const latencyMs = turn.firstResponseTime - turn.startTime;
      this.logEvent("first_provider_response", { turnId, latencyMs });
      return latencyMs;
    }
    return null;
  }

  recordFirstAudio(turnId) {
    const turn = this.activeTurns.get(turnId);
    if (turn && !turn.firstAudioTime) {
      turn.firstAudioTime = Date.now();
      const latencyMs = turn.firstAudioTime - turn.startTime;
      this.logEvent("first_audio_sent", { turnId, latencyMs });
      return latencyMs;
    }
    return null;
  }

  recordToolExecution({ turnId, toolName, toolCallId, durationMs, ok, concurrent = false }) {
    const turn = this.activeTurns.get(turnId);
    if (turn) {
      turn.tools.push({ toolName, durationMs, ok });
    }
    this.logEvent("tool_execution", {
      turnId,
      toolName,
      toolCallId,
      durationMs,
      ok,
      concurrent,
    });
  }

  endTurn(turnId) {
    const turn = this.activeTurns.get(turnId);
    if (turn) {
      const totalDurationMs = Date.now() - turn.startTime;
      this.logEvent("turn_complete", {
        turnId,
        totalDurationMs,
        toolCount: turn.tools.length,
      });
      this.activeTurns.delete(turnId);
      return totalDurationMs;
    }
    return null;
  }
}

