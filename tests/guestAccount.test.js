import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { guestRegister, login } from "../controllers/authController.js";
import {
  upgradeGuestOrganization,
  getOrganizations,
} from "../controllers/organizationController.js";
import {
  protect,
  requireCrmAccount,
} from "../middleware/authMiddleware.js";
import { checkSubscriptionActive } from "../middleware/tenantMiddleware.js";
import {
  setMasterModelsMock,
  setTenantModelsMock,
} from "../services/tenantManager.js";

// Helper to construct mock Express request and response
const mockReqRes = (reqOverrides = {}) => {
  let statusCode = 200;
  let jsonResponse = null;

  const req = {
    headers: {},
    body: {},
    params: {},
    query: {},
    ...reqOverrides,
  };

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      jsonResponse = data;
      return this;
    },
    send(data) {
      jsonResponse = data;
      return this;
    },
  };

  return {
    req,
    res,
    getStatusCode: () => statusCode,
    getResponse: () => jsonResponse,
  };
};

describe("Guest Account & Conversational Capture Architecture Tests", () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-super-secret-jwt-key";

  afterEach(() => {
    setMasterModelsMock(null);
    setTenantModelsMock(null);
  });

  describe("1. Guest Self-Registration (POST /api/auth/guest-register)", () => {
    it("successfully registers a guest account with tenant isolation and guest entitlement", async () => {
      let createdMasterOrg = null;
      let createdAuthUser = null;
      let createdTenantUser = null;

      const mockOrgModel = {
        findOne: async () => null,
        create: async (data) => {
          createdMasterOrg = {
            _id: "org_guest_123",
            ...data,
            save: async function () {
              return this;
            },
          };
          return createdMasterOrg;
        },
      };

      const mockAuthUserModel = {
        findOne: async () => null,
        create: async (data) => {
          createdAuthUser = {
            _id: "user_guest_123",
            ...data,
          };
          return createdAuthUser;
        },
      };

      const mockTenantUserModel = {
        create: async (data) => {
          createdTenantUser = {
            ...data,
          };
          return createdTenantUser;
        },
      };

      setMasterModelsMock(() => ({
        Organization: mockOrgModel,
        AuthUser: mockAuthUserModel,
      }));
      setTenantModelsMock(() => ({
        User: mockTenantUserModel,
      }));

      const { req, res, getStatusCode, getResponse } = mockReqRes({
        body: {
          name: "Dr. Vikram Malhotra",
          email: "vikram@malhotrahealth.com",
          phone: "9876543210",
          password: "SecurePassword123!",
        },
      });

      await guestRegister(req, res);

      assert.equal(getStatusCode(), 201);
      const data = getResponse();
      assert.equal(data.success, true);
      assert.equal(data.accountType, "guest");
      assert.equal(data.email, "vikram@malhotrahealth.com");
      assert.equal(data.organization.accountType, "guest");
      assert.ok(data.token, "JWT token should be returned");

      // Verify token payload
      const decoded = jwt.verify(data.token, process.env.JWT_SECRET);
      assert.equal(decoded.accountType, "guest");
      assert.equal(decoded.role, "sales manager");
      assert.equal(decoded.isOrgOwner, true);

      // Verify password hashed
      assert.notEqual(createdAuthUser.password, "SecurePassword123!");
      assert.ok(await bcrypt.compare("SecurePassword123!", createdAuthUser.password));
    });

    it("rejects registration when privilege-escalation fields are present in request body", async () => {
      const { req, res, getStatusCode, getResponse } = mockReqRes({
        body: {
          name: "Hacker Bob",
          email: "bob@test.com",
          phone: "9876543210",
          password: "password123",
          role: "super_admin",
          accountType: "crm",
        },
      });

      await guestRegister(req, res);
      assert.equal(getStatusCode(), 400);
      assert.equal(getResponse().code, "VALIDATION_ERROR");
      assert.match(getResponse().message, /not allowed during guest registration/);
    });

    it("enforces validation on email, phone, and password policy", async () => {
      // 1. Invalid email
      let ctx = mockReqRes({
        body: {
          name: "Alice",
          email: "not-an-email",
          phone: "9876543210",
          password: "password123",
        },
      });
      await guestRegister(ctx.req, ctx.res);
      assert.equal(ctx.getStatusCode(), 400);

      // 2. Short phone (<10 digits)
      ctx = mockReqRes({
        body: {
          name: "Alice",
          email: "alice@test.com",
          phone: "12345",
          password: "password123",
        },
      });
      await guestRegister(ctx.req, ctx.res);
      assert.equal(ctx.getStatusCode(), 400);

      // 3. Short password (<6 chars)
      ctx = mockReqRes({
        body: {
          name: "Alice",
          email: "alice@test.com",
          phone: "9876543210",
          password: "123",
        },
      });
      await guestRegister(ctx.req, ctx.res);
      assert.equal(ctx.getStatusCode(), 400);
      assert.equal(ctx.getResponse().code, "PASSWORD_POLICY");
    });

    it("returns 409 ACCOUNT_ALREADY_EXISTS when email or phone is already registered", async () => {
      setMasterModelsMock(() => ({
        AuthUser: {
          findOne: async ({ email }) => (email ? { email } : null),
        },
        Organization: {
          findOne: async () => null,
        },
      }));

      const { req, res, getStatusCode, getResponse } = mockReqRes({
        body: {
          name: "Duplicate User",
          email: "existing@test.com",
          phone: "9876543210",
          password: "password123",
        },
      });

      await guestRegister(req, res);
      assert.equal(getStatusCode(), 409);
      assert.equal(getResponse().code, "ACCOUNT_ALREADY_EXISTS");
    });
  });

  describe("2. Guest Login & Perpetual Expiry Exemption", () => {
    it("logs in guest user and returns accountType without expiring past subscriptionEndDate", async () => {
      const hashedPassword = await bcrypt.hash("guestPass123", 10);
      const mockAuthUser = {
        _id: "user_guest_888",
        email: "guest@example.com",
        password: hashedPassword,
        name: "Guest Organizer",
        role: "sales manager",
        organizationId: "org_guest_888",
        tenantDbName: "sb_tenant_guest_888",
        isOrgOwner: true,
      };

      // Past date: CRM would be expired, but guest must remain active!
      const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
      const mockOrg = {
        _id: "org_guest_888",
        name: "Guest Organizer Workspace",
        accountType: "guest",
        status: "active",
        subscriptionEndDate: pastDate,
        seats: 1,
      };

      setMasterModelsMock(() => ({
        AuthUser: {
          findOne: async ({ email }) => (email === "guest@example.com" ? mockAuthUser : null),
        },
        Organization: {
          findById: async (id) => (id === "org_guest_888" ? mockOrg : null),
        },
      }));
      setTenantModelsMock(() => ({
        User: { countDocuments: async () => 0 },
      }));

      const { req, res, getStatusCode, getResponse } = mockReqRes({
        body: {
          email: "guest@example.com",
          password: "guestPass123",
        },
      });

      await login(req, res);

      assert.equal(getStatusCode(), 200);
      const data = getResponse();
      assert.equal(data.success, true);
      assert.equal(data.accountType, "guest");
      assert.equal(data.organization.accountType, "guest");
      assert.equal(data.organization.isExpired, false);
    });
  });

  describe("3. Route Authorization Guard (requireCrmAccount)", () => {
    it("allows full CRM account to proceed", () => {
      let nextCalled = false;
      const { req, res } = mockReqRes({
        organization: { accountType: "crm" },
      });

      requireCrmAccount(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
    });

    it("blocks guest account with 403 UPGRADE_REQUIRED", () => {
      let nextCalled = false;
      const { req, res, getStatusCode, getResponse } = mockReqRes({
        organization: { accountType: "guest" },
      });

      requireCrmAccount(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(getStatusCode(), 403);
      assert.equal(getResponse().code, "UPGRADE_REQUIRED");
      assert.match(getResponse().message, /CRM plan is required/);
    });
  });

  describe("4. Subscription Middleware Active Check for Guests", () => {
    it("does not block guest even if subscriptionEndDate is in past", () => {
      let nextCalled = false;
      const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 10);
      const { req, res } = mockReqRes({
        organization: {
          accountType: "guest",
          status: "active",
          subscriptionEndDate: pastDate,
        },
        path: "/api/events",
      });

      checkSubscriptionActive(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
    });

    it("blocks guest if organization status is suspended or inactive", () => {
      let nextCalled = false;
      const { req, res, getStatusCode, getResponse } = mockReqRes({
        organization: {
          accountType: "guest",
          status: "suspended",
        },
        path: "/api/events",
      });

      checkSubscriptionActive(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(getStatusCode(), 403);
      assert.equal(getResponse().accountSuspended, true);
    });
  });

  describe("5. Super Admin In-Place Upgrade (POST /api/organizations/:id/upgrade-guest)", () => {
    it("upgrades guest organization to CRM in-place, preserving tenant DB and owner ID", async () => {
      let savedOrg = null;
      const mockOrg = {
        _id: "org_guest_to_upgrade",
        name: "Malhotra Healthcare Ltd",
        email: "malhotra@health.com",
        mobile: "9876543210",
        accountType: "guest",
        tenantDbName: "sb_tenant_guest_malhotra_999",
        ownerId: "owner_user_999",
        seats: 1,
        save: async function () {
          savedOrg = this;
          return this;
        },
      };

      setMasterModelsMock(() => ({
        Organization: {
          findById: async (id) => (id === "org_guest_to_upgrade" ? mockOrg : null),
        },
      }));

      const { req, res, getStatusCode, getResponse } = mockReqRes({
        params: { id: "org_guest_to_upgrade" },
        body: {
          seats: 5,
          subscriptionPlan: "annually",
          amountPaid: 60000,
          paymentMethod: "Bank Transfer",
          addons: {
            whatsappCampaigns: true,
            biAnalyst: true,
            targetIntelligence: true,
          },
          notes: "Upgraded from guest to Annual Enterprise plan",
        },
      });

      await upgradeGuestOrganization(req, res);

      assert.equal(getStatusCode(), 200);
      const data = getResponse();
      assert.equal(data.success, true);
      assert.equal(savedOrg.accountType, "crm");
      assert.equal(savedOrg.seats, 5);
      assert.equal(savedOrg.subscriptionPlan, "annually");
      assert.equal(savedOrg.amountPaid, 60000);
      assert.equal(savedOrg.addons.whatsappCampaigns, true);
      assert.equal(savedOrg.tenantDbName, "sb_tenant_guest_malhotra_999", "Tenant DB must be preserved");
      assert.equal(savedOrg.ownerId, "owner_user_999", "Owner ID must be preserved");
      assert.ok(savedOrg.subscriptionEndDate > new Date(), "SubscriptionEndDate must be set in future");
    });

    it("is idempotent when upgrade is called on an organization that is already CRM", async () => {
      const mockOrg = {
        _id: "org_already_crm",
        accountType: "crm",
        seats: 3,
      };

      setMasterModelsMock(() => ({
        Organization: {
          findById: async () => mockOrg,
        },
      }));

      const { req, res, getStatusCode, getResponse } = mockReqRes({
        params: { id: "org_already_crm" },
        body: { seats: 5 },
      });

      await upgradeGuestOrganization(req, res);

      assert.equal(getStatusCode(), 200);
      assert.equal(getResponse().message, "Organization is already upgraded to CRM.");
    });
  });

  describe("6. Super Admin Organization Filtering (GET /api/organizations)", () => {
    it("filters organizations by accountType=guest", async () => {
      let queryFilter = null;
      const mockOrgList = [
        {
          _id: "org_1",
          name: "Guest Expo Org",
          accountType: "guest",
          tenantDbName: "sb_tenant_guest_1",
          toJSON() {
            return { ...this };
          },
        },
      ];

      setMasterModelsMock(() => ({
        Organization: {
          find: (filter) => {
            queryFilter = filter;
            return {
              sort: () => mockOrgList,
            };
          },
        },
      }));
      setTenantModelsMock(() => ({
        User: { countDocuments: async () => 0 },
      }));

      const { req, res, getStatusCode, getResponse } = mockReqRes({
        query: { accountType: "guest" },
      });

      await getOrganizations(req, res);

      assert.equal(getStatusCode(), 200);
      assert.deepEqual(queryFilter, { accountType: "guest" });
      const data = getResponse();
      assert.equal(data.count, 1);
      assert.equal(data.data[0].accountType, "guest");
    });
  });
});
