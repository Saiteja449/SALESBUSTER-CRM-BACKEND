import { createGeminiClient, GEMINI_MODELS } from "../../configs/gemini.js";

/**
 * Single-Speaker Voice Detail & Attendee Contact Extraction Service.
 * Implements strict single-attendee identification, anti-salesperson isolation,
 * speaker-level evidence attribution, and Indian mobile number validation.
 */

const NUMBER_WORDS = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  shunya: "0", ek: "1", do: "2", teen: "3", char: "4", chaar: "4",
  paanch: "5", panch: "5", chhah: "6", che: "6", chhe: "6", saat: "7",
  aath: "8", nau: "9",
  sunna: "0", okati: "1", vokati: "1", rendu: "2", moodu: "3",
  naalugu: "4", nalugu: "4", aidu: "5", aayidu: "5", ayidu: "5",
  aaru: "6", yedu: "7", eedu: "7", enimidi: "8", tommidi: "9",
};

/**
 * Normalizes spoken number words to continuous digits.
 */
export function normalizeSpokenNumbers(text = "") {
  if (!text) return "";
  let normalized = text.toLowerCase();
  const digitWords = Object.keys(NUMBER_WORDS).join("|");
  const doubleRegex = new RegExp(`\\b(?:double|dubble)\\s+(${digitWords})\\b`, "gi");
  normalized = normalized.replace(doubleRegex, (_, d) => `${d} ${d}`);
  const tripleRegex = new RegExp(`\\b(?:triple)\\s+(${digitWords})\\b`, "gi");
  normalized = normalized.replace(tripleRegex, (_, d) => `${d} ${d} ${d}`);
  const wordRegex = new RegExp(`\\b(${digitWords})\\b`, "gi");
  normalized = normalized.replace(wordRegex, (m) => NUMBER_WORDS[m.toLowerCase()] || m);
  return normalized;
}

/**
 * Validates and normalizes an Indian 10-digit mobile number.
 * Must start with 6, 7, 8, or 9 and be exactly 10 digits.
 * Rejects numbers that match the salesperson's phone.
 * Does not silently truncate arbitrary length strings.
 */
export function normalizeIndianMobile(rawPhone = "", repPhone = "") {
  if (!rawPhone) return null;
  const digits = String(rawPhone).replace(/\D/g, "");
  const cleanRep = repPhone ? String(repPhone).replace(/\D/g, "").slice(-10) : "";

  let candidate = "";
  if (digits.length === 12 && digits.startsWith("91")) {
    candidate = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    candidate = digits.slice(1);
  } else if (digits.length === 10) {
    candidate = digits;
  } else {
    // Malformed or incomplete length
    return null;
  }

  if (!/^[6-9]\d{9}$/.test(candidate)) {
    return null;
  }

  if (cleanRep && candidate === cleanRep) {
    return null;
  }

  return candidate;
}

/**
 * Extracts phone numbers from text strictly matching Indian 10-digit mobile format.
 */
export function extractPhoneFromText(text = "", repPhone = "") {
  if (!text) return null;
  const normalized = normalizeSpokenNumbers(text);
  const regex = /(?:\+?91[\s-]?)?[0]?[6-9](?:[\s-]?\d){9}\b/g;
  const matches = normalized.match(regex);
  if (!matches) return null;

  for (let i = matches.length - 1; i >= 0; i--) {
    const valid = normalizeIndianMobile(matches[i], repPhone);
    if (valid) {
      return {
        value: valid,
        evidence: matches[i].trim(),
        confidence: 0.98,
      };
    }
  }
  return null;
}

/**
 * Extracts candidate personal name with self-introduction cues from text.
 */
export function extractNameFromText(text = "", repName = "") {
  if (!text) return null;
  const repNameClean = (repName || "").toLowerCase().trim();

  const patterns = [
    /\b(?:my name is|i am|this is|myself|call me|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i,
    /\b(?:mera naam|main|hum)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\s+(?:hoon|hai|bol raha)/i,
    /\b(?:naa peru|nenu)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})/i,
  ];

  for (const pat of patterns) {
    const match = text.match(pat);
    if (match && match[1]) {
      const candidate = match[1].trim();
      const candidateLower = candidate.toLowerCase();
      if (
        candidate.length >= 2 &&
        !/^(unknown|attendee|sir|madam|there|from|with|here)$/i.test(candidate) &&
        !(repNameClean && (candidateLower === repNameClean || repNameClean.includes(candidateLower)))
      ) {
        return {
          value: candidate,
          evidence: match[0].trim(),
          confidence: 0.96,
        };
      }
    }
  }
  return null;
}

/**
 * Extracts company name with affiliation cues from text.
 */
export function extractCompanyFromText(text = "", hostOrg = "") {
  if (!text) return null;
  const hostOrgClean = (hostOrg || "").toLowerCase().trim();

  const patterns = [
    /\b(?:i work at|i am with|i work for|i represent|representing|from our company|hamari company|naadi)\s+([A-Za-z0-9&.,'-]+(?:\s+[A-Za-z0-9&.,'-]+){0,3})/i,
    /\b(?:from|at|with)\s+([A-Z][A-Za-z0-9&.,'-]+(?:\s+[A-Z][A-Za-z0-9&.,'-]+){0,2})\b/i,
  ];

  for (const pat of patterns) {
    const match = text.match(pat);
    if (match && match[1]) {
      const candidate = match[1].replace(/[.,;:!?]+$/, "").trim();
      const candidateLower = candidate.toLowerCase();
      if (
        candidate.length >= 2 &&
        !/^(our|my|the|this|that|your|here|there|salesbuster|crm)$/i.test(candidateLower) &&
        !(hostOrgClean.length > 2 && (candidateLower === hostOrgClean || hostOrgClean.includes(candidateLower)))
      ) {
        return {
          value: candidate,
          evidence: match[0].trim(),
          confidence: 0.94,
        };
      }
    }
  }
  return null;
}

/**
 * Extracts job title / designation from text.
 */
export function extractDesignationFromText(text = "") {
  if (!text) return null;
  const patterns = [
    /\b(?:i am the|working as|my role is|i handle|i'm the|i am a|i'm a)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,3})\b/i,
    /\b(?:Managing Director|Technical Lead|Software Engineer|Purchase Head|Purchase Manager|Project Manager|Director|Founder|CEO|CTO|VP|Owner|Consultant|Developer)\b/i,
  ];

  for (const pat of patterns) {
    const match = text.match(pat);
    if (match) {
      const candidate = (match[1] || match[0]).trim();
      if (candidate.length >= 2 && !/^(here|with|from|working)$/i.test(candidate)) {
        return {
          value: candidate,
          evidence: match[0].trim(),
          confidence: 0.9,
        };
      }
    }
  }
  return null;
}

/**
 * Deterministically analyzes transcript segments to identify salesperson vs external attendee.
 */
export function analyzeConversationSpeakers({
  segments = [],
  rawTranscript = "",
  hostUser = null,
  organization = null,
}) {
  const repName = hostUser?.name || "";
  const repPhone = hostUser?.phone || "";
  const hostOrg = organization?.name || hostUser?.organizationName || "SalesBuster";
  const repPhoneClean = repPhone ? String(repPhone).replace(/\D/g, "").slice(-10) : "";
  const repNameLower = repName.toLowerCase().trim();
  const hostOrgLower = hostOrg.toLowerCase().trim();

  // 1. Group segments by speaker
  const speakerTurnsMap = new Map();
  if (Array.isArray(segments) && segments.length > 0) {
    for (const seg of segments) {
      const sId = (seg.speakerId || "speaker_a").toLowerCase().trim();
      if (!speakerTurnsMap.has(sId)) {
        speakerTurnsMap.set(sId, []);
      }
      speakerTurnsMap.get(sId).push(seg);
    }
  }

  const speakerProfiles = [];

  for (const [sId, turns] of speakerTurnsMap.entries()) {
    const combinedText = turns.map((t) => t.text || "").join(" ").trim();
    const phoneData = extractPhoneFromText(combinedText, repPhoneClean);
    const nameData = extractNameFromText(combinedText, repName);
    const companyData = extractCompanyFromText(combinedText, hostOrg);
    const designationData = extractDesignationFromText(combinedText);

    // Host detection
    const textLower = combinedText.toLowerCase();
    const hasHostName = Boolean(repNameLower.length > 2 && textLower.includes(repNameLower));
    const hasHostOrg = Boolean(hostOrgLower.length > 2 && textLower.includes(hostOrgLower));
    const hasHostPhone = Boolean(repPhoneClean && textLower.includes(repPhoneClean));
    const isHost = hasHostName || hasHostOrg || hasHostPhone;

    speakerProfiles.push({
      speakerId: sId,
      combinedText,
      turns,
      isHost,
      name: nameData,
      phone: phoneData,
      company: companyData,
      designation: designationData,
      introCount: (nameData ? 1 : 0) + (companyData ? 1 : 0) + (phoneData ? 1 : 0),
    });
  }

  // Check if diarization failed: only 1 speaker label exists, but multiple introductions in text
  if (speakerProfiles.length === 1) {
    const single = speakerProfiles[0];
    const fullText = single.combinedText || rawTranscript || "";
    const introMatches = fullText.match(/\b(?:my name is|i am|mera naam|naa peru)\s+[A-Za-z]+/gi) || [];

    // If multiple self-introductions in a single unsegmented text, diarization failed
    if (introMatches.length > 1) {
      return {
        selectedSpeakerId: null,
        identityStatus: "uncertain",
        selectionReason: "Diarization failed to isolate speakers; multiple introductions detected in single segment",
        requiresManualReview: true,
        isComplete: false,
        contact: {
          name: { value: null, speakerId: null, evidence: null, confidence: 0 },
          phone: { value: null, speakerId: null, evidence: null, confidence: 0 },
          company: { value: null, speakerId: null, evidence: null, confidence: 0 },
          designation: { value: null, speakerId: null, evidence: null, confidence: 0 },
        },
        summary: fullText.slice(0, 300),
        otherSpeakers: speakerProfiles,
        diarizationFailed: true,
      };
    }

    // If the single speaker is the salesperson mentioning their own details
    if (single.isHost && !single.name && !single.company && !single.phone) {
      return {
        selectedSpeakerId: null,
        identityStatus: "uncertain",
        selectionReason: "Only salesperson details detected; no external attendee present",
        requiresManualReview: true,
        isComplete: false,
        contact: {
          name: { value: null, speakerId: null, evidence: null, confidence: 0 },
          phone: { value: null, speakerId: null, evidence: null, confidence: 0 },
          company: { value: null, speakerId: null, evidence: null, confidence: 0 },
          designation: { value: null, speakerId: null, evidence: null, confidence: 0 },
        },
        summary: fullText.slice(0, 300),
        otherSpeakers: speakerProfiles,
      };
    }
  }

  // Filter external (non-host) candidate speakers
  const externalCandidates = speakerProfiles.filter((s) => !s.isHost);

  // If all speakers were tagged as host, or no external candidates
  if (externalCandidates.length === 0) {
    // If only 1 speaker existed and was not explicitly host, treat as single speaker
    if (speakerProfiles.length === 1 && !speakerProfiles[0].isHost) {
      externalCandidates.push(speakerProfiles[0]);
    } else {
      return {
        selectedSpeakerId: null,
        identityStatus: "uncertain",
        selectionReason: "No external attendee identified; only salesperson detected",
        requiresManualReview: true,
        isComplete: false,
        contact: {
          name: { value: null, speakerId: null, evidence: null, confidence: 0 },
          phone: { value: null, speakerId: null, evidence: null, confidence: 0 },
          company: { value: null, speakerId: null, evidence: null, confidence: 0 },
          designation: { value: null, speakerId: null, evidence: null, confidence: 0 },
        },
        summary: (rawTranscript || "").slice(0, 300),
        otherSpeakers: speakerProfiles,
      };
    }
  }

  // Rank external candidates: prefer speaker who introduced themselves (has name/company/phone)
  externalCandidates.sort((a, b) => b.introCount - a.introCount);

  let selected = externalCandidates[0];
  let identityStatus = "verified";
  let selectionReason = "External attendee identified through self-introduction";
  let requiresManualReview = false;

  // Check if multiple external attendees introduced themselves
  const introducingCandidates = externalCandidates.filter((c) => c.name?.value);
  if (introducingCandidates.length > 1) {
    selected = introducingCandidates[0];
    identityStatus = "requires_verification";
    selectionReason = "Multiple external attendees introduced themselves; first introducing attendee selected for verification";
    requiresManualReview = true;
  } else if (!selected.name?.value && !selected.company?.value && !selected.phone?.value) {
    identityStatus = "uncertain";
    selectionReason = "External attendee did not introduce themselves or provide contact details";
    requiresManualReview = true;
  } else if (!selected.name?.value) {
    identityStatus = "uncertain";
    selectionReason = "External attendee spoke but did not provide personal name";
    requiresManualReview = true;
  }

  // Construct contact with strict speaker-level attribution
  const sId = selected.speakerId;
  const contact = {
    name: {
      value: selected.name?.value || null,
      speakerId: selected.name?.value ? sId : null,
      evidence: selected.name?.evidence || null,
      confidence: selected.name?.confidence || 0,
    },
    phone: {
      value: selected.phone?.value || null,
      speakerId: selected.phone?.value ? sId : null,
      evidence: selected.phone?.evidence || null,
      confidence: selected.phone?.confidence || 0,
    },
    company: {
      value: selected.company?.value || null,
      speakerId: selected.company?.value ? sId : null,
      evidence: selected.company?.evidence || null,
      confidence: selected.company?.confidence || 0,
    },
    designation: {
      value: selected.designation?.value || null,
      speakerId: selected.designation?.value ? sId : null,
      evidence: selected.designation?.evidence || null,
      confidence: selected.designation?.confidence || 0,
    },
  };

  const isComplete = Boolean(
    contact.name.value &&
    contact.phone.value &&
    /^[6-9]\d{9}$/.test(contact.phone.value) &&
    contact.company.value &&
    identityStatus === "verified" &&
    !requiresManualReview
  );

  return {
    selectedSpeakerId: sId,
    identityStatus,
    selectionReason,
    requiresManualReview,
    isComplete,
    contact,
    summary: selected.combinedText.slice(0, 300) || rawTranscript.slice(0, 300),
    otherSpeakers: speakerProfiles.filter((s) => s.speakerId !== sId),
  };
}

/**
 * Builds Gemini Flash structured extraction prompt for speaker-attributed conversation.
 */
function buildSpeakerAwarePrompt({ segmentsText, hostUser, organization }) {
  const repName = hostUser?.name || "Vikram Malhotra";
  const repPhone = hostUser?.phone || "";
  const hostOrg = organization?.name || hostUser?.organizationName || "SalesBuster";

  return `You are a Senior AI Conversation Intelligence & CRM Specialist.
Analyze the following diarized conversation between a Salesperson and one or more people.

AUTHENTICATED HOST SALESPERSON PROFILE:
- Salesperson Name: "${repName}"
- Salesperson Organization: "${hostOrg}"
- Salesperson Phone: "${repPhone}"

CONVERSATION TRANSCRIPT:
"""
${segmentsText}
"""

CRITICAL EXTRACTION RULES:
1. IDENTIFY THE SALESPERSON:
   - Identify the speaker who is the salesperson using the host profile above (matches name "${repName}", organization "${hostOrg}", or represents the host CRM).
   - NEVER attribute the salesperson's name, phone, or company to the attendee.
2. IDENTIFY THE EXTERNAL ATTENDEE:
   - Identify the ONE external attendee / customer / lead speaking with the salesperson.
   - Select that attendee's speaker ID (e.g., "speaker_b").
3. STRICT SPEAKER ISOLATION (ZERO CROSS-SPEAKER MIXING):
   - Every extracted field for the attendee MUST come exclusively from statements spoken by that selected attendee.
   - NEVER mix Speaker A's company or phone with Speaker B's name!
   - If a field was not explicitly stated by the selected attendee, return value: null, speakerId: null, evidence: null, confidence: 0.
4. ATTENDEE FIELDS:
   - name: Full personal name of attendee only (e.g., "Suresh Kumar"). Never salesperson's name.
   - company: Explicitly named company/firm of the attendee (e.g., "Infosys"). Never host org ("${hostOrg}").
   - designation: Job title or role of attendee if mentioned. Null if not mentioned.
   - phone: 10-digit Indian mobile number spoken by attendee (starting with 6, 7, 8, or 9). Null if incomplete or missing. Never salesperson's phone.
5. SUMMARY:
   - Provide an in-detail summary of the attendee's requirements, pain points, products discussed, and agreed next steps.

OUTPUT FORMAT:
Respond ONLY with a valid JSON object matching this exact structure:
{
  "selectedSpeakerId": "speaker_b",
  "identityStatus": "verified",
  "selectionReason": "External attendee identified through self-introduction",
  "requiresManualReview": false,
  "contact": {
    "name": {
      "value": "Suresh Kumar",
      "speakerId": "speaker_b",
      "evidence": "My name is Suresh Kumar",
      "confidence": 0.98
    },
    "phone": {
      "value": "9876543210",
      "speakerId": "speaker_b",
      "evidence": "My mobile number is 9876543210",
      "confidence": 0.99
    },
    "company": {
      "value": "Infosys",
      "speakerId": "speaker_b",
      "evidence": "I work at Infosys",
      "confidence": 0.96
    },
    "designation": {
      "value": null,
      "speakerId": null,
      "evidence": null,
      "confidence": 0
    }
  },
  "detailedSummary": "Attendee discussed requirement for CRM..."
}
`;
}

/**
 * Extracts structured contact details and in-depth summary from a diarized conversation.
 * Combines Gemini Flash LLM intelligence with strict deterministic validation guardrails.
 * @param {Object} options
 * @param {Array<Object>} [options.segments=[]] - Array of diarized transcript segments
 * @param {string} [options.rawTranscript=""] - Complete accumulated transcript
 * @param {Object} [options.hostUser] - Authenticated salesperson details
 * @param {Object} [options.organization] - Tenant organization
 * @returns {Promise<Object>} Authoritative structured contact extraction result
 */
export async function extractSpeakerAwareContact({
  segments = [],
  rawTranscript = "",
  hostUser = null,
  organization = null,
}) {
  // Run deterministic baseline analysis first
  const baseline = analyzeConversationSpeakers({
    segments,
    rawTranscript,
    hostUser,
    organization,
  });

  const repName = hostUser?.name || "";
  const repPhone = hostUser?.phone || "";
  const hostOrg = organization?.name || hostUser?.organizationName || "SalesBuster";
  const repPhoneClean = repPhone ? String(repPhone).replace(/\D/g, "").slice(-10) : "";

  // If baseline detected diarization failure or no transcript, return immediately
  if (baseline.diarizationFailed || (!rawTranscript && segments.length === 0)) {
    return baseline;
  }

  // Format segments text for LLM
  let segmentsText = "";
  if (Array.isArray(segments) && segments.length > 0) {
    segmentsText = segments
      .map((s) => `[${s.speakerId || "speaker_a"}]: ${s.text || ""}`)
      .join("\n");
  } else {
    segmentsText = rawTranscript;
  }

  try {
    const ai = createGeminiClient(organization);
    const modelName = GEMINI_MODELS.EXTRACTION_SUMMARY;
    const prompt = buildSpeakerAwarePrompt({ segmentsText, hostUser, organization });

    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });

    const rawText = response.text || "";
    const cleanJson = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    if (cleanJson) {
      const parsed = JSON.parse(cleanJson);
      const selectedId = (parsed.selectedSpeakerId || baseline.selectedSpeakerId || "").toLowerCase();

      // Guardrail 1: Strictly enforce speaker isolation and evidence validation
      const turnsForSelected = segments.filter(
        (s) => (s.speakerId || "").toLowerCase() === selectedId
      );
      const selectedCombinedText = turnsForSelected.map((t) => t.text || "").join(" ").toLowerCase();

      const validateField = (fieldObj, fallbackField, fieldType) => {
        if (!fieldObj?.value) return fallbackField;
        const val = String(fieldObj.value).trim();
        const evidence = String(fieldObj.evidence || "").trim().toLowerCase();

        // Anti-salesperson shield
        if (fieldType === "name" && repName && val.toLowerCase() === repName.toLowerCase()) {
          return { value: null, speakerId: null, evidence: null, confidence: 0 };
        }
        if (fieldType === "company" && hostOrg && val.toLowerCase() === hostOrg.toLowerCase()) {
          return { value: null, speakerId: null, evidence: null, confidence: 0 };
        }
        if (fieldType === "phone") {
          const validPhone = normalizeIndianMobile(val, repPhoneClean);
          if (!validPhone) {
            return { value: null, speakerId: null, evidence: null, confidence: 0 };
          }
          return {
            value: validPhone,
            speakerId: selectedId || null,
            evidence: fieldObj.evidence || null,
            confidence: fieldObj.confidence || 0.95,
          };
        }

        // Cross-speaker shield: verify evidence occurred in selected speaker's turns
        if (evidence && selectedCombinedText && !selectedCombinedText.includes(evidence)) {
          console.warn(`[ContactExtraction] Cross-speaker evidence detected for ${fieldType}: "${evidence}" not in ${selectedId}. Discarding.`);
          return fallbackField;
        }

        return {
          value: val,
          speakerId: selectedId || null,
          evidence: fieldObj.evidence || null,
          confidence: fieldObj.confidence || 0.9,
        };
      };

      const finalContact = {
        name: validateField(parsed.contact?.name, baseline.contact.name, "name"),
        phone: validateField(parsed.contact?.phone, baseline.contact.phone, "phone"),
        company: validateField(parsed.contact?.company, baseline.contact.company, "company"),
        designation: validateField(parsed.contact?.designation, baseline.contact.designation, "designation"),
      };

      let finalIdentityStatus = parsed.identityStatus || baseline.identityStatus;
      let finalRequiresManualReview = Boolean(parsed.requiresManualReview ?? baseline.requiresManualReview);

      if (!finalContact.name.value) {
        finalIdentityStatus = "uncertain";
        finalRequiresManualReview = true;
      } else if (baseline.identityStatus === "requires_verification") {
        finalIdentityStatus = "requires_verification";
        finalRequiresManualReview = true;
      } else if (baseline.identityStatus === "uncertain") {
        finalIdentityStatus = "uncertain";
        finalRequiresManualReview = true;
      }

      const isComplete = Boolean(
        finalContact.name.value &&
        finalContact.phone.value &&
        /^[6-9]\d{9}$/.test(finalContact.phone.value) &&
        finalContact.company.value &&
        finalIdentityStatus === "verified" &&
        !finalRequiresManualReview
      );

      return {
        selectedSpeakerId: selectedId || baseline.selectedSpeakerId,
        identityStatus: finalIdentityStatus,
        selectionReason: parsed.selectionReason || baseline.selectionReason,
        requiresManualReview: finalRequiresManualReview,
        isComplete,
        contact: finalContact,
        detailedSummary: parsed.detailedSummary || baseline.summary,
        summary: parsed.detailedSummary || baseline.summary,
        otherSpeakers: baseline.otherSpeakers,
      };
    }
  } catch (err) {
    console.warn(`[ContactExtraction] Gemini Flash model call failed: ${err.message}. Using deterministic baseline.`);
  }

  return baseline;
}

export default {
  extractSpeakerAwareContact,
  analyzeConversationSpeakers,
  normalizeIndianMobile,
  normalizeSpokenNumbers,
};
