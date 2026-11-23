import { z } from "zod";

/**
 * Validation schemas for Module operations.
 */
export const createItemSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Name is required").trim(),
    description: z.string().optional().default(""),
    status: z.enum(["active", "inactive", "pending"]).optional().default("active"),
  }),
});

export const updateItemSchema = z.object({
  params: z.object({
    id: z.string().min(1, "Valid identifier is required"),
  }),
  body: z.object({
    name: z.string().min(1).trim().optional(),
    description: z.string().optional(),
    status: z.enum(["active", "inactive", "pending"]).optional(),
  }),
});

export const queryItemsSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).optional().default("1"),
    limit: z.string().regex(/^\d+$/).optional().default("10"),
    search: z.string().optional().default(""),
    status: z.string().optional(),
  }),
});
