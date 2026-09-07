import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import dns from "dns";
import connectDB from "./configs/db.js";
import { tenantMiddleware } from "./middleware/tenantMiddleware.js";

// Route Imports
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import leadRoutes from "./routes/leadRoutes.js";
import whatsappRoutes from "./routes/whatsappRoutes.js";
import websiteRoutes from "./routes/websiteRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import metaRoutes from "./routes/metaRoutes.js";
import followupRoutes from "./routes/followupRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import mobileAppRoutes from "./routes/mobileAppRoutes.js";
import organizationRoutes from "./routes/organizationRoutes.js";

// Socket & WhatsApp Imports
import { initSocket } from "./socket/socket.js";
import { connectWhatsApp } from "./whatsapp/whatsappService.js";

dotenv.config();

// Connect to database
connectDB();

console.log("Node version:", process.version);
dns.lookup("smtp.gmail.com", { all: true }, (err, addresses) => {
  console.log("DNS Lookup smtp.gmail.com:", err || addresses);
});

const app = express();
const server = http.createServer(app);

// Initialize Socket.io
initSocket(server);

// Get dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middlewares
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow all origins
      callback(null, true);
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Attach tenant-scoped database models and organization metadata
app.use(tenantMiddleware);

// Serve static uploads
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Mount routes
app.use("/api/organizations", organizationRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/website", websiteRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/meta", metaRoutes);
app.use("/api/followups", followupRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/mobile-app", mobileAppRoutes);

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

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Auto-connect WhatsApp on server start to resume session
  connectWhatsApp();
});
