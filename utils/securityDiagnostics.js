/**
 * Diagnostics utility for Meta Webhook HMAC security enforcement
 */
export const getWebhookSecurityDiagnostics = () => {
  const isProd = (process.env.NODE_ENV || "").toLowerCase() === "production";
  const hasSecret = Boolean(process.env.META_APP_SECRET);
  return {
    metaAppSecretConfigured: hasSecret,
    environment: process.env.NODE_ENV || "development",
    webhookSignatureEnforcement: isProd
      ? "strict"
      : hasSecret
      ? "strict"
      : "permissive_dev",
    status: isProd && !hasSecret ? "misconfigured" : "healthy",
  };
};

export const logStartupDiagnostics = () => {
  const diag = getWebhookSecurityDiagnostics();
  if (diag.status === "misconfigured") {
    console.error(
      "==================================================================\n" +
      "[SECURITY FATAL] META_APP_SECRET is NOT set in production!\n" +
      "Incoming Meta Webhook requests will fail closed (HTTP 401).\n" +
      "=================================================================="
    );
  } else if (!diag.metaAppSecretConfigured) {
    console.warn(
      "[SECURITY WARNING] META_APP_SECRET is not configured in development mode. " +
      "Webhook HMAC validation is permissive for local development. Configure META_APP_SECRET for production."
    );
  } else {
    console.log("[SECURITY] Meta Webhook HMAC-SHA256 signature validation is active and enforced.");
  }
};

