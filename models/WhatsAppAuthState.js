import mongoose from "mongoose";

const whatsappAuthStateSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      index: true,
    },
    type: {
      type: String,
      required: true, // "creds" or "keys"
    },
    keyId: {
      type: String,
      required: true, // "app-state-sync-key-..." or "creds"
    },
    data: {
      type: String, // Stored as a JSON string for easy parsing of BufferJSON
      required: true,
    },
  },
  { timestamps: true },
);

// Ensure we don't have duplicate keys per session
whatsappAuthStateSchema.index(
  { sessionId: 1, type: 1, keyId: 1 },
  { unique: true },
);

const WhatsAppAuthState = mongoose.model(
  "WhatsAppAuthState",
  whatsappAuthStateSchema,
);

export default WhatsAppAuthState;
