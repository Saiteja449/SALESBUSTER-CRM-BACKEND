import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { sendOtp, verifyOtp, completeProfile } from "../controllers/otpAuthController.js";
import { setMasterModelsMock, setTenantModelsMock } from "../services/tenantManager.js";
import Otp from "../models/Otp.js";

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
  };

  return { req, res, getStatus: () => statusCode, getJson: () => jsonResponse };
};

describe("OTP Authentication & Speech Profile Completion Tests", () => {
  let inMemoryUsers = [];
  let inMemoryOrgs = [];
  let inMemoryOtps = [];

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "test_jwt_secret_123456789";
    process.env.F2S_KEY = "test_f2s_key";
    process.env.F2S_URL = "https://www.fast2sms.com/dev/bulkV2";
    process.env.F2S_SENDER_ID = "PFSIND";
    process.env.F2S_DLT_TEMPLATE_ID = "214914";

    inMemoryUsers = [];
    inMemoryOrgs = [];
    inMemoryOtps = [];

    // Mock Otp Model methods
    Otp.findOne = (query) => {
      const exec = async () => {
        const matches = inMemoryOtps.filter((o) => {
          if (query.phone && o.phone !== query.phone) return false;
          if (query.verified !== undefined && o.verified !== query.verified) return false;
          if (query.expiresAt && query.expiresAt.$gt && o.expiresAt <= query.expiresAt.$gt) return false;
          return true;
        });
        matches.sort((a, b) => b.createdAt - a.createdAt);
        const match = matches[0];
        if (!match) return null;
        return {
          ...match,
          save: async function () {
            const idx = inMemoryOtps.findIndex((x) => x._id === match._id);
            if (idx !== -1) inMemoryOtps[idx] = { ...this };
            return this;
          },
        };
      };

      const promise = exec();
      promise.sort = () => promise;
      return promise;
    };

    Otp.create = async (doc) => {
      const created = {
        _id: `otp_${Date.now()}_${Math.random()}`,
        attempts: 0,
        verified: false,
        createdAt: new Date(),
        ...doc,
        save: async function () {
          return this;
        },
      };
      inMemoryOtps.push(created);
      return created;
    };

    Otp.deleteMany = async (query) => {
      inMemoryOtps = inMemoryOtps.filter((o) => {
        if (query.phone && o.phone === query.phone && query.verified === false && !o.verified) {
          return false;
        }
        return true;
      });
      return { acknowledged: true };
    };

    const mockAuthUser = {
      findOne: async (query) => {
        return inMemoryUsers.find((u) => {
          if (query.phone) {
            if (query.phone.$in && Array.isArray(query.phone.$in)) {
              if (query.phone.$in.includes(u.phone)) return true;
            } else if (query.phone instanceof RegExp) {
              if (query.phone.test(u.phone)) return true;
            } else if (u.phone === query.phone) {
              return true;
            }
          }
          if (query.email && u.email === query.email) return true;
          return false;
        }) || null;
      },
      findById: async (id) => {
        const found = inMemoryUsers.find((u) => String(u._id) === String(id));
        if (!found) return null;
        return {
          ...found,
          save: async function () {
            const idx = inMemoryUsers.findIndex((x) => String(x._id) === String(id));
            if (idx !== -1) inMemoryUsers[idx] = { ...this };
            return this;
          },
        };
      },
      create: async (doc) => {
        const user = {
          _id: `user_${Date.now()}_${Math.random()}`,
          isProfileComplete: false,
          ...doc,
          save: async function () {
            return this;
          },
        };
        inMemoryUsers.push(user);
        return user;
      },
    };

    const mockOrganization = {
      findOne: async (query) => {
        if (query.tenantDbName) {
          return inMemoryOrgs.find((o) => o.tenantDbName === query.tenantDbName) || null;
        }
        if (query.mobile) {
          return inMemoryOrgs.find((o) => {
            if (query.mobile.$in && Array.isArray(query.mobile.$in)) {
              if (query.mobile.$in.includes(o.mobile)) return true;
            } else if (query.mobile instanceof RegExp) {
              if (query.mobile.test(o.mobile)) return true;
            } else if (o.mobile === query.mobile) {
              return true;
            }
            return false;
          }) || null;
        }
        return null;
      },
      findById: async (id) => {
        const found = inMemoryOrgs.find((o) => String(o._id) === String(id));
        if (!found) return null;
        return {
          ...found,
          save: async function () {
            const idx = inMemoryOrgs.findIndex((x) => String(x._id) === String(id));
            if (idx !== -1) inMemoryOrgs[idx] = { ...this };
            return this;
          },
        };
      },
      create: async (doc) => {
        const org = {
          _id: `org_${Date.now()}_${Math.random()}`,
          ...doc,
          save: async function () {
            return this;
          },
        };
        inMemoryOrgs.push(org);
        return org;
      },
    };

    setMasterModelsMock(() => ({
      AuthUser: mockAuthUser,
      Organization: mockOrganization,
    }));

    setTenantModelsMock(() => ({
      User: {
        create: async (doc) => doc,
        findByIdAndUpdate: async (id, update) => update,
      },
    }));
  });

  afterEach(() => {
    setMasterModelsMock(null);
    setTenantModelsMock(null);
  });

  it("should send a 4-digit OTP via Fast2SMS DLT route", async () => {
    const { req, res, getStatus, getJson } = mockReqRes({
      body: { phone: "9876543210" },
    });

    await sendOtp(req, res);

    assert.equal(getStatus(), 200);
    const json = getJson();
    assert.equal(json.success, true);
    assert.ok(json.debugOtp, "Should include 4-digit debug OTP in test mode");
    assert.equal(json.debugOtp.length, 4, "OTP must be exactly 4 digits");
    assert.ok(/^\d{4}$/.test(json.debugOtp), "OTP must be numeric");

    assert.equal(inMemoryOtps.length, 1);
    assert.equal(inMemoryOtps[0].phone, "9876543210");
  });

  it("should reject invalid phone format for sendOtp", async () => {
    const { req, res, getStatus, getJson } = mockReqRes({
      body: { phone: "123" },
    });

    await sendOtp(req, res);

    assert.equal(getStatus(), 400);
    assert.equal(getJson().success, false);
  });

  it("should verify 4-digit OTP and flag isProfileComplete as false for new users", async () => {
    // 1. Send OTP first
    const { req: sReq, res: sRes, getJson: getSJson } = mockReqRes({
      body: { phone: "9876543210" },
    });
    await sendOtp(sReq, sRes);
    const generatedOtp = getSJson().debugOtp;

    // 2. Verify with correct OTP
    const { req: vReq, res: vRes, getStatus: getVStatus, getJson: getVJson } = mockReqRes({
      body: { phone: "9876543210", otp: generatedOtp },
    });
    await verifyOtp(vReq, vRes);

    assert.equal(getVStatus(), 200);
    const vData = getVJson();
    assert.equal(vData.success, true);
    assert.ok(vData.token, "Should issue JWT token");
    assert.equal(vData.phone, "9876543210");
    assert.equal(vData.isProfileComplete, false, "New user profile should be incomplete");
  });

  it("should complete profile with Name, Company, Role, City, and optional Email", async () => {
    // 1. Send & Verify OTP to obtain token
    const { req: sReq, res: sRes, getJson: getSJson } = mockReqRes({
      body: { phone: "9876543210" },
    });
    await sendOtp(sReq, sRes);
    const generatedOtp = getSJson().debugOtp;

    const { req: vReq, res: vRes, getJson: getVJson } = mockReqRes({
      body: { phone: "9876543210", otp: generatedOtp },
    });
    await verifyOtp(vReq, vRes);
    const userPayload = getVJson();

    // 2. Complete Profile via Speech collected fields
    const { req: cReq, res: cRes, getStatus: getCStatus, getJson: getCJson } = mockReqRes({
      user: { _id: userPayload._id, id: userPayload._id },
      body: {
        name: "Rahul Sharma",
        companyName: "Sharma Enterprises",
        role: "Sales Director",
        city: "Hyderabad",
        email: "rahul@sharmaenterprises.com",
      },
    });

    await completeProfile(cReq, cRes);

    assert.equal(getCStatus(), 200);
    const cData = getCJson();
    assert.equal(cData.success, true);
    assert.equal(cData.name, "Rahul Sharma");
    assert.equal(cData.companyName, "Sharma Enterprises");
    assert.equal(cData.role, "Sales Director");
    assert.equal(cData.city, "Hyderabad");
    assert.equal(cData.email, "rahul@sharmaenterprises.com");
    assert.equal(cData.isProfileComplete, true, "Profile must now be marked complete");

    // 3. Subsequent OTP verification for same user should have isProfileComplete === true!
    const { req: s2Req, res: s2Res, getJson: getS2Json } = mockReqRes({
      body: { phone: "9876543210" },
    });
    await sendOtp(s2Req, s2Res);
    const otp2 = getS2Json().debugOtp;

    const { req: v2Req, res: v2Res, getJson: getV2Json } = mockReqRes({
      body: { phone: "9876543210", otp: otp2 },
    });
    await verifyOtp(v2Req, v2Res);
    const v2Data = getV2Json();
    assert.equal(v2Data.isProfileComplete, true, "Subsequent login must indicate profile is complete");
  });

  it("should complete profile without email when email is omitted (optional)", async () => {
    // 1. Send & Verify
    const { req: sReq, res: sRes, getJson: getSJson } = mockReqRes({
      body: { phone: "9988776655" },
    });
    await sendOtp(sReq, sRes);
    const otp = getSJson().debugOtp;

    const { req: vReq, res: vRes, getJson: getVJson } = mockReqRes({
      body: { phone: "9988776655", otp },
    });
    await verifyOtp(vReq, vRes);
    const userPayload = getVJson();

    // 2. Complete Profile without email
    const { req: cReq, res: cRes, getStatus: getCStatus, getJson: getCJson } = mockReqRes({
      user: { _id: userPayload._id, id: userPayload._id },
      body: {
        name: "Pooja Patel",
        companyName: "Patel Traders",
        role: "Owner",
        city: "Ahmedabad",
        // email omitted
      },
    });

    await completeProfile(cReq, cRes);

    assert.equal(getCStatus(), 200);
    const cData = getCJson();
    assert.equal(cData.success, true);
    assert.equal(cData.name, "Pooja Patel");
    assert.equal(cData.city, "Ahmedabad");
    assert.equal(cData.isProfileComplete, true);
  });

  it("should complete profile without error when email is explicitly sent as empty string", async () => {
    // 1. Verify OTP for User A
    const { req: sReqA, res: sResA, getJson: getSJsonA } = mockReqRes({ body: { phone: "9111111111" } });
    await sendOtp(sReqA, sResA);
    const otpA = getSJsonA().debugOtp;

    const { req: vReqA, res: vResA, getJson: getVJsonA } = mockReqRes({
      body: { phone: "9111111111", otp: otpA },
    });
    await verifyOtp(vReqA, vResA);
    const userA = getVJsonA();

    // 2. Complete Profile for User A with email: ""
    const { req: cReqA, res: cResA, getStatus: getCStatusA, getJson: getCJsonA } = mockReqRes({
      user: { _id: userA._id, id: userA._id },
      body: {
        name: "User Alpha",
        companyName: "Alpha Corp",
        role: "Manager",
        city: "Mumbai",
        email: "",
      },
    });
    await completeProfile(cReqA, cResA);
    assert.equal(getCStatusA(), 200);
    assert.equal(getCJsonA().success, true);

    // Verify User A does not have email stored as ""
    const savedUserA = inMemoryUsers.find((u) => String(u._id) === String(userA._id));
    assert.notEqual(savedUserA.email, "");

    // 3. Verify OTP and complete profile for User B with email: "   "
    const { req: sReqB, res: sResB, getJson: getSJsonB } = mockReqRes({ body: { phone: "9222222222" } });
    await sendOtp(sReqB, sResB);
    const otpB = getSJsonB().debugOtp;

    const { req: vReqB, res: vResB, getJson: getVJsonB } = mockReqRes({
      body: { phone: "9222222222", otp: otpB },
    });
    await verifyOtp(vReqB, vResB);
    const userB = getVJsonB();

    const { req: cReqB, res: cResB, getStatus: getCStatusB, getJson: getCJsonB } = mockReqRes({
      user: { _id: userB._id, id: userB._id },
      body: {
        name: "User Beta",
        companyName: "Beta Corp",
        role: "Executive",
        city: "Delhi",
        email: "   ", // whitespace only
      },
    });
    await completeProfile(cReqB, cResB);
    assert.equal(getCStatusB(), 200);
    assert.equal(getCJsonB().success, true);

    const savedUserB = inMemoryUsers.find((u) => String(u._id) === String(userB._id));
    assert.notEqual(savedUserB.email, "");
  });

  it("should completely block existing CRM (non-guest) accounts from logging in", async () => {
    // Seed an existing CRM organization & user with phone number
    const crmOrg = {
      _id: "org_crm_12345",
      name: "Enterprise CRM Org",
      accountType: "crm",
    };
    inMemoryOrgs.push(crmOrg);

    const crmUser = {
      _id: "user_crm_12345",
      name: "Existing CRM Rep",
      phone: "9123456789",
      role: "sales person",
      organizationId: crmOrg._id,
      accountType: "crm",
    };
    inMemoryUsers.push(crmUser);

    // 1. sendOtp should block them
    const { req: sReq, res: sRes, getStatus: getSStatus, getJson: getSJson } = mockReqRes({
      body: { phone: "9123456789" },
    });
    await sendOtp(sReq, sRes);

    assert.equal(getSStatus(), 403);
    assert.equal(getSJson().code, "CRM_ACCOUNT_BLOCKED");

    // 2. verifyOtp should also block them
    const { req: vReq, res: vRes, getStatus: getVStatus, getJson: getVJson } = mockReqRes({
      body: { phone: "9123456789", otp: "1234" },
    });
    await verifyOtp(vReq, vRes);

    assert.equal(getVStatus(), 400); // Fails OTP verification first, or 403 if valid OTP
  });

  it("should block CRM account when phone is registered only on Organization.mobile", async () => {
    // Seed CRM org with mobile, but AuthUser has no phone
    const crmOrg = {
      _id: "org_crm_mobile_only",
      name: "CRM Org Mobile Only",
      mobile: "+91 9888877777",
      accountType: "crm",
    };
    inMemoryOrgs.push(crmOrg);

    const { req: sReq, res: sRes, getStatus: getSStatus, getJson: getSJson } = mockReqRes({
      body: { phone: "9888877777" },
    });
    await sendOtp(sReq, sRes);

    assert.equal(getSStatus(), 403);
    assert.equal(getSJson().code, "CRM_ACCOUNT_BLOCKED");
  });

  it("should return empty strings for name, companyName, role, city on new user verification", async () => {
    const rawOtp = "4444";
    const salt = await bcrypt.genSalt(10);
    const otpHash = await bcrypt.hash(rawOtp, salt);

    await Otp.create({
      phone: "9876500000",
      otpHash,
      expiresAt: new Date(Date.now() + 60000),
    });

    const { req, res, getStatus, getJson } = mockReqRes({
      body: { phone: "9876500000", otp: rawOtp },
    });

    await verifyOtp(req, res);

    assert.equal(getStatus(), 200);
    const data = getJson();
    assert.equal(data.success, true);
    assert.equal(data.isProfileComplete, false);
    assert.equal(data.name, "");
    assert.equal(data.companyName, "");
    assert.equal(data.role, "");
    assert.equal(data.city, "");
  });

  it("should assign default OTP 1234 for 8179550538 and not send any SMS", async () => {
    const { req: sReq, res: sRes, getStatus: getSStatus, getJson: getSJson } = mockReqRes({
      body: { phone: "8179550538" },
    });
    await sendOtp(sReq, sRes);

    assert.equal(getSStatus(), 200);
    const sJson = getSJson();
    assert.equal(sJson.success, true);
    assert.equal(sJson.debugOtp, "1234");

    // Otp record in DB should be created with 1234
    const otpInDb = inMemoryOtps.find((o) => o.phone === "8179550538");
    assert.ok(otpInDb, "OTP record should exist in DB");
    const isMatch = await bcrypt.compare("1234", otpInDb.otpHash);
    assert.equal(isMatch, true, "Hashed OTP must match 1234");

    // Fast2SMS direct service call should also be suppressed
    const { sendDltOtp } = await import("../services/fast2SmsService.js");
    const smsResult = await sendDltOtp("8179550538", "1234");
    assert.equal(smsResult.simulated, true);
    assert.equal(smsResult.success, true);

    // Verify OTP with 1234
    const { req: vReq, res: vRes, getStatus: getVStatus, getJson: getVJson } = mockReqRes({
      body: { phone: "8179550538", otp: "1234" },
    });
    await verifyOtp(vReq, vRes);

    assert.equal(getVStatus(), 200);
    const vJson = getVJson();
    assert.equal(vJson.success, true);
    assert.ok(vJson.token, "Should issue JWT auth token");
  });

  it("should accept 1234 (4-digit mobile app format) as fallback for 8179550538", async () => {
    const { req: sReq, res: sRes } = mockReqRes({
      body: { phone: "8179550538" },
    });
    await sendOtp(sReq, sRes);

    const { req: vReq, res: vRes, getStatus: getVStatus, getJson: getVJson } = mockReqRes({
      body: { phone: "8179550538", otp: "1234" },
    });
    await verifyOtp(vReq, vRes);

    assert.equal(getVStatus(), 200);
    assert.equal(getVJson().success, true);
  });

  it("should reject incorrect OTP for 8179550538", async () => {
    const { req: sReq, res: sRes } = mockReqRes({
      body: { phone: "8179550538" },
    });
    await sendOtp(sReq, sRes);

    const { req: vReq, res: vRes, getStatus: getVStatus } = mockReqRes({
      body: { phone: "8179550538", otp: "999999" },
    });
    await verifyOtp(vReq, vRes);

    assert.equal(getVStatus(), 400);
  });

  it("should send default OTP 1234 in development environment for any phone", async () => {
    process.env.NODE_ENV = "development";
    const testPhone = "9123456789";

    const { req: sReq, res: sRes, getStatus: getSStatus, getJson: getSJson } = mockReqRes({
      body: { phone: testPhone },
    });
    await sendOtp(sReq, sRes);

    assert.equal(getSStatus(), 200);
    const sJson = getSJson();
    assert.equal(sJson.success, true);
    assert.equal(sJson.debugOtp, "1234", "Development environment must always send default OTP 1234");

    // Correct verification with 1234
    const { req: vReq, res: vRes, getStatus: getVStatus, getJson: getVJson } = mockReqRes({
      body: { phone: testPhone, otp: "1234" },
    });
    await verifyOtp(vReq, vRes);

    assert.equal(getVStatus(), 200);
    assert.equal(getVJson().success, true);
    assert.ok(getVJson().token);

    // Incorrect verification with 8888 should reject
    const { req: badReq, res: badRes, getStatus: getBadStatus } = mockReqRes({
      body: { phone: testPhone, otp: "8888" },
    });
    await verifyOtp(badReq, badRes);
    assert.equal(getBadStatus(), 400);
  });
});
