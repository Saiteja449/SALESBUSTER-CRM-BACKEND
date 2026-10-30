/**
 * Phone number normalization utilities for WhatsApp Cloud API & CRM.
 */

/**
 * Derives a canonical international phone number (digits only, no leading +)
 * suitable for sending via Meta WhatsApp Cloud API.
 *
 * Rules:
 *  - 10 digits (Indian standard national number) -> prefixes "91" (e.g., 9876543210 -> 919876543210)
 *  - 11 digits starting with "0" (STD format) -> strips leading "0", prefixes "91" (e.g., 09876543210 -> 919876543210)
 *  - 12 digits starting with "91" -> preserved as-is without double-prefixing (e.g., 919876543210 -> 919876543210)
 *  - Already-prefixed international numbers (e.g. +14155552671 -> 14155552671, +447911123456 -> 447911123456)
 *    are preserved without prepending 91.
 */
export const toInternationalPhone = (rawPhone) => {
  if (!rawPhone) return "";
  const digits = String(rawPhone).replace(/\D/g, "");

  // Already has Indian country code exactly (91 + 10 digits = 12 digits)
  if (digits.startsWith("91") && digits.length === 12) {
    return digits;
  }

  // Indian local number (10 digits)
  if (digits.length === 10) {
    return `91${digits}`;
  }

  // Local number with leading 0 (0 + 10 digits = 11 digits)
  if (digits.startsWith("0") && digits.length === 11) {
    return `91${digits.slice(1)}`;
  }

  // Already has international country code (>= 11 digits not starting with 0) or non-standard format
  return digits;
};

/**
 * Strips country code for local 10-digit database lead matching.
 */
export const normalizePhoneDigits = (rawPhone) => {
  if (!rawPhone) return "";
  let digits = String(rawPhone).replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0") && digits.length === 11) {
    digits = digits.slice(1);
  }
  return digits;
};

