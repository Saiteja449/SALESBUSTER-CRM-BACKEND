/**
 * Standardized API response formatters for SalesBuster CRM.
 * Ensures consistent JSON structure across all existing and future modules.
 */

export const sendSuccess = (
  res,
  { statusCode = 200, message = "Success", data = null, meta = null } = {}
) => {
  return res.status(statusCode).json({
    success: true,
    message,
    ...(data !== null && { data }),
    ...(meta !== null && { meta }),
  });
};

export const sendPaginated = (
  res,
  { data = [], total = 0, page = 1, limit = 10, message = "Data retrieved successfully", meta = null } = {}
) => {
  const numericLimit = Math.max(1, Number(limit) || 10);
  const numericPage = Math.max(1, Number(page) || 1);
  const totalPages = Math.ceil(total / numericLimit) || 1;

  return res.status(200).json({
    success: true,
    message,
    data,
    pagination: {
      total: Number(total),
      page: numericPage,
      limit: numericLimit,
      totalPages,
      hasNext: numericPage < totalPages,
      hasPrev: numericPage > 1,
    },
    ...(meta !== null && { meta }),
  });
};
