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
 * Formats standard paginated response envelope
 */
export const formatPaginatedResponse = ({
  totalCount = 0,
  page = 1,
  limit = 10,
  records = [],
  summary = null,
  filtersApplied = {},
  coverage = "complete",
  message = "",
}) => {
  const returnedCount = Array.isArray(records) ? records.length : 0;
  const totalPages = Math.ceil(totalCount / limit) || (totalCount > 0 ? 1 : 0);
  const hasMore = page < totalPages;

  return {
    success: true,
    dataCoverage: coverage,
    totalCount,
    totalMatchingCount: totalCount,
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
    ...(message ? { message } : {}),
  };
};
