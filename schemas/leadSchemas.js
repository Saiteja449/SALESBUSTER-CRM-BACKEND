import { z } from "zod";

/**
 * Zod validation schemas for Lead operations.
 */
export const createLeadSchema = z.object({
  body: z.object({
    name: z.string().trim().optional().default(""),
    phone: z
      .string({ required_error: "Phone number is required." })
      .min(10, "Phone number must be at least 10 digits.")
      .trim(),
    email: z
      .string()
      .email("Invalid email address format.")
      .trim()
      .optional()
      .or(z.literal("")),
    company: z.string().trim().optional().default(""),
    service: z.string().trim().optional().default("General Enquiry"),
    services: z.array(z.string()).optional().default([]),
    source: z.string().trim().optional().default("Manual Entry"),
    status: z
      .enum([
        "New",
        "Missed Call",
        "Follow Up",
        "Not Interested",
        "Not Attended",
        "Price Issue",
        "Converted",
      ])
      .optional()
      .default("New"),
    assignedTo: z.string().trim().optional(),
    leadType: z.string().trim().optional().default("Client"),
    nextFollowUp: z.string().trim().optional(),
    followupTime: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    city: z.string().trim().optional(),
    preferredContactMethod: z.string().trim().optional(),
  }),
});

export const updateLeadSchema = z.object({
  params: z.object({
    id: z.string().min(1, "Lead ID is required"),
  }),
  body: z
    .object({
      name: z.string().trim().optional(),
      phone: z.string().min(10).trim().optional(),
      email: z
        .string()
        .email("Invalid email address format.")
        .trim()
        .optional()
        .or(z.literal("")),
      company: z.string().trim().optional(),
      service: z.string().trim().optional(),
      services: z.array(z.string()).optional(),
      source: z.string().trim().optional(),
      status: z
        .enum([
          "New",
          "Missed Call",
          "Follow Up",
          "Not Interested",
          "Not Attended",
          "Price Issue",
          "Converted",
        ])
        .optional(),
      assignedTo: z.string().trim().optional(),
      leadType: z.string().trim().optional(),
      nextFollowUp: z.string().trim().optional(),
      followupTime: z.string().trim().optional(),
      notes: z.string().trim().optional(),
      city: z.string().trim().optional(),
    })
    .passthrough(), // allows extra dynamic CRM fields
});

export const queryLeadsSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).optional().default("1"),
    limit: z.string().regex(/^\d+$/).optional().default("10"),
    status: z.string().optional(),
    assignedTo: z.string().optional(),
    source: z.string().optional(),
    search: z.string().optional(),
  }),
});
