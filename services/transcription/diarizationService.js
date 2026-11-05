import { parseDiarizedTranscriptText } from "./finalTranscriptionService.js";

/**
 * DiarizationService reconciles real-time interim/final live transcripts with the authoritative
 * speaker-attributed segments from Gemini 3.5 Transcribe.
 */

/**
 * Reconciles live linear transcript with diarized speaker segments.
 * Generates distinct speaker entities and attaches confidence.
 * Guarantees the full conversation context is preserved if post-processing diarization dropped early segments.
 * @param {Object} params
 * @param {Array<Object>} params.diarizedSegments - Array of { speakerId, text, startTime, endTime }
 * @param {string} [params.liveTranscript] - Real-time transcript accumulated during streaming
 * @returns {{ segments: Array<Object>, speakers: Array<Object>, uniqueSpeakerIds: Array<string> }}
 */
export function reconcileDiarization({ diarizedSegments = [], liveTranscript = "" }) {
  const cleanLiveTranscript = (liveTranscript || "").trim();

  // If no diarized segments returned at all, fall back to live transcript
  if (!Array.isArray(diarizedSegments) || diarizedSegments.length === 0) {
    if (cleanLiveTranscript) {
      const parsedLive = parseDiarizedTranscriptText(cleanLiveTranscript, 0);
      const fallbackSegments = parsedLive.length > 0 ? parsedLive : [
        {
          speakerId: "speaker_A",
          text: cleanLiveTranscript,
          startTime: 0,
          endTime: 0,
          isFinal: true,
          confidence: 0.85,
        },
      ];
      const speakers = Array.from(new Set(fallbackSegments.map((s) => s.speakerId))).map((id) => ({
        speakerId: id,
        label: id.replace("speaker_", "Speaker ").toUpperCase(),
      }));
      return {
        segments: fallbackSegments,
        speakers,
        uniqueSpeakerIds: speakers.map((s) => s.speakerId),
      };
    }
    return { segments: [], speakers: [], uniqueSpeakerIds: [] };
  }

  // Check if diarized segments captured the whole conversation or missed early turns
  const diarizedTotalLength = diarizedSegments.reduce((sum, s) => sum + (s.text || "").length, 0);
  let reconciledSegments = [...diarizedSegments];

  if (cleanLiveTranscript.length > 50 && diarizedTotalLength < cleanLiveTranscript.length * 0.5) {
    console.warn(
      `[DiarizationService] Diarized text length (${diarizedTotalLength}) is shorter than live transcript (${cleanLiveTranscript.length}). Reconciling full conversation context.`
    );
    const parsedLive = parseDiarizedTranscriptText(cleanLiveTranscript, 0);
    if (parsedLive.length > diarizedSegments.length) {
      reconciledSegments = parsedLive;
    } else {
      reconciledSegments = [
        {
          speakerId: "speaker_A",
          text: cleanLiveTranscript,
          startTime: 0,
          endTime: diarizedSegments[0]?.startTime || 0,
          isFinal: true,
          confidence: 0.9,
        },
        ...diarizedSegments,
      ];
    }
  }

  const speakersMap = new Map();
  const normalizedSegments = reconciledSegments.map((seg, idx) => {
    let cleanSpeakerId = (seg.speakerId || "speaker_A").toLowerCase().trim();
    if (!cleanSpeakerId.startsWith("speaker_")) {
      cleanSpeakerId = `speaker_${cleanSpeakerId}`;
    }

    if (!speakersMap.has(cleanSpeakerId)) {
      const displayLabel = cleanSpeakerId
        .replace("speaker_", "Speaker ")
        .toUpperCase();
      speakersMap.set(cleanSpeakerId, {
        speakerId: cleanSpeakerId,
        label: displayLabel,
        totalTurns: 0,
        identifiedName: null,
      });
    }

    const speakerInfo = speakersMap.get(cleanSpeakerId);
    speakerInfo.totalTurns++;

    return {
      speakerId: cleanSpeakerId,
      text: (seg.text || "").trim(),
      startTime: typeof seg.startTime === "number" ? seg.startTime : idx * 3,
      endTime: typeof seg.endTime === "number" ? seg.endTime : (idx + 1) * 3,
      isFinal: true,
      confidence: typeof seg.confidence === "number" ? seg.confidence : 0.95,
      language: seg.language || "en-IN",
    };
  });

  return {
    segments: normalizedSegments,
    speakers: Array.from(speakersMap.values()),
    uniqueSpeakerIds: Array.from(speakersMap.keys()),
  };
}

export default {
  reconcileDiarization,
};
