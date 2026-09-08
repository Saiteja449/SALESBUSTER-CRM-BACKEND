import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 12 bytes recommended for AES-GCM

/**
 * Derives a consistent 32-byte key for AES-256 using SHA-256
 */
const getDerivedKey = () => {
  const secret =
    process.env.ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    "salesbuster_gemini_api_key_secret_salt_2026";
  return crypto.createHash("sha256").update(secret).digest();
};

/**
 * Encrypts plaintext string using AES-256-GCM.
 * Output format: <ivHex>:<authTagHex>:<encryptedHex>
 * @param {string} plainText
 * @returns {string} Encrypted ciphertext
 */
export const encryptApiKey = (plainText) => {
  if (!plainText || typeof plainText !== "string") return "";
  const trimmed = plainText.trim();
  if (!trimmed) return "";

  // If already encrypted (format: iv:authTag:encrypted with hex chars), avoid re-encrypting
  if (/^[0-9a-fA-F]{24}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$/.test(trimmed)) {
    return trimmed;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getDerivedKey(), iv);

  let encrypted = cipher.update(trimmed, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
};

/**
 * Decrypts AES-256-GCM ciphertext back to plaintext.
 * Handles legacy unencrypted strings gracefully.
 * @param {string} cipherText
 * @returns {string} Plaintext decrypted API key
 */
export const decryptApiKey = (cipherText) => {
  if (!cipherText || typeof cipherText !== "string") return "";
  const trimmed = cipherText.trim();
  if (!trimmed) return "";

  const parts = trimmed.split(":");
  if (parts.length !== 3) {
    // If not in iv:authTag:encrypted format, it may be legacy plaintext
    return trimmed;
  }

  try {
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, getDerivedKey(), iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err) {
    console.error("[Encryption] Failed to decrypt API key:", err.message);
    return "";
  }
};

/**
 * Generates safe display mask for UI or logging e.g. AIzaSy••••••••1234
 * @param {string} plainText
 * @returns {string} Masked string
 */
export const maskApiKey = (plainText) => {
  if (!plainText || typeof plainText !== "string") return "";
  const trimmed = plainText.trim();
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 6)}••••••••${trimmed.slice(-4)}`;
};
