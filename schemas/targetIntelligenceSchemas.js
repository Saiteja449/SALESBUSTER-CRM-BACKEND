import { z } from "zod";

/**
 * Zod validation schemas for Target Intelligence B2B Discovery.
 */
export const interpretPromptSchema = z.object({
  body: z.object({
    prompt: z
      .string({ required_error: "Prompt string is required." })
      .min(1, "Prompt string must not be empty.")
      .trim(),
  }),
});

export const searchProspectsSchema = z.object({
  body: z
    .object({
      prompt: z.string().trim().optional().default(""),
      city: z.string().trim().optional().default("All"),
      industry: z.string().trim().optional().default(""),
      need: z.string().trim().optional().default(""),
      roles: z.array(z.string()).optional().default([]),
      searchType: z.string().trim().optional().default("all"),
      limit: z.union([z.number(), z.string()]).optional().default(10),
    })
    .passthrough(),
});

export const resolveProspectSchema = z.object({
  body: z.object({
    prospect: z
      .object({
        companyName: z.string().min(1, "Company name is required on prospect."),
      })
      .passthrough(),
    notes: z.string().trim().optional().default(""),
  }),
});

export const unresolveProspectSchema = z.object({
  body: z
    .object({
      prospectKey: z.string().trim().optional(),
      companyId: z.string().trim().optional(),
    })
    .refine((data) => data.prospectKey || data.companyId, {
      message: "Either prospectKey or companyId is required to unresolve.",
    }),
});

export const bulkResolveSchema = z.object({
  body: z.object({
    prospects: z.array(z.any()).min(1, "At least one prospect is required for bulk resolution."),
    notes: z.string().trim().optional().default(""),
  }),
});

export const exportProspectsSchema = z.object({
  body: z.object({
    prospects: z.array(z.any()).min(1, "No prospects selected for export."),
    format: z.enum(["xlsx", "csv"]).optional().default("xlsx"),
  }),
});

export const createTargetListSchema = z.object({
  body: z.object({
    name: z.string({ required_error: "List name is required." }).min(1, "List name must not be empty.").trim(),
    description: z.string().trim().optional().default(""),
    companyIds: z.array(z.string()).optional().default([]),
  }),
});

export const updateTargetListSchema = z.object({
  params: z.object({
    id: z.string().min(1, "Target List ID is required."),
  }),
  body: z
    .object({
      name: z.string().trim().optional(),
      description: z.string().trim().optional(),
      companyIds: z.array(z.string()).optional(),
      addCompanyId: z.string().trim().optional(),
      removeCompanyId: z.string().trim().optional(),
    })
    .passthrough(),
});

export default {
  interpretPromptSchema,
  searchProspectsSchema,
  resolveProspectSchema,
  unresolveProspectSchema,
  bulkResolveSchema,
  exportProspectsSchema,
  createTargetListSchema,
  updateTargetListSchema,
};
