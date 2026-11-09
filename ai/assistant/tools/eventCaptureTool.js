/**
 * Event Contact Capture & Real-Time Interim Tools for Gemini Multimodal Live API
 * Provides live progressive field filling and completed contact review popup triggers.
 */

export const EVENT_INTERIM_TOOL_DECLARATION = {
  name: "update_contact_draft",
  description:
    "Progressively updates attendee contact fields on mobile. Keep name and company strictly distinct: name is only a clearly identified person's name; companyName is only an explicitly identified business or organization. Never put a person's name in companyName or a company, role, or location in name. Send summary as a concise factual note when discussion needs or next steps are mentioned.",
  parameters: {
    type: "OBJECT",
    properties: {
      name: {
        type: "STRING",
        description: "Attendee person's name only, and only after explicit self-introduction or clear identification. Never a company, role, location, or generic label. Must not be the sales representative.",
      },
      nameEvidence: { type: "STRING", description: "Exact short phrase from the attendee that explicitly identifies this name, such as 'my name is ...', 'I am ...', 'mera naam ...', or 'naa peru ...'. Leave name empty when there is no such evidence." },
      phone: {
        type: "STRING",
        description: "Mobile phone digits spoken. Can be partial or complete.",
      },
      companyName: {
        type: "STRING",
        description: "Explicitly named attendee company/business only. Never a person's name, job title, location, or discussion topic. Must not be the host organization.",
      },
      designation: {
        type: "STRING",
        description: "Attendee job title, role, or designation if heard (e.g. 'Managing Director', 'CEO', 'Purchasing Head', 'Owner').",
      },
      summary: {
        type: "STRING",
        description: "Concise factual summary of the attendee's stated needs, interest, products discussed, or agreed next steps. Do not invent details.",
      },
      suggestedMessage: {
        type: "STRING",
        description: "Draft WhatsApp greeting message based on discussion so far.",
      },
    },
  },
};

export const EVENT_CAPTURE_TOOL_DECLARATION = {
  name: "trigger_contact_review",
  description:
    "Marks attendee contact details as completely captured for validation once all key details are spoken: full name, complete 10-digit mobile phone number, and company name. Operates non-intrusively without interrupting active listening.",
  parameters: {
    type: "OBJECT",
    properties: {
      name: {
        type: "STRING",
        description: "Attendee person's full name only; never a company or job title. Mandatory.",
      },
      nameEvidence: { type: "STRING", description: "Exact short phrase from the attendee explicitly identifying this name. Required evidence such as 'my name is ...', 'I am ...', 'mera naam ...', or 'naa peru ...'." },
      phone: {
        type: "STRING",
        description: "10-digit mobile number spoken. Extract only digits. Mandatory. Must be a complete 10-digit number.",
      },
      companyName: {
        type: "STRING",
        description: "Attendee's explicitly named company/business only; never a person's name or job title. Mandatory.",
      },
      designation: {
        type: "STRING",
        description: "Job title, role, or designation spoken (e.g. 'Managing Director', 'Owner', 'CEO', 'Operations Head'). Optional if not mentioned.",
      },
      summary: {
        type: "STRING",
        description: "Concise factual 1-2 sentence summary of stated needs, interest, products discussed, or next steps. Do not invent details.",
      },
      suggestedMessage: {
        type: "STRING",
        description:
          "Personalized, professional WhatsApp greeting message ready to send from the sales rep to this contact.",
      },
    },
    required: ["name", "nameEvidence", "phone", "companyName"],
  },
};

const NON_PERSON_NAME_TERMS = new Set([
  "attendee", "customer", "contact", "visitor", "guest", "client", "lead",
  "ceo", "cto", "coo", "cfo", "director", "manager", "owner", "founder",
  "partner", "engineer", "consultant", "president", "head", "staff", "sales",
  "marketing", "operations", "interested", "looking", "planning", "discussing",
]);

function isExplicitPersonName(name, evidence, repName = "") {
  const candidate = String(name || "").trim();
  const phrase = String(evidence || "").trim();
  if (!candidate || candidate.length > 70 || !phrase || phrase.length > 120) return false;
  const tokens = candidate.split(/\s+/);
  if (tokens.length > 4 || tokens.some((token) => !/^\p{L}[\p{L}'’-]{0,24}\.?$/u.test(token))) return false;
  if (tokens.some((token) => NON_PERSON_NAME_TERMS.has(token.toLowerCase().replace(/\.$/, "")))) return false;
  if (!phrase.toLowerCase().includes(candidate.toLowerCase())) return false;
  if (!/(?:my name is|myself|name is|i am|i'm|this is|call me|mera naam|naam hai|naa peru|na peru|nenu)\b/i.test(phrase)) return false;
  const rep = String(repName || "").trim().toLowerCase();
  return !rep || candidate.toLowerCase() !== rep;
}

const COMPANY_INDICATOR_REGEX = /\b(?:pvt|ltd|limited|private|llp|inc|incorporated|corp|corporation|technologies|technology|tech|solutions|enterprises|enterprise|industries|industry|services|service|consulting|consultancy|group|agency|logistics|infotech|software|holdings|motors|textiles|pharmaceuticals|pharma|labs|systems|traders|trading|ventures|digital|retail|infra|power|energy|steel)\b/i;

const KNOWN_COMPANY_BRANDS = new Set([
  'infosys', 'tcs', 'wipro', 'cognizant', 'accenture', 'hcl', 'reliance', 'tata',
  'petsfolio', 'bajaj', 'mahindra', 'godrej', 'adani', 'airtel', 'jio', 'hdfc',
  'icici', 'sbi', 'google', 'microsoft', 'amazon', 'apple', 'meta', 'netflix',
  'uber', 'ola', 'zomato', 'swiggy', 'paytm', 'flipkart', 'deloitte', 'ey',
  'kpmg', 'pwc', 'capgemini', 'oracle', 'sap', 'cisco', 'intel', 'ibm', 'samsung',
  'sony', 'lg', 'hyundai', 'maruti', 'suzuki', 'toyota', 'honda', 'hero', 'itc',
  'l&t', 'larsen', 'toubro', 'apex', 'vertex', 'zenith', 'acme', 'birla', 'vedanta',
  'apollo', 'fortis', 'bosch', 'siemens', 'dell', 'hp', 'lenovo', 'asus', 'salesforce',
  'zoho', 'freshworks', 'zepto', 'blinkit', 'phonepe', 'cred', 'razorpay', 'zerodha'
]);

function isLikelyCompany(str = '') {
  if (!str || typeof str !== 'string') return false;
  const clean = str.trim().toLowerCase();
  if (clean.length < 2) return false;
  if (KNOWN_COMPANY_BRANDS.has(clean)) return true;
  if (COMPANY_INDICATOR_REGEX.test(clean)) return true;
  const tokens = clean.split(/[\s&,-]+/).filter(Boolean);
  for (const t of tokens) {
    if (KNOWN_COMPANY_BRANDS.has(t)) return true;
    if (COMPANY_INDICATOR_REGEX.test(t)) return true;
  }
  return false;
}

export const createEventInterimTool = ({ socket, eventId, eventName, user, organization }) => {
  const handler = async (args = {}) => {
    const repName = user?.name || "Sales Manager";
    const orgName = organization?.name || "Our Team";
    const repPhone = (user?.phone || "").replace(/\D/g, "").slice(-10);
    const currentEvent = eventName || "our event";

    let cleanPhone = "";
    let partialPhone = "";
    if (args.phone) {
      const rawDigits = String(args.phone).replace(/\D/g, "");
      let candidate = rawDigits;
      if (candidate.length === 12 && candidate.startsWith("91")) candidate = candidate.slice(2);
      else if (candidate.length === 11 && candidate.startsWith("0")) candidate = candidate.slice(1);

      if (candidate.length === 10 && /^[6-9]\d{9}$/.test(candidate) && candidate !== repPhone) {
        cleanPhone = candidate;
      } else if (rawDigits.length > 0) {
        partialPhone = rawDigits;
      }
    }

    let rawName = (typeof args.name === 'string' ? args.name : (args.name ? String(args.name) : "")).trim();
    const nameEvidence = String(args.nameEvidence || "").trim();
    let companyName = (typeof args.companyName === 'string' ? args.companyName : (args.companyName ? String(args.companyName) : "")).trim();
    const designation = (typeof args.designation === 'string' ? args.designation : (args.designation ? String(args.designation) : "")).trim();
    const summary = (typeof args.summary === 'string' ? args.summary : (args.summary ? String(args.summary) : "")).trim();

    if (!isExplicitPersonName(rawName, nameEvidence, repName)) rawName = "";

    // Cross-field company name leakage check
    if (rawName) {
      const rawLower = rawName.toLowerCase();
      if (companyName) {
        const compLower = companyName.toLowerCase();
        if (rawLower === compLower || compLower.includes(rawLower) || rawLower.includes(compLower)) {
          rawName = "";
        }
      }
      if (rawName && isLikelyCompany(rawName)) {
        if (!companyName) {
          companyName = rawName;
        }
        rawName = "";
      }
    }

    // Anti-self capture filters
    const repNameLower = repName.toLowerCase();
    if (rawName && repNameLower.length > 2 && rawName.toLowerCase().includes(repNameLower)) {
      rawName = "";
    }
    if (repPhone && cleanPhone === repPhone) {
      cleanPhone = "";
    }
    const orgLower = orgName.toLowerCase();
    if (companyName && orgLower.length > 2 && companyName.toLowerCase().includes(orgLower)) {
      companyName = "";
    }

    const payload = {
      eventId: eventId || null,
      eventName: currentEvent,
      name: rawName,
      nameEvidence: rawName ? nameEvidence : "",
      phone: cleanPhone,
      partialPhone: partialPhone || null,
      companyName,
      designation,
      summary,
      messageText: (args.suggestedMessage || "").trim(),
      updatedAt: new Date().toISOString(),
      isComplete: Boolean(rawName && cleanPhone.length === 10 && companyName),
    };

    if (socket) {
      socket.emit("conversation:contact_update", payload);
      socket.emit("event_contact_interim", payload);
      console.log(`[EventCaptureTool] Emitted contact update to socket ${socket.id}: Name="${rawName}", Phone="${cleanPhone}", Company="${companyName}", Designation="${designation}"`);
    }

    return JSON.stringify({
      ok: true,
      message: "Draft contact fields updated in real-time on mobile screen.",
      payload,
    });
  };

  return {
    name: "update_contact_draft",
    description: EVENT_INTERIM_TOOL_DECLARATION.description,
    invoke: handler,
    execute: handler,
  };
};

export const createEventCaptureTool = ({ socket, eventId, eventName, user, organization }) => {
  const handler = async (args = {}) => {
    const repName = user?.name || "Sales Manager";
    const orgName = organization?.name || "Our Team";
    const repPhone = (user?.phone || "").replace(/\D/g, "").slice(-10);
    const currentEvent = eventName || "our event";

    // Normalize phone number (must be a valid 10-digit Indian mobile number)
    let cleanPhone = "";
    if (args.phone) {
      const digits = String(args.phone).replace(/\D/g, "");
      let candidate = digits;
      if (candidate.length === 12 && candidate.startsWith("91")) candidate = candidate.slice(2);
      else if (candidate.length === 11 && candidate.startsWith("0")) candidate = candidate.slice(1);

      if (candidate.length === 10 && /^[6-9]\d{9}$/.test(candidate) && candidate !== repPhone) {
        cleanPhone = candidate;
      }
    }

    let rawName = (typeof args.name === 'string' ? args.name : (args.name ? String(args.name) : "")).trim();
    const nameEvidence = String(args.nameEvidence || "").trim();
    let companyName = (typeof args.companyName === 'string' ? args.companyName : (args.companyName ? String(args.companyName) : "")).trim();
    const designation = (typeof args.designation === 'string' ? args.designation : (args.designation ? String(args.designation) : "")).trim();
    const summary = (typeof args.summary === 'string' ? args.summary : (args.summary ? String(args.summary) : "")).trim();

    if (!isExplicitPersonName(rawName, nameEvidence, repName)) {
      rawName = "";
    }

    // STRICT DEFENSE: Cross-field company name leakage check
    if (rawName) {
      const rawLower = rawName.toLowerCase();
      if (companyName) {
        const compLower = companyName.toLowerCase();
        if (rawLower === compLower || compLower.includes(rawLower) || rawLower.includes(compLower)) {
          console.log(`[EventCaptureTool] Withholding popup trigger - rawName "${rawName}" matches companyName "${companyName}"`);
          rawName = "";
        }
      }
      if (rawName && isLikelyCompany(rawName)) {
        console.log(`[EventCaptureTool] Withholding popup trigger - rawName "${rawName}" is a company entity`);
        if (!companyName) {
          companyName = rawName;
        }
        rawName = "";
      }
    }

    // STRICT VALIDATION 1: Require full name, complete 10-digit phone, and company before triggering complete review
    if (!rawName || rawName.length < 2 || !cleanPhone || cleanPhone.length !== 10 || !companyName || companyName.length < 2) {
      console.log(
        `[EventCaptureTool] Withholding popup trigger - incomplete details: Name="${rawName}", Phone="${cleanPhone}" (${cleanPhone.length} digits), Company="${companyName}"`
      );
      return JSON.stringify({
        ok: false,
        message: "Trigger withheld: Full name, valid 10-digit phone number, and company name are all required before opening the review popup.",
        missing: {
          name: !rawName || rawName.length < 2,
          phone: !cleanPhone || cleanPhone.length !== 10,
          companyName: !companyName || companyName.length < 2,
        },
      });
    }

    // STRICT VALIDATION 2: Anti-Self Capture Defense
    const nameLower = rawName.toLowerCase();
    const repNameLower = repName.toLowerCase();
    if (repNameLower.length > 2 && (nameLower === repNameLower || nameLower.includes(repNameLower))) {
      console.log(`[EventCaptureTool] Withholding popup trigger - captured name matches sales rep (${rawName})`);
      return JSON.stringify({
        ok: false,
        message: "Trigger withheld: Captured name matches the sales representative, not the external attendee.",
      });
    }

    if (repPhone && cleanPhone === repPhone) {
      console.log(`[EventCaptureTool] Withholding popup trigger - captured phone matches sales rep's phone (${cleanPhone})`);
      return JSON.stringify({
        ok: false,
        message: "Trigger withheld: Captured phone matches the sales representative's phone, not the external attendee.",
      });
    }

    const companyLower = companyName.toLowerCase();
    const orgLower = orgName.toLowerCase();
    if (orgLower.length > 2 && (companyLower === orgLower || companyLower.includes(orgLower))) {
      console.log(`[EventCaptureTool] Withholding popup trigger - captured company matches host organization (${companyName})`);
      return JSON.stringify({
        ok: false,
        message: "Trigger withheld: Captured company matches the host organization, not the attendee's company.",
      });
    }

    const attendeeName = rawName;
    const greetingName = rawName || "there";
    const defaultMessage =
      `Hello ${greetingName},\n\n` +
      `It was great connecting with you${companyName ? ` from ${companyName}` : ""} at ${currentEvent}.\n` +
      `Feel free to reach out to me directly on WhatsApp whenever you need any assistance!\n\n` +
      `Best regards,\n` +
      `*${repName}*\n` +
      `${orgName}`;

    const messageText = (args.suggestedMessage || defaultMessage).trim();

    const payload = {
      eventId: eventId || null,
      eventName: currentEvent,
      name: rawName,
      nameEvidence: nameEvidence,
      displayName: attendeeName,
      phone: cleanPhone,
      companyName,
      designation,
      summary,
      messageText,
      triggeredAt: new Date().toISOString(),
      isComplete: true,
    };

    console.log(
      `[EventCaptureTool] trigger_contact_review EXECUTED for socket ${socket?.id}: Name="${rawName}", Phone="${cleanPhone}", Company="${companyName}"`
    );

    // Emit event directly to the mobile client
    if (socket) {
      socket.emit("conversation:contact_ready", payload);
      socket.emit("event_contact_triggered", payload);
      console.log(`[EventCaptureTool] Emitted 'event_contact_triggered' & 'conversation:contact_ready' to socket ${socket.id}`);
    } else {
      console.warn("[EventCaptureTool] Socket reference was null; could not emit event_contact_triggered");
    }

    return JSON.stringify({
      ok: true,
      message: "Contact details marked complete in draft without interrupting active listening.",
      captured: {
        name: attendeeName,
        phone: cleanPhone,
        companyName,
        designation,
      },
    });
  };

  return {
    name: "trigger_contact_review",
    description: EVENT_CAPTURE_TOOL_DECLARATION.description,
    invoke: handler,
    execute: handler,
  };
};
