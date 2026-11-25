import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import dns from "dns";
import mongoose from "mongoose";
import connectDB from "./configs/db.js";
import { corsOptions } from "./configs/corsConfig.js";
import { apiLimiter, authLimiter } from "./middleware/rateLimiter.js";
import errorHandler from "./middleware/errorHandler.js";
import {
  tenantMiddleware,
  checkSubscriptionActive,
} from "./middleware/tenantMiddleware.js";

// Route Imports
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import leadRoutes from "./routes/leadRoutes.js";
import whatsappRoutes from "./routes/whatsappRoutes.js";
import websiteRoutes from "./routes/websiteRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import followupRoutes from "./routes/followupRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import mobileAppRoutes from "./routes/mobileAppRoutes.js";
import organizationRoutes from "./routes/organizationRoutes.js";
import staticChatRoutes from "./routes/staticChatRoutes.js";
import whatsappCloudRoutes from "./routes/whatsappCloudRoutes.js";
import whatsappWebhookRoutes from "./routes/whatsappWebhookRoutes.js";
import appReleaseRoutes from "./routes/appReleaseRoutes.js";
import aiAssistantRoutes from "./routes/aiAssistantRoutes.js";
import supportRoutes from "./routes/supportRoutes.js";
import eventRoutes from "./routes/eventRoutes.js";
import conversationRoutes from "./routes/conversationRoutes.js";
import targetIntelligenceRoutes from "./routes/targetIntelligenceRoutes.js";
import showcaseServiceRoutes from "./routes/showcaseServiceRoutes.js";
import shortUrlRoutes, { redirectShortUrl } from "./routes/shortUrlRoutes.js";
import appGuideVideoRoutes from "./routes/appGuideVideoRoutes.js";
import instagramRoutes from "./routes/instagramRoutes.js";
import marketingRoiRoutes from "./routes/marketingRoiRoutes.js";
import cashfreeRoutes from "./routes/cashfreeRoutes.js";
import developerRoutes from "./routes/developerRoutes.js";
import apiActivityLogger from "./middleware/apiActivityLogger.js";
import { recordApiActivityLog } from "./services/telemetryService.js";

// Socket & WhatsApp Cloud Imports
import { initSocket, getIO } from "./socket/socket.js";
import {
  startBackgroundWorkers,
  stopBackgroundWorkers,
  getBackgroundWorkersStatus,
} from "./services/backgroundTaskManager.js";
import {
  getWebhookSecurityDiagnostics,
  logStartupDiagnostics,
} from "./utils/securityDiagnostics.js";
export { getWebhookSecurityDiagnostics, logStartupDiagnostics };

dotenv.config();

// WhatsApp Cloud API Webhook Security Diagnostics
logStartupDiagnostics();
console.log("Node version:", process.version);
dns.lookup("smtp.gmail.com", { all: true }, (err, addresses) => {
  console.log("DNS Lookup smtp.gmail.com:", err || addresses);
});

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);

// Initialize Socket.io
initSocket(server);

// Get dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middlewares
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(cors(corsOptions));
app.use(apiLimiter);

app.use(
  express.json({
    limit: "25mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Record API requests, latency, user failures, and server errors
app.use(apiActivityLogger);

// Attach tenant-scoped database models and organization metadata
app.use(tenantMiddleware);
app.use(checkSubscriptionActive);

// Serve static uploads
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Mount routes
app.use("/api/organizations", organizationRoutes);
app.use("/api/organization", organizationRoutes);
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/whatsapp/cloud/webhook", whatsappWebhookRoutes);
app.use("/api/meta/webhook", whatsappWebhookRoutes);
app.use("/api/webhooks/meta", whatsappWebhookRoutes);
app.use("/api/whatsapp/cloud", whatsappCloudRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/website", websiteRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/followups", followupRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/mobile-app", mobileAppRoutes);
app.use("/api/mobile-app/apk", appReleaseRoutes);
app.use("/api/app-release", appReleaseRoutes);
app.use("/api/static-chat", staticChatRoutes);
app.use("/api/ai-assistant", aiAssistantRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/target-intelligence", targetIntelligenceRoutes);
app.use("/api/showcase-services", showcaseServiceRoutes);
app.use("/api/instagram", instagramRoutes);
app.use("/api/marketing-roi", marketingRoiRoutes);
app.use("/api/payment/cashfree", cashfreeRoutes);
app.use("/api/s", shortUrlRoutes);
app.use("/api/app-guide-video", appGuideVideoRoutes);
app.use("/api/developer", developerRoutes);

// Top-level public short link redirect
app.get("/s/:code", redirectShortUrl);

// Base route
app.get("/", (req, res) => {
  res.send("SalesBuster CRM Multi-Tenant API is running...");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// 404 Fallback for unhandled API routes
app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    code: "ENDPOINT_NOT_FOUND",
    message: `API route ${req.method} ${req.originalUrl} not found.`,
  });
});

// Centralized Global Error Handler
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

// Graceful application shutdown
const gracefulShutdown = (signal) => {
  console.log(`[Shutdown] Received ${signal}. Initiating graceful shutdown...`);
  server.close(async () => {
    console.log("[Shutdown] HTTP server closed.");
    try {
      await mongoose.connection.close(false);
      console.log("[Shutdown] MongoDB connections closed cleanly.");
    } catch (e) {
      console.error("[Shutdown] Error during MongoDB disconnection:", e.message);
    }
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[Shutdown] Forcefully terminating process after 10s timeout.");
    process.exit(1);
  }, 10000).unref();
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", async (err) => {
  console.error("[CRASH] Uncaught Exception:", err);
  await recordApiActivityLog({
    method: "SYSTEM",
    path: "process/uncaughtException",
    statusCode: 500,
    level: "crash",
    category: "server_crash",
    message: err?.message || "Uncaught Exception",
    errorName: err?.name || "UncaughtException",
    stack: err?.stack || "",
    platform: "admin",
  }).catch(() => {});
});

process.on("unhandledRejection", async (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error("[CRASH] Unhandled Rejection:", err);
  await recordApiActivityLog({
    method: "SYSTEM",
    path: "process/unhandledRejection",
    statusCode: 500,
    level: "crash",
    category: "server_crash",
    message: err?.message || "Unhandled Rejection",
    errorName: err?.name || "UnhandledRejection",
    stack: err?.stack || "",
    platform: "admin",
  }).catch(() => {});
});

const startServer = async () => {
  await connectDB();

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    // Start all periodic background workers and scheduled tasks
    startBackgroundWorkers(getIO());
  });
};

startServer().catch((error) => {
  console.error("Server startup failed:", error);
  process.exit(1);
});
