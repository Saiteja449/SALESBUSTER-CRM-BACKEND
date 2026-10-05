/**
 * Phone Number Validation and Normalization Helper
 * Enforces standardized E.164 phone formats and builds safe queries for uniqueness verification.
 */

/**
 * Validates and normalizes an input phone number.
 *
 * @param {string} rawPhone - Raw phone number string from request
 * @returns {{ isValid: boolean, normalized: string, cleanDigits: string, error?: string }}
 */
export const validateAndNormalizePhone = (rawPhone) => {
  if (!rawPhone || typeof rawPhone !== "string" || !rawPhone.trim()) {
    return {
      isValid: false,
      normalized: "",
      cleanDigits: "",
      error: "Please provide a valid mobile number.",
    };
  }

  const trimmed = rawPhone.trim();
  const cleanDigits = trimmed.replace(/\D/g, "");

  // Length constraint: E.164 requires 10 to 15 digits
  if (cleanDigits.length < 10 || cleanDigits.length > 15) {
    return {
      isValid: false,
      normalized: "",
      cleanDigits,
      error: "Mobile number must be between 10 and 15 digits.",
    };
  }

  // Reject dummy repeating digits (e.g. 0000000000, 1111111111)
  if (/^(\d)\1+$/.test(cleanDigits)) {
    return {
      isValid: false,
      normalized: "",
      cleanDigits,
      error: "Invalid mobile number. Repeating dummy numbers are not allowed.",
    };
  }

  let normalized = "";

  // 10-digit number (Default Indian standard mobile)
  if (cleanDigits.length === 10) {
    normalized = `+91${cleanDigits}`;
  }
  // 11 digits starting with 0 (e.g. 09876543210)
  else if (cleanDigits.length === 11 && cleanDigits.startsWith("0")) {
    normalized = `+91${cleanDigits.slice(1)}`;
  }
  // 12 digits starting with 91 (e.g. 919876543210)
  else if (cleanDigits.length === 12 && cleanDigits.startsWith("91")) {
    normalized = `+${cleanDigits}`;
  }
  // Already has country code
  else {
    normalized = `+${cleanDigits}`;
  }

  return {
    isValid: true,
    normalized,
    cleanDigits,
  };
};

/**
 * Builds a MongoDB query to catch duplicate phone numbers regardless of formatting
 * (e.g. "+91 98765 43210", "9876543210", "+919876543210").
 *
 * @param {string} normalized - The normalized phone (e.g. +919876543210)
 * @param {string} cleanDigits - Just the raw digits
 * @param {string} [excludeUserId] - Optional user ID to exclude (for updates)
 * @returns {object} MongoDB query object
 */
export const buildPhoneDuplicateQuery = (normalized, cleanDigits, excludeUserId = null) => {
  const last10 = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;

  const query = {
    $or: [
      { phone: normalized },
      { phone: cleanDigits },
      { phone: `+${cleanDigits}` },
      { phone: new RegExp(`${last10}$`) },
    ],
  };

  if (excludeUserId) {
    query._id = { $ne: excludeUserId };
  }

  return query;
};
