import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  handleStaticChatMessage,
  captureWebsiteLeadDirectly,
  recordCalendlyBooking,
  getStaticChatConfig,
  getStaticChatHistory,
  resetStaticChatSession,
} from "../services/staticChatService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const widgetFilePath = path.join(__dirname, "..", "public", "widget.js");

const router = express.Router();

/**
 * @route   GET /api/static-chat/config
 * @desc    Get website chat widget runtime configuration
 * @access  Public
 */
router.get("/config", (req, res) => {
  try {
    const config = getStaticChatConfig();
    return res.status(200).json(config);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/static-chat
 * @desc    Chat with SalesBuster Website AI Bot
 * @access  Public
 */
router.post("/", async (req, res) => {
  try {
    const { message, sessionId, leadDetails } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    const result = await handleStaticChatMessage({
      message,
      sessionId,
      clientLeadDetails: leadDetails,
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("[StaticChat Error]:", error);
    return res.status(500).json({
      error: "An error occurred while generating response.",
      details: error.message,
    });
  }
});

/**
 * @route   POST /api/static-chat/capture-lead
 * @desc    Explicitly submit basic lead details (Name, Company, Mobile, Email, Requirement)
 * @access  Public
 */
router.post("/capture-lead", async (req, res) => {
  try {
    const { sessionId, name, company, mobile, email, requirement } = req.body;
    if (!mobile && !email && !name) {
      return res.status(400).json({ error: "Name, Mobile, or Email is required." });
    }

    const result = await captureWebsiteLeadDirectly({
      sessionId,
      name,
      company,
      mobile,
      email,
      requirement,
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error("[StaticChat capture-lead Error]:", error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/static-chat/calendly-scheduled
 * @desc    Record confirmed Calendly demo booking
 * @access  Public
 */
router.post("/calendly-scheduled", async (req, res) => {
  try {
    const { sessionId, leadId, appointmentDate, appointmentTime, notes } = req.body;
    const result = await recordCalendlyBooking({
      sessionId,
      leadId,
      appointmentDate,
      appointmentTime,
      notes,
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("[StaticChat calendly-scheduled Error]:", error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/static-chat/history
 * @desc    Retrieve chat history for a session
 * @access  Public
 */
router.get("/history", (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }
    const history = getStaticChatHistory(sessionId);
    return res.status(200).json({ history });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/static-chat/reset
 * @desc    Reset conversation history for a session
 * @access  Public
 */
router.post("/reset", (req, res) => {
  try {
    const { sessionId } = req.body;
    if (sessionId) {
      resetStaticChatSession(sessionId);
    }
    return res.status(200).json({ message: "Session reset successfully." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/static-chat/widget.js
 * @desc    Serve embeddable chat widget script
 * @access  Public
 */
router.get("/widget.js", (req, res) => {
  if (fs.existsSync(widgetFilePath)) {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.sendFile(widgetFilePath);
  }
  return res.status(404).send("Widget script not found.");
});

/**
 * @route   GET /api/static-chat/demo
 * @desc    Serve live interactive preview demo page
 * @access  Public
 */
router.get("/demo", (req, res) => {
  const demoFilePath = path.join(__dirname, "..", "public", "demo.html");
  if (fs.existsSync(demoFilePath)) {
    return res.sendFile(demoFilePath);
  }
  return res.status(404).send("Demo page not found.");
});

export default router;
