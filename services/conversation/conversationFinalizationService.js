import audioBufferService from "../audio/audioBufferService.js";
import { transcribeWithDiarization } from "../transcription/finalTranscriptionService.js";
import { reconcileDiarization } from "../transcription/diarizationService.js";
import { extractSpeakerAwareContact } from "../ai/contactExtractionService.js";
import { generateConversationSummary } from "../ai/conversationSummaryService.js";
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

      // Step 2: Model 2 - Gemini 3.5 Transcribe with Speaker Diarization
      this.emitProgress(socket, sessionId, "diarizing", 40);
      let diarizationRaw = { segments: [], fullTranscript: liveTranscript };

      if (audioResult.pcmBuffer && audioResult.pcmBuffer.length > 0) {
        try {
          diarizationRaw = await transcribeWithDiarization({
            pcmBuffer: audioResult.pcmBuffer,
            organization,
          });
        } catch (transcribeErr) {
          console.warn(
            `[FinalizationService] Gemini 3.5 Transcribe failed for ${sessionId}: ${transcribeErr.message}. Falling back to live transcript.`,
          );
        }
      }

      // Step 3: Reconcile speaker segments
      const { segments, speakers } = reconcileDiarization({
        diarizedSegments: diarizationRaw.segments,
        liveTranscript: diarizationRaw.fullTranscript || liveTranscript,
      });

      // Step 4: Model 3 - Gemini Flash Speaker-Aware Contact Extraction
      this.emitProgress(socket, sessionId, "extracting_contact", 70);
      let extractionResult;
      try {
        extractionResult = await extractSpeakerAwareContact({
          segments,
          rawTranscript: diarizationRaw.fullTranscript || liveTranscript,
          hostUser: user,
          organization,
        });
      } catch (extractErr) {
        console.error(
          `[FinalizationService] Contact extraction error for ${sessionId}:`,
          extractErr.message,
        );
        extractionResult = {
          selectedSpeakerId: null,
          identityStatus: "uncertain",
          selectionReason: "Contact extraction failed",
          requiresManualReview: true,
          isComplete: false,
          contact: {
            name: {
              value: null,
              speakerId: null,
              evidence: null,
              confidence: 0,
            },
            company: {
              value: null,
              speakerId: null,
              evidence: null,
              confidence: 0,
            },
            designation: {
              value: null,
              speakerId: null,
              evidence: null,
              confidence: 0,
            },
            phone: {
              value: null,
              speakerId: null,
              evidence: null,
              confidence: 0,
            },
          },
          otherSpeakers: [],
        };
      }

      // Step 5: Model 3 - Gemini Flash Conversation Summarization
      this.emitProgress(socket, sessionId, "summarizing", 85);
      let summaryResult;
      try {
        summaryResult = await generateConversationSummary({
          segments,
          rawTranscript: diarizationRaw.fullTranscript || liveTranscript,
          contact: extractionResult.contact,
          organization,
          isInterim: false,
        });
      } catch (sumErr) {
        console.warn(
          `[FinalizationService] Summary generation warning for ${sessionId}:`,
          sumErr.message,
        );
        summaryResult = {
          keyDiscussion:
            liveTranscript.slice(0, 150) || "Conversation captured.",
          topics: [],
          actionItems: [],
          decisions: [],
          participants: [],
        };
      }

      // Step 6: Compute Usage Metrics & Estimated Cost
      const finalDurationSec = audioDuration;
      const liveDuration = liveDurationSec || finalDurationSec;
      const liveCost = (liveDuration / 60) * 0.003;
      const diarizationCost = (finalDurationSec / 60) * 0.002;
      const flashCost = 0.0005;
      const estimatedCostUsd = Number(
        (liveCost + diarizationCost + flashCost).toFixed(5),
      );

      const usageMetrics = {
        liveDurationSec: liveDuration,
        finalDiarizationDurationSec: finalDurationSec,
        modelCallsCount: 3,
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
          originalTranscript: diarizationRaw.fullTranscript || liveTranscript,
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
            liveModel: GEMINI_MODELS.LIVE_TRANSCRIBE,
            finalModel: GEMINI_MODELS.FINAL_TRANSCRIBE,
            extractionModel: GEMINI_MODELS.EXTRACTION_SUMMARY,
          },
          usageMetrics,
        };

        if (typeof Conversation?.findOneAndUpdate === "function") {
          savedConversation = await Conversation.findOneAndUpdate(
            { sessionId },
            { $set: updateData },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );
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
        phone: extractionResult.contact?.phone?.value || null,
        companyName: extractionResult.contact?.company?.value || null,
        designation: extractionResult.contact?.designation?.value || null,
        discussionSummary: finalSummaryText,
        rawTranscript: diarizationRaw.fullTranscript || liveTranscript,
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
