/**
 * Centralized Global Error Handler for SalesBuster CRM.
 * Catches all operational and unexpected errors, standardizes response formats,
 * and prevents sensitive stack traces from leaking in production.
 */
export const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || "An unexpected internal server error occurred.";
  let code = err.code || "INTERNAL_SERVER_ERROR";
  let details = err.details || null;

  // 1. Mongoose Validation Error (e.g. required fields, enum mismatch)
  if (err.name === "ValidationError") {
    statusCode = 400;
    code = "VALIDATION_ERROR";
    message = "Database schema validation failed.";
    details = Object.values(err.errors || {}).map((e) => e.message);
  }

  // 2. Mongoose Cast Error (e.g. invalid ObjectId format)
  if (err.name === "CastError") {
    statusCode = 400;
    code = "INVALID_IDENTIFIER";
    message = `Invalid format provided for field: ${err.path}`;
  }

  // 3. MongoDB Duplicate Key Error (E11000)
  if (err.code === 11000) {
    statusCode = 409;
    code = "DUPLICATE_ENTRY";
    const duplicateField = Object.keys(err.keyValue || {})[0] || "field";
    message = `A record with this ${duplicateField} already exists.`;
  }

  // 4. JWT Verification & Expiry Errors
  if (err.name === "JsonWebTokenError") {
    statusCode = 401;
    code = "INVALID_TOKEN";
    message = "Authentication token is invalid.";
  } else if (err.name === "TokenExpiredError") {
    statusCode = 401;
    code = "TOKEN_EXPIRED";
    message = "Authentication token has expired. Please sign in again.";
  }

  // 5. Payload too large (Multer / Express body parser)
  if (err.code === "LIMIT_FILE_SIZE") {
    statusCode = 413;
    code = "FILE_TOO_LARGE";
    message = "Uploaded file exceeds maximum allowed size limit.";
  }

  // 6. Logging
  if (statusCode >= 500) {
    console.error(`[SERVER_ERROR] [${req.method} ${req.originalUrl}]:`, err);
  } else {
    console.warn(`[CLIENT_WARN] [${req.method} ${req.originalUrl}] (${statusCode} ${code}):`, message);
  }

  if (res.locals) {
    res.locals.errorMeta = {
      message,
      errorName: err.name || "Error",
      stack: statusCode >= 500 ? err.stack || "" : "",
    };
  }

  res.status(statusCode).json({
    success: false,
    message,
    code,
    ...(details && { details }),
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

export default errorHandler;
