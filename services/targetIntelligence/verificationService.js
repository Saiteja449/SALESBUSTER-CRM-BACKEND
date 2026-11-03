import dns from "node:dns/promises";

const ROLE_BASED_PREFIXES = new Set([
  "info",
  "sales",
  "contact",
  "support",
  "help",
  "admin",
  "hello",
  "enquiry",
  "office",
  "service",
  "billing",
  "careers",
  "jobs",
  "hr",
  "team",
  "mail",
]);

/**
 * Clean and normalize a domain from URL or email
 */
export function normalizeDomain(urlOrDomain) {
  if (!urlOrDomain || typeof urlOrDomain !== "string") return "";
  try {
    let clean = urlOrDomain.trim().toLowerCase();
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      clean = `http://${clean}`;
    }
    const parsed = new URL(clean);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return urlOrDomain
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .split("@")
      .pop()
      .trim();
  }
}

/**
 * Verify and inspect an email address
 */
export async function verifyEmail(email, skipDns = false) {
  if (!email || typeof email !== "string") {
    return {
      email: "",
      isValidFormat: false,
      isRoleBased: false,
      mxValid: false,
      status: "Not Found",
      type: "none",
    };
  }

  const trimmed = email.trim().toLowerCase();

  // Basic RFC / syntax check
  const emailRegex = /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$/;
  if (!emailRegex.test(trimmed)) {
    return {
      email: trimmed,
      isValidFormat: false,
      isRoleBased: false,
      mxValid: false,
      status: "Invalid",
      type: "none",
    };
  }

  // Filter out placeholder / dummy emails
  if (/^(none|na|null|undefined|test@|dummy@|sample@|placeholder@|john\.doe@)/.test(trimmed)) {
    return {
      email: "",
      isValidFormat: false,
      isRoleBased: false,
      mxValid: false,
      status: "Invalid",
      type: "none",
    };
  }

  if (/@(example\.com|test\.com|dummy\.com|fake\.com)$/.test(trimmed)) {
    return {
      email: "",
      isValidFormat: false,
      isRoleBased: false,
      mxValid: false,
      status: "Invalid",
      type: "none",
    };
  }

  const [localPart, domain] = trimmed.split("@");
  const isRoleBased = ROLE_BASED_PREFIXES.has(localPart.toLowerCase());

  let mxValid = false;
  if (!skipDns && domain) {
    try {
      const records = await dns.resolveMx(domain);
      mxValid = Array.isArray(records) && records.length > 0;
    } catch (dnsErr) {
      // DNS resolution failed or no MX
      mxValid = false;
    }
  }

  let status = "unknown";
  if (!skipDns && !mxValid) {
    status = "Invalid";
  }

  return {
    email: trimmed,
    isValidFormat: true,
    isRoleBased,
    mxValid,
    status, // Ownership/deliverability is unknown without live SMTP verification
    type: isRoleBased ? "role_based" : "direct",
  };
}

/**
 * Normalize and verify an Indian or international phone number
 */
export function normalizeAndVerifyPhone(phone, defaultCountryCode = "+91") {
  if (!phone || typeof phone !== "string") {
    return {
      phone: "",
      normalized: "",
      isValidFormat: false,
      phoneType: "none",
      status: "Not Found",
    };
  }

  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");

  // Ignore too short or dummy patterns
  if (digits.length < 8) {
    return {
      phone: "",
      normalized: "",
      isValidFormat: false,
      phoneType: "none",
      status: "Invalid",
    };
  }

  if (/00000|11111|22222|33333|44444|55555|66666|77777|88888|99999|123456/.test(digits)) {
    return {
      phone: "",
      normalized: "",
      isValidFormat: false,
      phoneType: "none",
      status: "Invalid",
    };
  }

  let normalized = trimmed;
  let phoneType = "corporate";

  // Check Indian format
  if (digits.length === 10) {
    // 10-digit mobile or landline
    const firstDigit = digits[0];
    if (["6", "7", "8", "9"].includes(firstDigit)) {
      phoneType = "mobile";
      normalized = `${defaultCountryCode} ${digits.slice(0, 5)} ${digits.slice(5)}`;
    } else {
      phoneType = "landline";
      normalized = `${defaultCountryCode} ${digits.slice(0, 3)} ${digits.slice(3)}`;
    }
  } else if (digits.length === 12 && digits.startsWith("91")) {
    const raw10 = digits.slice(2);
    if (["6", "7", "8", "9"].includes(raw10[0])) {
      phoneType = "mobile";
    } else {
      phoneType = "landline";
    }
    normalized = `+91 ${raw10.slice(0, 5)} ${raw10.slice(5)}`;
  } else if (digits.length === 11 && digits.startsWith("0")) {
    const raw10 = digits.slice(1);
    if (["6", "7", "8", "9"].includes(raw10[0])) {
      phoneType = "mobile";
    } else {
      phoneType = "landline";
    }
    normalized = `${defaultCountryCode} ${raw10.slice(0, 5)} ${raw10.slice(5)}`;
  } else if (trimmed.startsWith("+")) {
    normalized = trimmed;
    phoneType = "corporate";
  }

  return {
    phone: trimmed,
    normalized,
    isValidFormat: true,
    phoneType,
    status: "unknown", // Format valid, but ownership/line verification is unknown
  };
}

