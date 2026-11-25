import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { EventEmitter } from "node:events";

import { authUserSchema } from "../models/AuthUser.js";
import { setMasterModelsMock } from "../services/tenantManager.js";
import {
  protect,
  verifySuperAdmin,
  requireSuperAdmin,
} from "../middleware/authMiddleware.js";
import { forceLogoutPlatform } from "../controllers/developerController.js";
import { apiActivityLogger } from "../middleware/apiActivityLogger.js";
import { createUserSession } from "../services/telemetryService.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_for_dev_role";

const createMockRes = () => {
  const emitter = new EventEmitter();
  emitter.statusCode = 200;
  emitter.body = null;
  emitter.locals = {};
  emitter.status = (code) => {
    emitter.statusCode = code;
    return emitter;
  };
  emitter.json = (payload) => {
    emitter.body = payload;
    emitter.emit("finish");
    return emitter;
  };
  return emitter;
};

test("AuthUser schema supports developer role", () => {
  const roleEnum = authUserSchema.path("role").enumValues;
  assert.ok(roleEnum.includes("developer"));
  assert.ok(roleEnum.includes("super_admin"));
});

test("verifySuperAdmin and requireSuperAdmin grant developer role full admin access", async () => {
  const devUser = {
    _id: "507f1f77bcf86cd799439011",
    name: "Dev User",
    email: "dev@salesbuster.ai",
    role: "developer",
    status: "active",
  };

  setMasterModelsMock(() => ({
    AuthUser: {
      findById: () => ({
        select: async () => devUser,
      }),
    },
    UserSession: {
      findOne: () => ({
        lean: async () => ({
          sessionId: "sess-dev-1",
          platform: "web",
          isActive: true,
          lastActiveAt: new Date(),
        }),
      }),
    },
  }));

  const token = jwt.sign(
    { id: devUser._id, role: "developer", sessionId: "sess-dev-1", platform: "web" },
    process.env.JWT_SECRET
  );

  const req = {
    headers: { authorization: `Bearer ${token}` },
  };
  const res = createMockRes();
  let nextCalled = false;

  await verifySuperAdmin(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.user.role, "developer");

  let requireNextCalled = false;
  requireSuperAdmin(req, createMockRes(), () => {
    requireNextCalled = true;
  });
  assert.equal(requireNextCalled, true);

  setMasterModelsMock(null);
});

test("protect immediately rejects a force-logged-out web or mobile session with 401 forceLoggedOut", async () => {
  setMasterModelsMock(() => ({
    UserSession: {
      findOne: () => ({
        lean: async () => ({
          sessionId: "sess-revoked-mobile",
          platform: "mobile",
          isActive: false,
          revokeReason: "Mobile app force logged out by developer",
        }),
      }),
    },
  }));

  const token = jwt.sign(
    {
      id: "507f1f77bcf86cd799439012",
      role: "sales person",
      sessionId: "sess-revoked-mobile",
      platform: "mobile",
    },
    process.env.JWT_SECRET
  );

  const req = {
    headers: { authorization: `Bearer ${token}` },
  };
  const res = createMockRes();
  let nextCalled = false;

  await protect(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.forceLoggedOut, true);
  assert.equal(res.body.code, "SESSION_REVOKED");

  setMasterModelsMock(null);
});

test("forceLogoutPlatform revokes only the targeted platform (web vs mobile)", async () => {
  const sessions = [
    { sessionId: "web-1", platform: "web", isActive: true },
    { sessionId: "web-caller", platform: "web", isActive: true },
    { sessionId: "mob-1", platform: "mobile", isActive: true },
  ];
  const createdLogs = [];

  setMasterModelsMock(() => ({
    UserSession: {
      updateMany: async (filter, update) => {
        let count = 0;
        for (const s of sessions) {
          const matchesPlatform = s.platform === filter.platform;
          const matchesActive = s.isActive === filter.isActive;
          const notExcluded = !filter.sessionId?.$ne || s.sessionId !== filter.sessionId.$ne;
          if (matchesPlatform && matchesActive && notExcluded) {
            s.isActive = update.$set.isActive;
            count += 1;
          }
        }
        return { modifiedCount: count };
      },
    },
    ApiActivityLog: {
      create: async (doc) => {
        createdLogs.push(doc);
        return doc;
      },
    },
  }));

  const callerToken = jwt.sign(
    { id: "dev-1", role: "developer", sessionId: "web-caller", platform: "web" },
    process.env.JWT_SECRET
  );

  const req = {
    headers: { authorization: `Bearer ${callerToken}` },
    body: { platform: "mobile" },
    user: { _id: "dev-1", email: "dev@salesbuster.ai", role: "developer" },
    originalUrl: "/api/developer/sessions/force-logout-platform",
  };
  const res = createMockRes();

  await forceLogoutPlatform(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.modifiedCount, 1);
  assert.equal(sessions.find((s) => s.sessionId === "mob-1").isActive, false);
  assert.equal(sessions.find((s) => s.sessionId === "web-1").isActive, true);
  assert.equal(createdLogs.length, 1);

  setMasterModelsMock(null);
});

test("apiActivityLogger records 5xx bugs with stack trace", async () => {
  const loggedEntries = [];
  setMasterModelsMock(() => ({
    ApiActivityLog: {
      create: async (doc) => {
        loggedEntries.push(doc);
        return doc;
      },
    },
  }));

  const req = {
    method: "POST",
    originalUrl: "/api/leads/import",
    headers: { "user-agent": "Mozilla/5.0" },
    user: { _id: "u-1", email: "rep@acme.com", role: "sales person" },
    body: { password: "secret", count: 5 },
  };
  const res = createMockRes();

  apiActivityLogger(req, res, () => {});
  res.locals.errorMeta = {
    message: "Unexpected null pointer",
    errorName: "TypeError",
    stack: "TypeError: Unexpected null pointer\n    at importLeads",
  };
  res.status(500).json({ success: false });

  await new Promise((r) => setTimeout(r, 15));

  assert.equal(loggedEntries.length, 1);
  assert.equal(loggedEntries[0].level, "error");
  assert.equal(loggedEntries[0].category, "bug");
  assert.ok(loggedEntries[0].stack.includes("TypeError"));
  assert.ok(loggedEntries[0].requestBodySummary.includes("[REDACTED]"));

  setMasterModelsMock(null);
});

test("createUserSession enforces single active session per platform (max 1 web + 1 mobile)", async () => {
  const sessions = [
    { sessionId: "old-web", userId: "user-1", platform: "web", isActive: true },
    { sessionId: "active-mobile", userId: "user-1", platform: "mobile", isActive: true },
  ];
  const activityLogs = [];

  setMasterModelsMock(() => ({
    UserSession: {
      updateMany: async (filter, update) => {
        let count = 0;
        for (const s of sessions) {
          if (
            s.userId === filter.userId &&
            s.platform === filter.platform &&
            s.isActive === filter.isActive
          ) {
            s.isActive = update.$set.isActive;
            s.revokedBy = update.$set.revokedBy;
            count += 1;
          }
        }
        return { modifiedCount: count };
      },
      create: async (doc) => {
        sessions.push({ ...doc });
        return doc;
      },
    },
    ApiActivityLog: {
      create: async (doc) => {
        activityLogs.push(doc);
        return doc;
      },
    },
  }));

  // 1. New web login should revoke old-web, keep active-mobile, and create new web session
  const webLogin = await createUserSession({
    user: { _id: "user-1", email: "user@acme.com", role: "sales person" },
    organization: { name: "Acme" },
    req: { headers: { "x-client-platform": "web" }, originalUrl: "/api/auth/login" },
  });

  assert.equal(webLogin.platform, "web");
  assert.equal(sessions.find((s) => s.sessionId === "old-web").isActive, false);
  assert.equal(sessions.find((s) => s.sessionId === "active-mobile").isActive, true);
  assert.equal(sessions.find((s) => s.sessionId === webLogin.sessionId).isActive, true);

  // 2. New mobile login should revoke active-mobile, keep new web session, and create new mobile session
  const mobileLogin = await createUserSession({
    user: { _id: "user-1", email: "user@acme.com", role: "sales person" },
    organization: { name: "Acme" },
    req: { headers: { "x-client-platform": "mobile" }, originalUrl: "/api/auth/login" },
  });

  assert.equal(mobileLogin.platform, "mobile");
  assert.equal(sessions.find((s) => s.sessionId === "active-mobile").isActive, false);
  assert.equal(sessions.find((s) => s.sessionId === webLogin.sessionId).isActive, true);
  assert.equal(sessions.find((s) => s.sessionId === mobileLogin.sessionId).isActive, true);
  assert.equal(activityLogs.length, 2);

  setMasterModelsMock(null);
});
