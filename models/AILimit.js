import mongoose from "mongoose";

const aiLimitSchema = new mongoose.Schema({
  remainingRequests: { type: String, default: "N/A" },
  remainingTokens: { type: String, default: "N/A" },
  resetRequests: { type: String, default: "N/A" },
  resetTokens: { type: String, default: "N/A" },
  lastUpdated: { type: Date, default: Date.now },
});

const AILimit = mongoose.model("AILimit", aiLimitSchema);

export default AILimit;
