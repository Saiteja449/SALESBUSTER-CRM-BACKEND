import { z } from "zod";

/**
 * Zod validation schemas for Event and EventContact operations.
 */
export const createEventSchema = z.object({
  body: z
    .object({
      name: z.string({ required_error: "Event name is required." }).min(1, "Event name must not be empty.").trim(),
      venue: z.string().trim().optional().default(""),
      location: z.string().trim().optional().default(""),
      eventDate: z.string().trim().optional(),
      time: z.string().trim().optional().default(""),
      whatsappTemplate: z.string().trim().optional().default(""),
      customMessage: z.string().trim().optional().default(""),
      description: z.string().trim().optional().default(""),
      status: z.enum(["active", "completed", "archived"]).optional().default("active"),
      attachments: z.any().optional(),
    })
    .passthrough(),
});

export const updateEventSchema = z.object({
  params: z.object({
    id: z.string().min(1, "Event ID is required."),
  }),
  body: z
    .object({
      name: z.string().trim().optional(),
      venue: z.string().trim().optional(),
      location: z.string().trim().optional(),
      eventDate: z.string().trim().optional(),
      time: z.string().trim().optional(),
      whatsappTemplate: z.string().trim().optional(),
      customMessage: z.string().trim().optional(),
      description: z.string().trim().optional(),
      status: z.enum(["active", "completed", "archived"]).optional(),
      attachments: z.any().optional(),
    })
    .passthrough(),
});

export const createEventContactSchema = z.object({
  params: z.object({
    id: z.string().min(1, "Event ID is required."),
  }),
  body: z.object({
    name: z.string({ required_error: "Contact name is required." }).min(1, "Contact name must not be empty.").trim(),
    phone: z.string().trim().optional().default(""),
    companyName: z.string().trim().optional().default(""),
    designation: z.string().trim().optional().default(""),
    summary: z.string().trim().optional().default(""),
    messageText: z.string().trim().optional().default(""),
    transcript: z.string().trim().optional().default(""),
    status: z
      .enum(["captured", "whatsapp_opened", "completed", "invalid"])
      .optional()
      .default("captured"),
    attachments: z.any().optional(),
  }),
});

export const updateEventContactStatusSchema = z.object({
  params: z.object({
    id: z.string().min(1, "Event ID is required."),
    contactId: z.string().min(1, "Contact ID is required."),
  }),
  body: z.object({
    status: z.enum(["captured", "whatsapp_opened", "completed", "invalid"]),
  }),
});

export const summarizeTranscriptSchema = z.object({
  body: z.object({
    transcript: z
      .string({ required_error: "Speech transcript text is required." })
      .min(1, "Speech transcript text must not be empty.")
      .trim(),
    eventName: z.string().trim().optional().default("our discussion"),
  }),
});

export const scanBusinessCardSchema = z.object({
  body: z.object({
    imageBase64: z
      .string({ required_error: "Image base64 data is required." })
      .min(1, "Image base64 data must not be empty.")
      .trim(),
    mimeType: z.string().trim().optional().default("image/jpeg"),
  }),
});

export default {
  createEventSchema,
  updateEventSchema,
  createEventContactSchema,
  updateEventContactStatusSchema,
  summarizeTranscriptSchema,
  scanBusinessCardSchema,
};
