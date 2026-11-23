import { z } from "zod";

/**
 * Zod validation schemas for Captured Conversations & Extracted Contacts.
 */
export const queryConversationsSchema = z.object({
  query: z
    .object({
      page: z.string().regex(/^\d+$/).optional().default("1"),
      limit: z.string().regex(/^\d+$/).optional().default("20"),
    })
    .passthrough(),
});

export const confirmContactSchema = z.object({
  params: z.object({
    id: z.string().min(1, "Conversation ID or Session ID is required."),
  }),
  body: z
    .object({
      name: z.string().trim().optional(),
      phone: z.string().trim().optional(),
      company: z.string().trim().optional(),
      designation: z.string().trim().optional(),
      createEventContactRecord: z.boolean().optional().default(true),
    })
    .passthrough(),
});

export default {
  queryConversationsSchema,
  confirmContactSchema,
};
