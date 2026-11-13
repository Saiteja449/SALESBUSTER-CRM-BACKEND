import { escapeRegex } from "../securityUtils.js";

/**
 * Validates and normalizes common analytics query parameters
 */
export const validateAnalyticsQuery = ({
  page = 1,
  limit = 10,
  maxLimit = 100,
  searchTerm = "",
  status = "",
  callType = "",
  callStatus = "",
}) => {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), maxLimit);
  const skip = (safePage - 1) * safeLimit;

  return {
    page: safePage,
    limit: safeLimit,
    skip,
    safeSearchTerm: searchTerm && typeof searchTerm === "string" ? escapeRegex(searchTerm.trim()) : "",
    safeStatus: status && typeof status === "string" ? status.trim() : "",
    safeCallType: callType && typeof callType === "string" ? callType.toLowerCase().trim() : "",
    safeCallStatus: callStatus && typeof callStatus === "string" ? callStatus.toLowerCase().trim() : "",
  };
};

/**
 * Formats standard paginated response envelope conforming to BI Analyst tool result contracts
 */
export const formatPaginatedResponse = ({
  success = true,
  totalCount = 0,
  page = 1,
  limit = 10,
  records = [],
  summary = null,
  filtersApplied = {},
  coverage = "complete",
  errorCode = null,
  message = "",
  timezone = "Asia/Kolkata",
  coverageWarnings = [],
}) => {
  const returnedCount = Array.isArray(records) ? records.length : 0;
  const totalPages = Math.ceil(totalCount / limit) || (totalCount > 0 ? 1 : 0);
  const hasMore = page < totalPages;
  const periodEvaluated = filtersApplied?.period || summary?.periodEvaluated || "All Time";
  const warningsList = Array.isArray(coverageWarnings)
    ? [...coverageWarnings]
    : coverageWarnings
    ? [String(coverageWarnings)]
    : [];

  return {
    success: Boolean(success),
    coverage,
    dataCoverage: coverage,
    errorCode,
    periodEvaluated,
    timezone,
    totalMatchingCount: totalCount,
    totalCount,
    returnedCount,
    showingCount: returnedCount,
    page,
    totalPages,
    limit,
    hasMore,
    continuationHint: hasMore
      ? `Showing page ${page} of ${totalPages}. Call the same tool with page: ${page + 1} to inspect additional records.`
      : "All matching records have been retrieved.",
    filtersApplied,
    ...(summary ? { summary } : {}),
    records,
    leads: records,
    coverageWarnings: warningsList,
    warnings: warningsList,
    ...(message ? { message } : {}),
  };
};
