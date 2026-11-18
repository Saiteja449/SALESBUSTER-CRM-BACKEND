import crypto from "crypto";
import { getMasterModels } from "../services/tenantManager.js";

// Clean alphabet avoiding easily confused characters (no 0/O, no 1/l/I)
const SHORT_CODE_CHARS =
  "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

const generateShortCode = (length = 6) => {
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += SHORT_CODE_CHARS[bytes[i] % SHORT_CODE_CHARS.length];
  }
  return result;
};

const resolveBaseDomain = (req) => {
  const customDomain =
    process.env.SHORT_URL_BASE_DOMAIN ||
    process.env.SERVER_BASE_URL ||
    process.env.API_BASE_URL;

  if (customDomain) {
    return customDomain.replace(/\/+$/, "");
  }

  // Derive from incoming request headers
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.get("host") || "betaapi.salesbuster.ai";
  return `${protocol}://${host}`;
};

/**
 * Creates or retrieves a shortened URL
 * POST /api/s/shorten
 * Body: { url: string, title?: string, organizationId?: string }
 */
export const createShortUrl = async (req, res) => {
  try {
    const rawUrl = (req.body?.url || "").trim();
    const title = (req.body?.title || "").trim();
    const organizationId =
      req.body?.organizationId ||
      req.organization?._id ||
      req.user?.organizationId ||
      null;

    if (!rawUrl) {
      return res.status(400).json({
        success: false,
        message: "Target URL is required for shortening.",
      });
    }

    // Basic URL validation
    if (
      !rawUrl.startsWith("http://") &&
      !rawUrl.startsWith("https://") &&
      !rawUrl.startsWith("/")
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid URL provided. Must start with http:// or https://",
      });
    }

    const { ShortUrl } = getMasterModels();
    const baseDomain = resolveBaseDomain(req);

    // If the URL is already one of our own short URLs, return it as is
    const shortPrefix = `${baseDomain}/s/`;
    if (rawUrl.startsWith(shortPrefix)) {
      const code = rawUrl.replace(shortPrefix, "").split("?")[0].split("/")[0];
      return res.json({
        success: true,
        shortCode: code,
        shortUrl: rawUrl,
        originalUrl: rawUrl,
      });
    }

    // Check if we already shortened this exact original URL
    const existing = await ShortUrl.findOne({ originalUrl: rawUrl });
    if (existing) {
      return res.json({
        success: true,
        shortCode: existing.shortCode,
        shortUrl: `${baseDomain}/s/${existing.shortCode}`,
        originalUrl: existing.originalUrl,
        clicks: existing.clicks || 0,
      });
    }

    // Generate unique short code with collision check
    let shortCode = "";
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 5) {
      shortCode = generateShortCode(6);
      const collision = await ShortUrl.findOne({ shortCode });
      if (!collision) {
        isUnique = true;
      }
      attempts++;
    }

    if (!isUnique) {
      // Fallback to 8 chars if 5 attempts collided
      shortCode = generateShortCode(8);
    }

    const newShortUrl = await ShortUrl.create({
      shortCode,
      originalUrl: rawUrl,
      title: title || "",
      organizationId,
      clicks: 0,
    });

    return res.status(201).json({
      success: true,
      shortCode: newShortUrl.shortCode,
      shortUrl: `${baseDomain}/s/${newShortUrl.shortCode}`,
      originalUrl: newShortUrl.originalUrl,
      clicks: 0,
    });
  } catch (error) {
    console.error("[shortUrlController] createShortUrl error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error creating short URL.",
      error: error.message,
    });
  }
};

/**
 * Public redirect handler
 * GET /s/:code or GET /api/s/:code
 */
export const redirectShortUrl = async (req, res) => {
  try {
    const rawCode = (req.params.code || "").trim();
    if (!rawCode) {
      return res.redirect("https://salesbuster.ai");
    }

    const { ShortUrl } = getMasterModels();

    // Atomically increment clicks and log timestamp
    const record = await ShortUrl.findOneAndUpdate(
      { shortCode: rawCode },
      {
        $inc: { clicks: 1 },
        $set: { lastClickedAt: new Date() },
      },
      { new: true }
    );

    if (!record || !record.originalUrl) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Link Not Found – SalesBuster</title>
            <style>
              body {
                background-color: #0A0D14;
                color: #FFFFFF;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                margin: 0;
                padding: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                box-sizing: border-box;
              }
              .card {
                background-color: #111827;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 20px;
                padding: 36px 28px;
                max-width: 420px;
                width: 100%;
                text-align: center;
                box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
              }
              .badge {
                display: inline-block;
                background: rgba(239, 68, 68, 0.12);
                color: #F87171;
                font-size: 12px;
                font-weight: 700;
                padding: 6px 12px;
                border-radius: 20px;
                margin-bottom: 16px;
                letter-spacing: 0.5px;
              }
              h1 {
                font-size: 22px;
                font-weight: 700;
                margin: 0 0 10px 0;
                color: #FFFFFF;
              }
              p {
                font-size: 14px;
                color: #94A3B8;
                line-height: 1.5;
                margin: 0 0 24px 0;
              }
              .btn {
                display: inline-block;
                background: linear-gradient(135deg, #5013C7 0%, #7C3AED 100%);
                color: #FFFFFF;
                text-decoration: none;
                padding: 12px 24px;
                border-radius: 12px;
                font-weight: 600;
                font-size: 14px;
              }
            </style>
          </head>
          <body>
            <div class="card">
              <span class="badge">404 NOT FOUND</span>
              <h1>Link Not Available</h1>
              <p>The business file or document you are looking for has been moved or is no longer active.</p>
              <a href="https://salesbuster.ai" class="btn">Return to SalesBuster</a>
            </div>
          </body>
        </html>
      `);
    }

    // Perform HTTP 302 temporary redirect to target file/media
    return res.redirect(302, record.originalUrl);
  } catch (error) {
    console.error("[shortUrlController] redirectShortUrl error:", error);
    return res.redirect("https://salesbuster.ai");
  }
};

/**
 * Click tracking stats
 * GET /api/s/:code/stats
 */
export const getShortUrlStats = async (req, res) => {
  try {
    const rawCode = (req.params.code || "").trim();
    const { ShortUrl } = getMasterModels();

    const record = await ShortUrl.findOne({ shortCode: rawCode });
    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Short URL not found.",
      });
    }

    return res.json({
      success: true,
      data: {
        shortCode: record.shortCode,
        originalUrl: record.originalUrl,
        title: record.title || "",
        clicks: record.clicks || 0,
        lastClickedAt: record.lastClickedAt || null,
        createdAt: record.createdAt,
      },
    });
  } catch (error) {
    console.error("[shortUrlController] getShortUrlStats error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error retrieving stats.",
      error: error.message,
    });
  }
};
