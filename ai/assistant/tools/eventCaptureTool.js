/**
 * Event Contact Capture Tool for Gemini Multimodal Live API
 * Triggers the client mobile review popup in real-time when attendee details are spoken.
 */

export const EVENT_CAPTURE_TOOL_DECLARATION = {
  name: "trigger_contact_review",
  description:
    "Triggers the mobile review popup ONLY after all key attendee contact details are completely captured: full name, complete 10-digit mobile phone number, and company name.",
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

export const createEventCaptureTool = ({ socket, eventId, eventName, user, organization }) => {
  const handler = async (args = {}) => {
    const repName = user?.name || "Sales Manager";
    const orgName = organization?.name || "Our Team";
    const currentEvent = eventName || "our event";

    // Normalize phone number (must be a valid 10-digit number)
    let cleanPhone = "";
    if (args.phone) {
      const digits = String(args.phone).replace(/\D/g, "");
      if (digits.length >= 10) {
        cleanPhone = digits.slice(-10);
      }
    }

    const rawName = (args.name || "").trim();
    const companyName = (args.companyName || "").trim();
    const summary = (args.summary || "").trim();

    // STRICT VALIDATION: Require full name, complete 10-digit phone, and company before triggering popup
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
      summary,
      messageText,
      triggeredAt: new Date().toISOString(),
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
