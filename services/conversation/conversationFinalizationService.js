import audioBufferService from "../audio/audioBufferService.js";
import Conversation from "../../models/Conversation.js";
import { GEMINI_MODELS } from "../../configs/gemini.js";

/**
 * ConversationFinalizationService orchestrates post-recording audio finalization,
 * diarization, speaker-aware contact extraction, summarization, and database persistence.
 * Implements strict idempotency locks and completed cache to avoid duplicate processing.
 */
class ConversationFinalizationService {
  constructor() {
    this.inFlightFinalizations = new Map();
    this.completedFinalizations = new Map();
    this.RETENTION_MS = 15 * 60 * 1000; // 15 minutes retention
  }

  /**
   * Prunes cached completed sessions older than retention period.
   */
  pruneCache() {
    const now = Date.now();
    for (const [sId, item] of this.completedFinalizations.entries()) {
      if (now - item.completedAt > this.RETENTION_MS) {
        this.completedFinalizations.delete(sId);
      }
    }
  }

  /**
   * Finalizes a conversation capture session.
   * Idempotent: returns existing Promise if in flight, or cached result if already completed.
   * @param {Object} params
   * @param {string} params.sessionId
   * @param {Object} [params.socket] - Client socket connection
   * @param {Object} [params.organization]
   * @param {Object} [params.user]
   * @param {string} [params.eventId]
   * @param {string} [params.liveTranscript]
   * @param {number} [params.liveDurationSec]
   * @returns {Promise<Object>} Finalized conversation result
   */
  async finalizeConversation({
    sessionId,
    socket = null,
    organization = null,
    user = null,
    eventId = null,
    liveTranscript = "",
    liveCaptureData = {},
    liveDurationSec = 0,
  }) {
    if (!sessionId) throw new Error("sessionId is required for finalization");

    this.pruneCache();

    // 1. Check in-memory completed cache
    if (this.completedFinalizations.has(sessionId)) {
      console.log(
        `[FinalizationService] Returning cached finalization result for session ${sessionId}`,
      );
      const cached = this.completedFinalizations.get(sessionId).result;
      if (socket) {
        socket.emit("conversation:completed", cached);
      }
      return cached;
    }

    // 2. Check in-flight finalization promise
    if (this.inFlightFinalizations.has(sessionId)) {
      console.log(
        `[FinalizationService] Session ${sessionId} finalization already in flight. Returning active promise.`,
      );
      return this.inFlightFinalizations.get(sessionId);
    }

    // 3. Check MongoDB for completed session (e.g. after server restart or distributed request)
    try {
      if (typeof Conversation?.findOne === "function") {
        const existingDoc = await Conversation.findOne({
          sessionId,
          processingStatus: "completed",
        }).lean();

        if (existingDoc) {
          console.log(
            `[FinalizationService] Session ${sessionId} already completed in DB. Returning reconstructed result.`,
          );
          const reconstructed = {
            sessionId: existingDoc.sessionId,
            conversationId: existingDoc._id?.toString() || null,
            durationSeconds: existingDoc.duration || 0,
            selectedSpeakerId: existingDoc.selectedSpeakerId || null,
            identityStatus: existingDoc.identityStatus || "provisional",
            selectionReason: existingDoc.selectionReason || null,
            requiresManualReview: Boolean(existingDoc.requiresManualReview),
            contact: existingDoc.extractedContact || {},
            detailedSummary: existingDoc.summary?.keyDiscussion || "",
            summary: existingDoc.summary || {},
            transcriptSegments: existingDoc.transcriptSegments || [],
            speakers: existingDoc.speakers || [],
            usageMetrics: existingDoc.usageMetrics || {},
            status: "completed",
            isComplete: Boolean(
              existingDoc.extractedContact?.name?.value &&
              existingDoc.extractedContact?.phone?.value &&
              existingDoc.extractedContact?.company?.value &&
              !existingDoc.requiresManualReview,
            ),
            name: existingDoc.extractedContact?.name?.value || null,
            phone: existingDoc.extractedContact?.phone?.value || null,
            companyName: existingDoc.extractedContact?.company?.value || null,
            designation:
              existingDoc.extractedContact?.designation?.value || null,
            discussionSummary: existingDoc.summary?.keyDiscussion || "",
            rawTranscript: existingDoc.originalTranscript || "",
          };

          this.completedFinalizations.set(sessionId, {
            result: reconstructed,
            completedAt: Date.now(),
          });

          if (socket) {
            socket.emit("conversation:completed", reconstructed);
          }
          return reconstructed;
        }
      }
    } catch (checkErr) {
      console.warn(
        `[FinalizationService] Warning checking existing session ${sessionId}:`,
        checkErr.message,
      );
    }

    // 4. Create new finalization promise
    const finalizationPromise = (async () => {
      console.log(
        `[FinalizationService] Starting authoritative finalization for session: ${sessionId}`,
      );

      this.emitProgress(socket, sessionId, "finalizing_audio", 15);

      // Step 1: Finalize raw audio buffer from audioBufferService
      let audioResult;
      try {
        audioResult = await audioBufferService.finalizeSession(sessionId);
      } catch (err) {
        console.warn(
          `[FinalizationService] Audio buffer finalization warning for ${sessionId}:`,
          err.message,
        );
        audioResult = {
          pcmBuffer: Buffer.alloc(0),
          durationSec: 0,
          filePath: null,
          totalChunks: 0,
        };
      }

      const audioDuration = audioResult.durationSec || liveDurationSec || 0;

      // Gemini Live is the only model in conversational detail capture.
      this.emitProgress(socket, sessionId, "diarizing", 40);
      const transcript = String(liveTranscript || "").trim();
      const segments = transcript ? [{ speakerId: "unknown", text: transcript }] : [];
      const speakers = [];

      // Fields and summary are emitted progressively by Gemini Live during capture.
      this.emitProgress(socket, sessionId, "extracting_contact", 70);
      const asField = (value) => ({ value: value || null, speakerId: null, evidence: null, confidence: value ? 0.9 : 0 });
      const extractionResult = {
        selectedSpeakerId: null,
        identityStatus: liveCaptureData?.name ? "identified" : "provisional",
        selectionReason: "Captured progressively by Gemini Live",
        requiresManualReview: !liveCaptureData?.isComplete,
        isComplete: Boolean(liveCaptureData?.isComplete),
        contact: {
          name: asField(liveCaptureData?.name),
          phone: asField(liveCaptureData?.phone),
          company: asField(liveCaptureData?.companyName),
          designation: asField(liveCaptureData?.designation),
          summary: asField(liveCaptureData?.summary),
        },
      };

      this.emitProgress(socket, sessionId, "summarizing", 85);
      const summaryResult = { keyDiscussion: liveCaptureData?.summary || "", topics: [], actionItems: [], decisions: [], participants: [] };

      // Step 6: Compute Usage Metrics & Estimated Cost
      const finalDurationSec = audioDuration;
      const liveDuration = liveDurationSec || finalDurationSec;
      const liveCost = (liveDuration / 60) * 0.003;
      const estimatedCostUsd = Number(
        liveCost.toFixed(5),
      );

      const usageMetrics = {
        liveDurationSec: liveDuration,
        finalDiarizationDurationSec: 0,
        modelCallsCount: 1,
        estimatedCostUsd,
      };

      // Step 7: Database Persistence (Upsert Conversation Record)
      let savedConversation = null;
      try {
        const updateData = {
          userId: user?.id || user?._id,
          organizationId: organization?._id || user?.organizationId,
          eventId: eventId || null,
          sessionId,
          endedAt: new Date(),
          duration: Math.round(audioDuration),
          originalTranscript: transcript,
          transcriptSegments: segments,
          speakers,
          selectedSpeakerId: extractionResult.selectedSpeakerId,
          identityStatus: extractionResult.identityStatus || "provisional",
          selectionReason: extractionResult.selectionReason || null,
          requiresManualReview: Boolean(extractionResult.requiresManualReview),
          extractedContact: {
            name: extractionResult.contact.name,
            phone: extractionResult.contact.phone,
            company: extractionResult.contact.company,
            designation: extractionResult.contact.designation,
            confirmationStatus: extractionResult.isComplete
              ? "confirmed"
              : "provisional",
          },
          summary: summaryResult,
          languages: ["en-IN", "hi-IN", "te-IN"],
          processingStatus: "completed",
          aiProvider: "gemini",
          modelMetadata: {
            liveModel: GEMINI_MODELS.LIVE_CAPTURE,
          },
          usageMetrics,
        };

        if (typeof Conversation?.findOneAndUpdate === "function") {
          const persist = () => Conversation.findOneAndUpdate(
            { sessionId },
            { $set: updateData },
            { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
          );
          try {
            savedConversation = await persist();
          } catch (indexErr) {
            const isLegacyNullLeadIndex = indexErr?.code === 11000 &&
              String(indexErr?.message || "").includes("leadId_1") &&
              String(indexErr?.message || "").includes("null");
            if (!isLegacyNullLeadIndex || !Conversation.collection?.dropIndex) throw indexErr;

            console.warn("[FinalizationService] Replacing stale unique leadId_1 index with the non-unique index declared by Conversation schema.");
            await Conversation.collection.dropIndex("leadId_1");
            await Conversation.collection.createIndex({ leadId: 1 }, { name: "leadId_1", sparse: true });
            savedConversation = await persist();
          }
        }
      } catch (dbErr) {
        console.error(
          `[FinalizationService] DB save error for session ${sessionId}:`,
          dbErr.message,
        );
      }

      const finalSummaryText =
        extractionResult.detailedSummary || summaryResult?.keyDiscussion || "";

      const completedPayload = {
        sessionId,
        conversationId: savedConversation?._id?.toString() || null,
        durationSeconds: Math.round(audioDuration),
        selectedSpeakerId: extractionResult.selectedSpeakerId,
        identityStatus: extractionResult.identityStatus || "provisional",
        selectionReason: extractionResult.selectionReason || null,
        requiresManualReview: Boolean(extractionResult.requiresManualReview),
        isComplete: Boolean(extractionResult.isComplete),
        contact: extractionResult.contact,
        detailedSummary: finalSummaryText,
        summary: summaryResult,
        transcriptSegments: segments,
        speakers,
        usageMetrics,
        status: "completed",
        // Direct top-level accessors for instant field auto-fill on mobile
        name: extractionResult.contact?.name?.value || null,
        nameEvidence: liveCaptureData?.nameEvidence || "",
        phone: extractionResult.contact?.phone?.value || null,
        companyName: extractionResult.contact?.company?.value || null,
        designation: extractionResult.contact?.designation?.value || null,
        discussionSummary: finalSummaryText,
        rawTranscript: transcript,
      };

      // Step 8: Emit Completion to Client Socket
      if (socket) {
        socket.emit("conversation:completed", completedPayload);
      }

      // Store in completed finalizations cache for retention period
      this.completedFinalizations.set(sessionId, {
        result: completedPayload,
        completedAt: Date.now(),
      });

      console.log(
        `[FinalizationService] Successfully completed authoritative finalization for ${sessionId}`,
      );
      return completedPayload;
    })();

    this.inFlightFinalizations.set(sessionId, finalizationPromise);

    try {
      const result = await finalizationPromise;
      return result;
    } finally {
      this.inFlightFinalizations.delete(sessionId);
    }
  }

  emitProgress(socket, sessionId, step, progressPercent) {
    if (socket && typeof socket.emit === "function") {
      socket.emit("conversation:processing", {
        sessionId,
        step,
        progressPercent,
      });
    }
  }
}

export const conversationFinalizationService =
  new ConversationFinalizationService();
export default conversationFinalizationService;
