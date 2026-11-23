import { ZodError } from "zod";

/**
 * Validates req.body, req.query, or req.params using a Zod schema.
 * Replaces unvalidated request properties with clean, parsed and typed data.
 */
export const validateRequest = (schema) => (req, res, next) => {
  try {
    const parsed = schema.parse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    if (parsed.body) req.body = parsed.body;
    if (parsed.query) req.query = parsed.query;
    if (parsed.params) req.params = parsed.params;

    next();
  } catch (err) {
    if (err instanceof ZodError || err.name === "ZodError") {
      const issues = err.issues || err.errors || [];
      const formattedErrors = issues.map((e) => ({
        path: Array.isArray(e.path) ? e.path.join(".") : String(e.path || ""),
        message: e.message,
      }));

      return res.status(400).json({
        success: false,
        message: "Request validation failed. Please check your input parameters.",
        code: "VALIDATION_FAILED",
        errors: formattedErrors,
      });
    }
    next(err);
  }
};

export default validateRequest;
