import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { corsOptions } from "../configs/corsConfig.js";
import { AppError, BadRequestError, NotFoundError } from "../utils/AppError.js";
import { validateRequest } from "../middleware/validateRequest.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { getTenantModels } from "../services/tenantManager.js";

describe("Backend Security & Resilience - CORS Protection", () => {
  it("allows non-browser server-to-server or mobile requests with empty origin", () => {
    let allowed = null;
    corsOptions.origin(null, (err, pass) => {
      allowed = !err && pass;
    });
    assert.equal(allowed, true, "Empty origin (mobile app, webhook, curl) must be allowed");
  });

  it("allows localhost and local dev origins", () => {
    let allowed = null;
    corsOptions.origin("http://localhost:5173", (err, pass) => {
      allowed = !err && pass;
    });
    assert.equal(allowed, true, "Localhost origin must be allowed");

    let allowed127 = null;
    corsOptions.origin("http://127.0.0.1:3000", (err, pass) => {
      allowed127 = !err && pass;
    });
    assert.equal(allowed127, true, "127.0.0.1 origin must be allowed");
  });

  it("allows official SalesBuster production and staging domains", () => {
    const domains = [
      "https://betaapp.salesbuster.ai",
      "https://app.salesbuster.ai",
      "https://salesbuster.ai",
    ];

    for (const domain of domains) {
      let allowed = null;
      corsOptions.origin(domain, (err, pass) => {
        allowed = !err && pass;
      });
      assert.equal(allowed, true, `Domain ${domain} must be permitted`);
    }
  });

  it("rejects unauthorized external third-party origins in production mode", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    let errorObj = null;
    corsOptions.origin("https://malicious-tracker-site.com", (err) => {
      errorObj = err;
    });

    process.env.NODE_ENV = originalEnv;
    assert.ok(errorObj, "Untrusted external origin must be rejected by CORS");
  });
});

describe("Backend Security & Resilience - Error Handling & Validation", () => {
  it("AppError hierarchy sets operational flags and status codes properly", () => {
    const badReq = new BadRequestError("Missing parameter", { field: "phone" });
    assert.equal(badReq.statusCode, 400);
    assert.equal(badReq.code, "BAD_REQUEST");
    assert.equal(badReq.isOperational, true);
    assert.deepEqual(badReq.details, { field: "phone" });

    const notFound = new NotFoundError("Lead not found");
    assert.equal(notFound.statusCode, 404);
    assert.equal(notFound.code, "NOT_FOUND");
  });

  it("validateRequest parses valid payload with Zod schema", (t, done) => {
    const schema = z.object({
      body: z.object({
        name: z.string().min(2),
        phone: z.string().min(10),
      }),
    });

    const req = {
      body: { name: "Alice", phone: "9876543210" },
      query: {},
      params: {},
    };
    const res = {};

    const middleware = validateRequest(schema);
    middleware(req, res, () => {
      assert.equal(req.body.name, "Alice");
      assert.equal(req.body.phone, "9876543210");
      done();
    });
  });

  it("validateRequest safely populates query on IncomingMessage with getter-only query", (t, done) => {
    const schema = z.object({
      query: z.object({
        status: z.string(),
        page: z.coerce.number(),
      }),
    });

    // Emulate Node.js http.IncomingMessage prototype where query only has a getter
    const proto = {
      get query() {
        return { status: "pending", page: "2" };
      },
    };
    const req = Object.create(proto);
    req.body = {};
    req.params = {};

    const middleware = validateRequest(schema);
    middleware(req, {}, () => {
      assert.equal(req.query.status, "pending");
      assert.equal(req.query.page, 2);
      done();
    });
  });

  it("validateRequest rejects invalid payload with 400 and structured error paths", () => {
    const schema = z.object({
      body: z.object({
        email: z.string().email(),
      }),
    });

    const req = {
      body: { email: "not-an-email" },
      query: {},
      params: {},
    };

    let statusCode = null;
    let jsonOutput = null;

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonOutput = data;
      },
    };

    const middleware = validateRequest(schema);
    middleware(req, res, () => {});

    assert.equal(statusCode, 400);
    assert.equal(jsonOutput.success, false);
    assert.equal(jsonOutput.code, "VALIDATION_FAILED");
    assert.ok(jsonOutput.errors.some((e) => e.path === "body.email"));
  });

  it("errorHandler formats AppError, CastError, and ValidationError consistently", () => {
    let statusCode = null;
    let jsonOutput = null;

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonOutput = data;
      },
    };

    // 1. AppError
    errorHandler(new BadRequestError("Invalid parameter"), { originalUrl: "/api/test", method: "POST" }, res);
    assert.equal(statusCode, 400);
    assert.equal(jsonOutput.code, "BAD_REQUEST");

    // 2. Mongoose CastError
    const castErr = new Error("Cast error");
    castErr.name = "CastError";
    castErr.path = "leadId";
    errorHandler(castErr, { originalUrl: "/api/test", method: "GET" }, res);
    assert.equal(statusCode, 400);
    assert.equal(jsonOutput.code, "INVALID_IDENTIFIER");
  });

  it("getTenantModels caches tenant models dictionary to avoid recreation overhead", () => {
    const models1 = getTenantModels("test_tenant_cache_db");
    const models2 = getTenantModels("test_tenant_cache_db");
    assert.equal(models1, models2, "Repeated getTenantModels calls must return cached reference");
  });
});
