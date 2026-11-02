/**
 * Event Contact Capture & Real-Time Interim Tools for Gemini Multimodal Live API
 * Provides live progressive field filling and completed contact review popup triggers.
 */

export const EVENT_INTERIM_TOOL_DECLARATION = {
  name: "update_contact_draft",
  description:
    "Progressively updates attendee contact fields in real time on the sales rep's mobile screen as soon as any detail is spoken (e.g. attendee name, company, phone digits, or discussion topic). Call this immediately whenever any single attribute is heard so fields fill live.",
  parameters: {
    type: "OBJECT",
    properties: {
      name: {
        type: "STRING",
        description: "Attendee full name if heard. Must not be the sales representative.",
      },
      phone: {
        type: "STRING",
        description: "Mobile phone digits spoken. Can be partial or complete.",
      },
      companyName: {
        type: "STRING",
        description: "Attendee company or business name mentioned. Must not be the host organization.",
      },
      designation: {
        type: "STRING",
        description: "Attendee job title, role, or designation if heard (e.g. 'Managing Director', 'CEO', 'Purchasing Head', 'Owner').",
      },
      summary: {
        type: "STRING",
        description: "Progressive notes, requirement, or topic discussed so far.",
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
    "Triggers the completed contact review popup on mobile ONLY after all key attendee contact details are completely captured: full name, complete 10-digit mobile phone number, and company name.",
  parameters: {
    type: "OBJECT",
    properties: {
      name: {
        type: "STRING",
        description: "Customer or attendee full name. Mandatory.",
      },
      phone: {
        type: "STRING",
        description: "10-digit mobile number spoken. Extract only digits. Mandatory. Must be a complete 10-digit number.",
      },
      companyName: {
        type: "STRING",
        description: "Company, organization, or business name mentioned. Mandatory.",
      },
      designation: {
        type: "STRING",
        description: "Job title, role, or designation spoken (e.g. 'Managing Director', 'Owner', 'CEO', 'Operations Head'). Optional if not mentioned.",
      },
      summary: {
        type: "STRING",
        description: "Concise 1-2 sentence summary of what was discussed, their interest, or next steps.",
      },
      suggestedMessage: {
        type: "STRING",
        description:
          "Personalized, professional WhatsApp greeting message ready to send from the sales rep to this contact.",
      },
    },
    required: ["name", "phone", "companyName"],
  },
};

export const createEventInterimTool = ({ socket, eventId, eventName, user, organization }) => {
  const handler = async (args = {}) => {
    const repName = user?.name || "Sales Manager";
    const orgName = organization?.name || "Our Team";
    const repPhone = (user?.phone || "").replace(/\D/g, "").slice(-10);
    const currentEvent = eventName || "our event";

    let cleanPhone = "";
    if (args.phone) {
      const digits = String(args.phone).replace(/\D/g, "");
      if (digits.length >= 10) {
        cleanPhone = digits.slice(-10);
      } else if (digits.length > 0) {
        cleanPhone = digits;
      }
    }

    let rawName = (typeof args.name === 'string' ? args.name : (args.name ? String(args.name) : "")).trim();
    let companyName = (typeof args.companyName === 'string' ? args.companyName : (args.companyName ? String(args.companyName) : "")).trim();
    const designation = (typeof args.designation === 'string' ? args.designation : (args.designation ? String(args.designation) : "")).trim();
    const summary = (typeof args.summary === 'string' ? args.summary : (args.summary ? String(args.summary) : "")).trim();

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
      phone: cleanPhone,
      companyName,
      designation,
      summary,
      messageText: (args.suggestedMessage || "").trim(),
      updatedAt: new Date().toISOString(),
      isComplete: Boolean(rawName && cleanPhone.length === 10 && companyName),
    };

    if (socket) {
      socket.emit("event_contact_interim", payload);
      console.log(`[EventCaptureTool] Emitted 'event_contact_interim' to socket ${socket.id}: Name="${rawName}", Phone="${cleanPhone}", Company="${companyName}", Designation="${designation}"`);
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

    // Normalize phone number (must be a valid 10-digit number)
    let cleanPhone = "";
    if (args.phone) {
      const digits = String(args.phone).replace(/\D/g, "");
      if (digits.length >= 10) {
        cleanPhone = digits.slice(-10);
      }
    }

    const rawName = (typeof args.name === 'string' ? args.name : (args.name ? String(args.name) : "")).trim();
    const companyName = (typeof args.companyName === 'string' ? args.companyName : (args.companyName ? String(args.companyName) : "")).trim();
    const designation = (typeof args.designation === 'string' ? args.designation : (args.designation ? String(args.designation) : "")).trim();
    const summary = (typeof args.summary === 'string' ? args.summary : (args.summary ? String(args.summary) : "")).trim();

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
      socket.emit("event_contact_triggered", payload);
      console.log(`[EventCaptureTool] Emitted 'event_contact_triggered' to socket ${socket.id}`);
    } else {
      console.warn("[EventCaptureTool] Socket reference was null; could not emit event_contact_triggered");
    }

    return JSON.stringify({
      ok: true,
      message: "Contact review popup triggered successfully on rep mobile device.",
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
