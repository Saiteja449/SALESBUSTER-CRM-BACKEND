/**
 * DiarizationService reconciles real-time interim/final live transcripts with the authoritative
 * speaker-attributed segments from Gemini 3.5 Transcribe.
 */

/**
 * Reconciles live linear transcript with diarized speaker segments.
 * Generates distinct speaker entities and attaches confidence.
 * @param {Object} params
 * @param {Array<Object>} params.diarizedSegments - Array of { speakerId, text, startTime, endTime }
 * @param {string} [params.liveTranscript] - Real-time transcript accumulated during streaming
 * @returns {{ segments: Array<Object>, speakers: Array<Object>, uniqueSpeakerIds: Array<string> }}
 */
export function reconcileDiarization({ diarizedSegments = [], liveTranscript = "" }) {
  if (!Array.isArray(diarizedSegments) || diarizedSegments.length === 0) {
    if (liveTranscript.trim()) {
      const fallbackSegment = {
        speakerId: "speaker_A",
        text: liveTranscript.trim(),
        startTime: 0,
        endTime: 0,
        isFinal: true,
        confidence: 0.85,
      };
      return {
        segments: [fallbackSegment],
        speakers: [{ speakerId: "speaker_A", label: "Speaker A" }],
        uniqueSpeakerIds: ["speaker_A"],
      };
    }
    return { segments: [], speakers: [], uniqueSpeakerIds: [] };
  }

  const speakersMap = new Map();
  const normalizedSegments = diarizedSegments.map((seg, idx) => {
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

