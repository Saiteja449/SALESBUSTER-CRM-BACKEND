/**
 * Robustly extracts both audioTranscription parts (diarized speaker turns) and text parts
 * from Gemini models.generateContent response without triggering the SDK non-text parts warning.
 * @param {Object} response
 * @param {number} baseOffsetSec
 * @param {number} durationSec
 * @returns {{ segments: Array<Object>, fullTranscript: string }}
 */
export function extractTranscriptionFromResponse(response, baseOffsetSec = 0, durationSec = 0) {
  if (!response) {
    return { segments: [], fullTranscript: "" };
  }

  const segments = [];
  const fullTextLines = [];
  const candidates = response.candidates || [];

  for (const candidate of candidates) {
    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      // 1. Process audioTranscription parts (Speaker Diarization output from Gemini)
      if (part.audioTranscription) {
        const at = part.audioTranscription;
        const text = (typeof at.text === "string" ? at.text : "").trim();
        const rawSpeaker = at.speakerLabel || "Speaker A";

        let startSec = baseOffsetSec;
        let endSec = baseOffsetSec;

        if (Array.isArray(at.words) && at.words.length > 0) {
          const firstWord = at.words[0];
          const lastWord = at.words[at.words.length - 1];
          if (firstWord?.startOffset) {
            const parsed = parseFloat(String(firstWord.startOffset).replace("s", ""));
            if (!isNaN(parsed)) startSec = baseOffsetSec + parsed;
          }
          if (lastWord?.endOffset) {
            const parsed = parseFloat(String(lastWord.endOffset).replace("s", ""));
            if (!isNaN(parsed)) endSec = baseOffsetSec + parsed;
          }
        }

        if (text) {
          let cleanSpeaker = rawSpeaker.toLowerCase().trim().replace(/\s+/g, "_");
          if (!cleanSpeaker.startsWith("speaker_")) {
            cleanSpeaker = `speaker_${cleanSpeaker}`;
          }

          segments.push({
            speakerId: cleanSpeaker,
            text,
            startTime: startSec,
            endTime: endSec > startSec ? endSec : startSec + 3,
            isFinal: true,
            language: at.languageCode || "en-IN",
          });

          fullTextLines.push(`${rawSpeaker}: ${text}`);
        }
      }

      // 2. Process regular text parts
      if (typeof part.text === "string" && part.text.trim()) {
        const trimmed = part.text.trim();
        fullTextLines.push(trimmed);
      }
    }
  }

  // If structured audioTranscription segments were extracted, return them directly
  if (segments.length > 0) {
    return {
      segments,
      fullTranscript: fullTextLines.join("\n").trim(),
    };
  }

  // Fallback: parse text lines using parseDiarizedTranscriptText
  const combinedRawText = fullTextLines.join("\n").trim();
  const parsedSegments = parseDiarizedTranscriptText(combinedRawText, baseOffsetSec);

  if (parsedSegments.length === 0 && combinedRawText) {
    parsedSegments.push({
      speakerId: "speaker_A",
      text: combinedRawText,
      startTime: baseOffsetSec,
      endTime: baseOffsetSec + durationSec,
      isFinal: true,
    });
  }

  return {
    segments: parsedSegments,
    fullTranscript: combinedRawText,
  };
}

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
 * Legacy offline helper retained for transcript parsing compatibility; configured to Gemini Live.
 * Optimized for single-person high-fidelity speech-to-text.
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
    throw new Error("Invalid or empty audio buffer provided for transcription.");
  }

  const ai = createGeminiClient(organization);
  const modelName = GEMINI_MODELS.LIVE_CAPTURE;
  const totalDurationSec = calculatePcmDuration(pcmBuffer.length, 16000);

  // If audio is under 25 minutes, process in a single request.
  const audioSegments = segmentPcmBuffer(pcmBuffer, 1500, 16000);
  const allTranscriptSegments = [];
  const fullTranscriptParts = [];

  for (const seg of audioSegments) {
    const wavBuffer = pcmToWav(seg.pcmBuffer, 16000, 1, 16);
    const base64Audio = wavBuffer.toString("base64");

    const promptText =
      "Please provide an accurate, verbatim transcript of this single-person speech. " +
      "Capture all spoken words including personal names, company names, mobile numbers, and detailed discussion context in English, Hindi, or Telugu.";

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
          languageCodes,
          customVocabulary: customVocabulary.length > 0 ? customVocabulary : undefined,
          timestampGranularities: ["word"],
        },
      },
    });

    const { segments: extractedSegments, fullTranscript: extractedFullText } =
      extractTranscriptionFromResponse(response, seg.startTimeSec, seg.durationSec);

    if (extractedFullText) {
      fullTranscriptParts.push(extractedFullText);
    }
    allTranscriptSegments.push(...extractedSegments);
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
  extractTranscriptionFromResponse,
};

