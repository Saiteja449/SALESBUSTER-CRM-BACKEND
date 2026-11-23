import { z } from "zod";

/**
 * Zod validation schemas for Cashfree Payment Gateway operations.
 */
export const createCashfreeOrderSchema = z.object({
  body: z.object({
    purpose: z.enum(["subscription", "addon", "wallet_credits", "service"]).optional().default("addon"),
    planId: z.string().trim().optional().default(""),
    addonType: z.string().trim().optional().default(""),
    orderAmount: z.union([z.number(), z.string()]).optional(),
    orderNote: z.string().trim().optional().default(""),
    customerDetails: z
      .object({
        customerId: z.string().trim().optional(),
        customerName: z.string().trim().optional(),
        customerEmail: z.string().email().optional().or(z.literal("")),
        customerPhone: z.string().trim().optional(),
      })
      .optional()
      .default({}),
    returnUrl: z.string().trim().optional().default(""),
  }),
});

export const queryOrdersSchema = z.object({
  query: z
    .object({
      page: z.string().regex(/^\d+$/).optional().default("1"),
      limit: z.string().regex(/^\d+$/).optional().default("20"),
      status: z.enum(["all", "paid", "active", "pending", "failed", "PAID", "ACTIVE", "PENDING", "FAILED"]).optional(),
      search: z.string().trim().optional(),
      organizationId: z.string().trim().optional(),
    })
    .passthrough(),
});

export default {
  createCashfreeOrderSchema,
  queryOrdersSchema,
};
