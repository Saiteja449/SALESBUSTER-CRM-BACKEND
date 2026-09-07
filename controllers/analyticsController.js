import TelecallerAnalytics from "../models/TelecallerAnalytics.js";

// Logs a single call and increments daily analytics
export const logCall = async (req, res) => {
  try {
    const { salesperson, date, duration, callType, status } = req.body;

    if (!salesperson || !date) {
      return res.status(400).json({
        success: false,
        message: "Salesperson and date are required.",
      });
    }

    const durationNum = parseInt(duration) || 0;

    const update = {
      $inc: {
        totalCalls: 1,
        talkTime: durationNum,
      },
      $max: {
        longestCall: durationNum,
      },
    };

    if (callType === "incoming") update.$inc.incoming = 1;
    if (callType === "outgoing") update.$inc.outgoing = 1;

    if (status === "missed") update.$inc.missed = 1;
    if (status === "connected") update.$inc.connected = 1;
    if (status === "rejected") update.$inc.rejected = 1;
    if (status === "not-connected") update.$inc.notConnected = 1;

    // Use upsert to create the document if it doesn't exist
    const analytics = await TelecallerAnalytics.findOneAndUpdate(
      { salesperson, date },
      update,
      { new: true, upsert: true },
    );

    res.status(200).json({ success: true, data: analytics });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Gets daily analytics for a salesperson
export const getAnalyticsBySalesperson = async (req, res) => {
  try {
    const { salesperson } = req.params;

    // Fetch last 7 days of records sorted by date descending
    const analytics = await TelecallerAnalytics.find({ salesperson })
      .sort({ date: -1 })
      .limit(7);

    res.status(200).json({ success: true, data: analytics });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Gets today's analytics for all salespeople
export const getTodayAnalyticsForAll = async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const analytics = await TelecallerAnalytics.find({ date: today });
    res.status(200).json({ success: true, data: analytics });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

import AILimit from "../models/AILimit.js";

// Gets current AI (Groq) rate limits from database
export const getAILimits = async (req, res) => {
  try {
    const limit = await AILimit.findOne().sort({ lastUpdated: -1 });
    if (!limit) {
      return res.status(200).json({
        success: true,
        data: {
          remainingRequests: "N/A",
          remainingTokens: "N/A",
          resetRequests: "N/A",
          resetTokens: "N/A",
        },
      });
    }
    res.status(200).json({ success: true, data: limit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Fetches limits from API, saves to MongoDB, and returns them
export const refreshAILimits = async (req, res) => {
  try {
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res
        .status(200)
        .json({ success: false, message: "No Groq API Key found" });
    }

    // Call the Groq API to get headers
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      return res.status(500).json({
        success: false,
        message: `Failed to fetch limits: ${response.status} ${errText}`,
      });
    }

    const remainingRequests =
      response.headers.get("x-ratelimit-remaining-requests") || "N/A";
    const remainingTokens =
      response.headers.get("x-ratelimit-remaining-tokens") || "N/A";
    const resetRequests =
      response.headers.get("x-ratelimit-reset-requests") || "N/A";
    const resetTokens =
      response.headers.get("x-ratelimit-reset-tokens") || "N/A";

    let limit = await AILimit.findOne();
    if (!limit) {
      limit = new AILimit();
    }

    limit.remainingRequests = remainingRequests;
    limit.remainingTokens = remainingTokens;
    limit.resetRequests = resetRequests;
    limit.resetTokens = resetTokens;
    limit.lastUpdated = new Date();

    await limit.save();

    res.status(200).json({
      success: true,
      data: limit,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
