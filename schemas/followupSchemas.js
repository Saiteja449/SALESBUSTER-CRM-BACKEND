import { z } from "zod";

/**
 * Zod validation schemas for Follow-up operations.
 */
export const createFollowupSchema = z.object({
  body: z.object({
    leadId: z
      .string({ required_error: "leadId is required." })
      .min(1, "leadId must not be empty.")
      .trim(),
    leadName: z.string().trim().optional().default(""),
    type: z.string().trim().optional().default("Call"),
    date: z
      .string({ required_error: "Follow-up date is required." })
      .min(1, "Follow-up date must not be empty.")
      .trim(),
    time: z.string().trim().optional().default("10:00 AM"),
    priority: z
      .enum(["Low", "Medium", "High"])
      .optional()
      .default("Medium"),
    notes: z.string().trim().optional().default("Follow-up scheduled"),
    author: z.string().trim().optional(),
    done: z.boolean().optional().default(false),
    isAI: z.boolean().optional().default(false),
  }),
});

export const updateFollowupSchema = z.object({
  params: z.object({
    id: z.string().min(1, "Follow-up ID is required."),
  }),
  body: z
    .object({
      done: z.boolean().optional(),
      notes: z.string().trim().optional(),
      date: z.string().trim().optional(),
      time: z.string().trim().optional(),
      priority: z.enum(["Low", "Medium", "High"]).optional(),
      type: z.string().trim().optional(),
    })
    .passthrough(),
});

export const queryFollowupsSchema = z.object({
  query: z
    .object({
      leadId: z.string().trim().optional(),
      date: z.string().trim().optional(),
      done: z.enum(["true", "false"]).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
    })
    .passthrough(),
});

export default {
  createFollowupSchema,
  updateFollowupSchema,
  queryFollowupsSchema,
};
