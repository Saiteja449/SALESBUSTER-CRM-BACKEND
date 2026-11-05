import { createGeminiClient, GEMINI_MODELS } from "../../configs/gemini.js";
import { pcmToWav, segmentPcmBuffer, calculatePcmDuration } from "../../utils/audioUtils.js";

/**
 * Normalizes raw model output text into structured Speaker-Attributed segments.
 * Handles speaker prefixes (e.g., "Speaker A:", "[Speaker 1]:", "Rahul:") and timestamps.
 * @param {string} rawText
 * @param {number} baseOffsetSec
 * @returns {Array<{ speakerId: string, text: string, startTime: number, endTime: number, isFinal: boolean }>}
 */
export function parseDiarizedTranscriptText(rawText = "", baseOffsetSec = 0) {
  if (!rawText || !rawText.trim()) return [];

  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const segments = [];
  let currentSpeaker = "speaker_A";
  let currentText = "";
  let segmentStartTime = baseOffsetSec;

  const speakerRegex = /^(?:\[?(Speaker\s*[A-Za-z0-9]+|\bSpeaker\b|\bPerson\s*[0-9]+)\]?|\b([A-Za-z]+)\s*\([^)]*\))[:\-]\s*(.*)$/i;
  const timestampRegex = /\[?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(?:-|-->|to)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\]?/i;

  const parseTimestampSec = (tsStr) => {
    if (!tsStr) return 0;
    const parts = tsStr.split(":").map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  };

  for (const line of lines) {
    const tsMatch = line.match(timestampRegex);
    let lineWithoutTs = line;
    let lineStart = segmentStartTime;
    let lineEnd = segmentStartTime + 5;

    if (tsMatch) {
      lineStart = baseOffsetSec + parseTimestampSec(tsMatch[1]);
      lineEnd = baseOffsetSec + parseTimestampSec(tsMatch[2]);
      lineWithoutTs = line.replace(tsMatch[0], "").trim();
    }

    const speakerMatch = lineWithoutTs.match(speakerRegex);
    if (speakerMatch) {
      if (currentText.trim()) {
        segments.push({
          speakerId: currentSpeaker,
          text: currentText.trim(),
          startTime: segmentStartTime,
          endTime: lineStart,
          isFinal: true,
        });
      }
      const rawSpeakerName = (speakerMatch[1] || speakerMatch[2] || "Speaker A").trim();
      currentSpeaker = rawSpeakerName.toLowerCase().replace(/\s+/g, "_");
      if (!currentSpeaker.startsWith("speaker_")) {
        currentSpeaker = `speaker_${currentSpeaker}`;
      }
      currentText = speakerMatch[3] || "";
      segmentStartTime = lineStart;
    } else {
      currentText = currentText ? `${currentText} ${lineWithoutTs}` : lineWithoutTs;
    }
  }

  if (currentText.trim()) {
    segments.push({
      speakerId: currentSpeaker,
      text: currentText.trim(),
      startTime: segmentStartTime,
      endTime: segmentStartTime + 5,
      isFinal: true,
    });
  }

  return segments;
}

/**
 * Transcribes complete recorded audio with verbatim speaker diarization using gemini-3.5-transcribe.
 * @param {Object} options
 * @param {Buffer} options.pcmBuffer - Complete recorded 16kHz PCM16 audio
 * @param {Object} [options.organization] - Tenant organization document
 * @param {Array<string>} [options.languageCodes] - Language hints (default en-IN, hi-IN, te-IN)
 * @param {Array<string>} [options.customVocabulary]
 * @returns {Promise<{ segments: Array<Object>, fullTranscript: string, rawResponse: Object, durationSec: number }>}
 */
export async function transcribeWithDiarization({
  pcmBuffer,
  organization = null,
  languageCodes = ["en-IN", "hi-IN", "te-IN"],
  customVocabulary = [],
}) {
  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) {
    throw new Error("Invalid or empty audio buffer provided for diarization.");
  }

  const ai = createGeminiClient(organization);
  const modelName = GEMINI_MODELS.FINAL_TRANSCRIBE;
  const totalDurationSec = calculatePcmDuration(pcmBuffer.length, 16000);

  // If audio is under 25 minutes, process in a single request.
  // If audio approaches/exceeds 25 minutes (1500 seconds), segment safely.
  const audioSegments = segmentPcmBuffer(pcmBuffer, 1500, 16000);
  const allTranscriptSegments = [];
  const fullTranscriptParts = [];

  for (const seg of audioSegments) {
    const wavBuffer = pcmToWav(seg.pcmBuffer, 16000, 1, 16);
    const base64Audio = wavBuffer.toString("base64");

    const promptText =
      "Please provide an accurate, verbatim transcript of this conversation with speaker diarization. " +
      "Identify distinct speakers as Speaker A, Speaker B, Speaker C, etc. " +
      "Prefix every spoken turn with the speaker identifier (e.g. 'Speaker A: ...', 'Speaker B: ...') and include timestamps.";

    const response = await ai.models.generateContent({
      model: modelName,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "audio/wav",
                data: base64Audio,
              },
            },
            {
              text: promptText,
            },
          ],
        },
      ],
      config: {
        transcriptionConfig: {
          diarizationMode: "speaker",
          languageCodes,
          customVocabulary: customVocabulary.length > 0 ? customVocabulary : undefined,
          timestampGranularities: ["word"],
        },
      },
    });

    const candidateText =
      response.text ||
      response.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") ||
      "";

    fullTranscriptParts.push(candidateText);

    const parsedSegments = parseDiarizedTranscriptText(
      candidateText,
      seg.startTimeSec
    );

    // If parsing found no speaker markers, assign default speaker_A
    if (parsedSegments.length === 0 && candidateText.trim()) {
      parsedSegments.push({
        speakerId: "speaker_A",
        text: candidateText.trim(),
        startTime: seg.startTimeSec,
        endTime: seg.startTimeSec + seg.durationSec,
        isFinal: true,
      });
    }

    allTranscriptSegments.push(...parsedSegments);
  }

  const fullTranscript = fullTranscriptParts.join("\n\n").trim();

  return {
    segments: allTranscriptSegments,
    fullTranscript,
    durationSec: totalDurationSec,
  };
}

export default {
  transcribeWithDiarization,
  parseDiarizedTranscriptText,
};

