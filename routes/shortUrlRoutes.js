import express from "express";
import {
  createShortUrl,
  redirectShortUrl,
  getShortUrlStats,
} from "../controllers/shortUrlController.js";

const router = express.Router();

// Create or retrieve existing short URL
router.post("/shorten", createShortUrl);

// Analytics & Stats
router.get("/:code/stats", getShortUrlStats);

// Redirect via API route
router.get("/:code", redirectShortUrl);

export { redirectShortUrl };
export default router;
