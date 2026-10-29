/**
 * Event Contact Capture Tool for Gemini Multimodal Live API
 * Triggers the client mobile review popup in real-time when attendee details are spoken.
 */

export const EVENT_CAPTURE_TOOL_DECLARATION = {
  name: "trigger_contact_review",
  description:
    "Triggers the mobile review popup with pre-filled fields as soon as attendee contact details (name, 10-digit phone number, company, and topic) are identified from the live conversation.",
  parameters: {
    type: "OBJECT",
    properties: {
      name: {
        type: "STRING",
        description: "Customer or attendee full name. Leave empty string if not mentioned.",
      },
      phone: {
        type: "STRING",
        description: "10-digit mobile number spoken. Extract only digits. Leave empty string if not spoken.",
      },
      companyName: {
        type: "STRING",
        description: "Company, organization, or business name mentioned. Leave empty string if not mentioned.",
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
    required: ["name"],
  },
};

export const createEventCaptureTool = ({ socket, eventId, eventName, user, organization }) => {
  return {
    name: "trigger_contact_review",
    description: EVENT_CAPTURE_TOOL_DECLARATION.description,
    execute: async (args = {}) => {
      const repName = user?.name || "Sales Manager";
      const orgName = organization?.name || "Our Team";
      const currentEvent = eventName || "our event";

      // Normalize phone number (extract last 10 digits if valid Indian number)
      let cleanPhone = "";
      if (args.phone) {
        const digits = String(args.phone).replace(/\D/g, "");
        if (digits.length >= 10) {
          cleanPhone = digits.slice(-10);
        }
      }

      const attendeeName = (args.name || "").trim();
      const companyName = (args.companyName || "").trim();
      const summary = (args.summary || "").trim();

      const defaultMessage =
        `Hello ${attendeeName || "there"},\n\n` +
        `It was great speaking with you${companyName ? ` from ${companyName}` : ""} at ${currentEvent}.\n` +
        `Feel free to reach out to me directly on WhatsApp whenever you need any assistance!\n\n` +
        `Best regards,\n` +
        `*${repName}*\n` +
        `${orgName}`;

      const messageText = (args.suggestedMessage || defaultMessage).trim();

      const payload = {
        eventId: eventId || null,
        eventName: currentEvent,
        name: attendeeName,
        phone: cleanPhone,
        companyName,
        summary,
        messageText,
        triggeredAt: new Date().toISOString(),
      };

      console.log(
        `[EventCaptureTool] trigger_contact_review executed for socket ${socket?.id}: ${attendeeName} (${cleanPhone || "no-phone"})`
      );

      // Emit event directly to the mobile client
      if (socket) {
        socket.emit("event_contact_triggered", payload);
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
    },
  };
};

