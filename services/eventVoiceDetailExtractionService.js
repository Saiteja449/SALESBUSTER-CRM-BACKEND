import fs from "fs";
import path from "path";
import { Type } from "@google/genai";
import { createGeminiClient } from "../configs/gemini.js";
import { normalizeIndianMobile, normalizeSpokenNumbers } from "./ai/contactExtractionService.js";

const TRANSCRIPTION_MODEL = "gemini-3.5-transcribe";
const EXTRACTION_MODEL = "gemini-3.5-flash-lite";

const resolveAudioMimeType = (filePath, mimeType) => {
  if (mimeType && mimeType !== "application/octet-stream") {
    if (mimeType === "audio/mp3") return "audio/mpeg";
    return mimeType;
  }
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".m4a": return "audio/m4a";
    case ".aac": return "audio/aac";
    case ".ogg": return "audio/ogg";
    case ".flac": return "audio/flac";
    case ".webm": return "audio/webm";
    default: return "audio/m4a";
  }
};

const normalizeForEvidence = (value = "") => String(value)
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[\p{P}\p{S}]+/gu, " ")
  .replace(/\s+/g, " ")
  .trim();

const cleanEvidenceField = (candidate, transcript, { phone = false } = {}) => {
  const value = typeof candidate?.value === "string" ? candidate.value.trim() : "";
  const evidence = typeof candidate?.evidence === "string" ? candidate.evidence.trim() : "";
  if (!value || !evidence || !normalizeForEvidence(transcript).includes(normalizeForEvidence(evidence))) {
    return "";
  }

  if (phone) {
    const evidenceDigits = normalizeSpokenNumbers(evidence);
    const normalizedPhone = normalizeIndianMobile(evidenceDigits);
    const modelDigits = value.replace(/\D/g, "");
    return normalizedPhone && normalizeIndianMobile(modelDigits) === normalizedPhone ? normalizedPhone : "";
  }

  return normalizeForEvidence(evidence).includes(normalizeForEvidence(value)) ? value : "";
};

const waitForFileReady = async (client, file) => {
  let current = file;
  for (let attempt = 0; current?.state === "PROCESSING" && attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    current = await client.files.get({ name: file.name });
  }
  if (current?.state === "FAILED") {
    throw new Error("Gemini could not process the uploaded voice recording.");
  }
  return current;
};

const DISCUSSION_POINT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    detail: { type: Type.STRING, description: "A concise factual paraphrase of one extra discussion detail." },
    evidence: { type: Type.STRING, description: "An exact, contiguous quote from the transcript proving this detail." },
  },
  required: ["detail", "evidence"],
};

const EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    customerName: {
      type: Type.OBJECT,
      properties: {
        value: { type: Type.STRING },
        evidence: { type: Type.STRING, description: "Exact transcript quote that identifies the attendee by name." },
      },
      required: ["value", "evidence"],
    },
    companyName: {
      type: Type.OBJECT,
      properties: {
        value: { type: Type.STRING },
        evidence: { type: Type.STRING, description: "Exact transcript quote naming the attendee's business." },
      },
      required: ["value", "evidence"],
    },
    designation: {
      type: Type.OBJECT,
      properties: {
        value: { type: Type.STRING },
        evidence: { type: Type.STRING, description: "Exact transcript quote stating the attendee's role." },
      },
      required: ["value", "evidence"],
    },
    phone: {
      type: Type.OBJECT,
      properties: {
        value: { type: Type.STRING, description: "The explicitly spoken Indian mobile number in digits, or empty string." },
        evidence: { type: Type.STRING, description: "Exact transcript quote containing the dictated phone number." },
      },
      required: ["value", "evidence"],
    },
    discussionPoints: { type: Type.ARRAY, items: DISCUSSION_POINT_SCHEMA },
  },
  required: ["customerName", "companyName", "designation", "phone", "discussionPoints"],
};

/** Transcribes recorded guest voice first, then extracts only transcript-supported fields. */
export async function extractEventVoiceDetails({ filePath, mimeType, apiKey, eventName, organizationName, requestId }) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error("Audio recording file was not found.");
  if (!apiKey) throw new Error("Gemini AI API key is not configured for voice detail capture.");

  const client = createGeminiClient({ aiSettings: { geminiApiKey: apiKey } });
  const resolvedMimeType = resolveAudioMimeType(filePath, mimeType);
  let uploadedFile;
  try {
    const uploadStartedAt = Date.now();
    uploadedFile = await client.files.upload({
      file: filePath,
      config: { mimeType: resolvedMimeType, displayName: `Guest voice capture ${path.basename(filePath)}` },
    });
    await waitForFileReady(client, uploadedFile);
    console.info(`[CONTACT_CAPTURE][${requestId}] Gemini transcription upload ready`, {
      mimeType: resolvedMimeType,
      uploadDurationMs: Date.now() - uploadStartedAt,
    });

    const transcriptionStartedAt = Date.now();
    const transcription = await client.interactions.create({
      model: TRANSCRIPTION_MODEL,
      store: false,
      input: [{ type: "audio", uri: uploadedFile.uri, mime_type: uploadedFile.mimeType || resolvedMimeType }],
      generation_config: {
        transcription_config: {
          language_codes: [],
          diarization_mode: "speaker",
        },
      },
    });
    const transcript = typeof transcription.output_text === "string" ? transcription.output_text.trim() : "";
    console.info(`[CONTACT_CAPTURE][${requestId}] Gemini transcription complete`, {
      model: TRANSCRIPTION_MODEL,
      durationMs: Date.now() - transcriptionStartedAt,
      transcriptChars: transcript.length,
    });
    if (!transcript) throw new Error("No speech could be transcribed. Please record again in a quieter place.");

    const extractionStartedAt = Date.now();
    const prompt = `Extract attendee details from the transcript below. The transcript is the only source of truth.

Rules:
- Do not use outside knowledge, complete missing information, infer likely names, or guess which organization/role/number is intended.
- Extract a value only when the attendee explicitly says it or clearly confirms it. If unclear, return an empty value and empty evidence.
- Do not assign the sales representative's own details to the attendee. The speakers may be labeled; use context only to distinguish the attendee from the representative, never to invent a value.
- For each non-empty field, evidence must be an exact, contiguous quote copied from the transcript that directly supports that field. Keep names and business names as transcribed; do not autocorrect spelling. Phone evidence may contain spoken number words; return the corresponding digits only when the complete Indian mobile number is clear.
- discussionPoints must cover every distinct attendee need, requirement, interest, product/service discussed, pain point, existing setup, budget, timing, decision, constraint, and agreed next step that is present, excluding the identity fields. Each point must have an exact contiguous transcript quote as evidence. Do not add a point without evidence.
- If the transcript does not clearly distinguish attendee speech, return empty identity fields; retain only discussion points with direct evidence.

Event context (not evidence for any field): ${eventName || ""}
Organization context (not evidence for any field): ${organizationName || ""}

Transcript:
${transcript}`;

    const extraction = await client.models.generateContent({
      model: EXTRACTION_MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: EXTRACTION_SCHEMA,
        temperature: 0,
      },
    });
    const rawText = extraction.text || "";
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
    } catch {
      throw new Error("Gemini returned an invalid structured extraction. Please retry the recording.");
    }

    const customerName = cleanEvidenceField(parsed.customerName, transcript);
    const companyName = cleanEvidenceField(parsed.companyName, transcript);
    const designation = cleanEvidenceField(parsed.designation, transcript);
    const phone = cleanEvidenceField(parsed.phone, transcript, { phone: true });
    const verifiedDiscussionPoints = (Array.isArray(parsed.discussionPoints) ? parsed.discussionPoints : [])
      .filter((point) => {
        const evidence = typeof point?.evidence === "string" ? point.evidence.trim() : "";
        const detail = typeof point?.detail === "string" ? point.detail.trim() : "";
        return detail && evidence && normalizeForEvidence(transcript).includes(normalizeForEvidence(evidence));
      });

    // Keep verbatim verified quotes in the summary to prevent generated claims from being presented as facts.
    const summary = [...new Set(verifiedDiscussionPoints.map((point) => `• ${point.evidence.trim()}`))].join("\n");
    console.info(`[CONTACT_CAPTURE][${requestId}] Transcript extraction complete`, {
      model: EXTRACTION_MODEL,
      durationMs: Date.now() - extractionStartedAt,
      fieldsFound: [customerName, phone, companyName, designation].filter(Boolean).length,
      verifiedDiscussionPoints: verifiedDiscussionPoints.length,
    });

    return { transcript, name: customerName, customerName, phone, companyName, designation, summary };
  } finally {
    if (uploadedFile?.name) {
      try {
        await client.files.delete({ name: uploadedFile.name });
        console.info(`[CONTACT_CAPTURE][${requestId}] Gemini audio file deleted`);
      } catch (error) {
        console.warn(`[CONTACT_CAPTURE][${requestId}] Gemini audio file cleanup failed`, { error: error.message });
      }
    }
  }
}
