import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  pcmToWav,
  calculatePcmDuration,
  validatePcmChunk,
} from "../../utils/audioUtils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_STORAGE_PATH = path.resolve(__dirname, "../../uploads/voice");

/**
 * AudioBufferService manages in-memory and disk buffering for real-time PCM audio streaming.
 * Handles sequence tracking, deduplication, out-of-order chunks, and clean WAV assembly.
 */
class AudioBufferService {
  constructor() {
    this.sessions = new Map();
    this.storageDir = process.env.AUDIO_STORAGE_PATH
      ? path.resolve(process.env.AUDIO_STORAGE_PATH)
      : DEFAULT_STORAGE_PATH;

    if (!fs.existsSync(this.storageDir)) {
      try {
        fs.mkdirSync(this.storageDir, { recursive: true });
      } catch (err) {
        console.warn("[AudioBufferService] Failed to create storage dir:", err.message);
      }
    }
  }

  /**
   * Initializes a new audio buffering session.
   * @param {Object} params
   * @param {string} params.sessionId - Unique session identifier
   * @param {string} [params.userId]
   * @param {string} [params.organizationId]
   */
  startSession({ sessionId, userId, organizationId }) {
    if (!sessionId) throw new Error("sessionId is required");

    // Close any previous stale session state
    if (this.sessions.has(sessionId)) {
      this.cleanupSession(sessionId);
    }

    const pcmFilePath = path.join(this.storageDir, `session_${sessionId}.pcm`);
    const wavFilePath = path.join(this.storageDir, `session_${sessionId}.wav`);

    // Create write stream for raw PCM
    const fileStream = fs.createWriteStream(pcmFilePath, { flags: "w" });

    const sessionData = {
      sessionId,
      userId,
      organizationId,
      startedAt: Date.now(),
      endedAt: null,
      pcmFilePath,
      wavFilePath,
      fileStream,
      chunksBySeq: new Map(),
      receivedSequences: new Set(),
      highestSeq: -1,
      totalBytes: 0,
      totalChunksReceived: 0,
      duplicateCount: 0,
      outOfOrderCount: 0,
      isFinalized: false,
    };

    this.sessions.set(sessionId, sessionData);
    return sessionData;
  }

  /**
   * Ingests an incoming audio chunk with sequence verification.
   * @param {Object} params
   * @param {string} params.sessionId
   * @param {number} [params.sequenceNumber]
   * @param {number} [params.timestamp]
   * @param {string|Buffer} params.data - Base64 PCM or Buffer
   * @returns {{ accepted: boolean, sequenceNumber: number, totalBytes: number, error?: string }}
   */
  pushChunk({ sessionId, sequenceNumber, timestamp, data }) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { accepted: false, error: "Session not found or already closed" };
    }

    if (session.isFinalized) {
      return { accepted: false, error: "Session is already finalized" };
    }

    const { valid, buffer, error } = validatePcmChunk(data);
    if (!valid || !buffer) {
      return { accepted: false, error: error || "Invalid PCM chunk" };
    }

    // Default sequence number if not passed (auto-increment)
    const seq =
      typeof sequenceNumber === "number" && !isNaN(sequenceNumber)
        ? sequenceNumber
        : session.highestSeq + 1;

    // Deduplication check
    if (session.receivedSequences.has(seq)) {
      session.duplicateCount++;
      return {
        accepted: false,
        duplicate: true,
        sequenceNumber: seq,
        totalBytes: session.totalBytes,
      };
    }

    // Out-of-order check
    if (seq < session.highestSeq) {
      session.outOfOrderCount++;
    } else {
      session.highestSeq = seq;
    }

    session.receivedSequences.add(seq);
    session.chunksBySeq.set(seq, buffer);
    session.totalBytes += buffer.length;
    session.totalChunksReceived++;

    // Write to disk stream
    if (session.fileStream && !session.fileStream.destroyed) {
      session.fileStream.write(buffer);
    }

    return {
      accepted: true,
      sequenceNumber: seq,
      totalBytes: session.totalBytes,
      chunkBytes: buffer.length,
    };
  }

  /**
   * Finalizes the audio session, writes the complete RIFF WAV file, and returns the assembled audio buffer.
   * @param {string} sessionId
   * @returns {Promise<{ wavBuffer: Buffer, pcmBuffer: Buffer, filePath: string, durationSec: number, totalChunks: number }>}
   */
  async finalizeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Check if WAV already exists on disk
      const wavPath = path.join(this.storageDir, `session_${sessionId}.wav`);
      if (fs.existsSync(wavPath)) {
        const wavBuffer = fs.readFileSync(wavPath);
        const pcmBuffer = wavBuffer.subarray(44);
        return {
          wavBuffer,
          pcmBuffer,
          filePath: wavPath,
          durationSec: calculatePcmDuration(pcmBuffer.length),
          totalChunks: 0,
        };
      }
      throw new Error(`Audio session ${sessionId} not found`);
    }

    if (session.isFinalized && fs.existsSync(session.wavFilePath)) {
      const wavBuffer = fs.readFileSync(session.wavFilePath);
      const pcmBuffer = wavBuffer.subarray(44);
      return {
        wavBuffer,
        pcmBuffer,
        filePath: session.wavFilePath,
        durationSec: calculatePcmDuration(pcmBuffer.length),
        totalChunks: session.totalChunksReceived,
      };
    }

    session.isFinalized = true;
    session.endedAt = Date.now();

    // Close the raw PCM file write stream
    await new Promise((resolve) => {
      if (session.fileStream && !session.fileStream.destroyed) {
        session.fileStream.end(resolve);
      } else {
        resolve();
      }
    });

    // Assemble PCM chunks in strict sequential order
    const sortedSeqs = Array.from(session.chunksBySeq.keys()).sort((a, b) => a - b);
    const sortedBuffers = sortedSeqs.map((s) => session.chunksBySeq.get(s));
    const fullPcmBuffer = Buffer.concat(sortedBuffers);

    // Create RIFF WAV with 44-byte header
    const wavBuffer = pcmToWav(fullPcmBuffer, 16000, 1, 16);
    fs.writeFileSync(session.wavFilePath, wavBuffer);

    const durationSec = calculatePcmDuration(fullPcmBuffer.length, 16000);

    return {
      wavBuffer,
      pcmBuffer: fullPcmBuffer,
      filePath: session.wavFilePath,
      durationSec,
      totalChunks: session.totalChunksReceived,
      outOfOrderCount: session.outOfOrderCount,
      duplicateCount: session.duplicateCount,
    };
  }

  /**
   * Retrieves an active session data object without finalization.
   * @param {string} sessionId
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Cleans up in-memory buffers and temporary disk files.
   * @param {string} sessionId
   * @param {boolean} [deleteFiles=false] - Whether to delete disk recordings
   */
  cleanupSession(sessionId, deleteFiles = false) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.fileStream && !session.fileStream.destroyed) {
        session.fileStream.destroy();
      }
      session.chunksBySeq.clear();
      session.receivedSequences.clear();

      if (deleteFiles) {
        try {
          if (fs.existsSync(session.pcmFilePath)) fs.unlinkSync(session.pcmFilePath);
          if (fs.existsSync(session.wavFilePath)) fs.unlinkSync(session.wavFilePath);
        } catch (e) {
          console.warn("[AudioBufferService] Error deleting temp audio files:", e.message);
        }
      }

      this.sessions.delete(sessionId);
    }
  }
}

export const audioBufferService = new AudioBufferService();
export default audioBufferService;

