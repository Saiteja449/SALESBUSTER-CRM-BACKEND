import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Organization from "../models/Organization.js";
import User from "../models/User.js";
import CallLog from "../models/CallLog.js";
import { getTenantModels } from "../services/tenantManager.js";
import { requireTelephonyAddon } from "../middleware/telephonyMiddleware.js";
import { downloadAndArchiveRecording } from "../services/telephonyService.js";

test("Organization model defines telephony add-on configuration", () => {
  const org = new Organization({
    name: "Test Telephony Org",
    email: "telephony@test.com",
    mobile: "+91 99999 88888",
    seats: 5,
    amountPaid: 1000,
    subscriptionPlan: "monthly",
    subscriptionEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    tenantDbName: "sb_tenant_test_telephony",
  });

  assert.equal(org.telephony.isAddonEnabled, false);
  assert.equal(org.telephony.isConfigured, false);
  assert.equal(org.telephony.sbcUri, "sbcind.telecmi.com");
  assert.equal(org.telephony.telecmiAppId, "");
  assert.equal(org.telephony.virtualNumber, "");
});

test("User model defines telephony credentials fields", () => {
  const user = new User({
    name: "Test Agent",
    email: "agent@test.com",
    password: "hashedpassword",
    role: "sales person",
  });

  assert.equal(user.telephony?.telecmiUserId, "");
  assert.equal(user.telephony?.telecmiPassword, "");
  assert.equal(user.telephony?.telecmiExtension, "");
  assert.equal(user.telephony?.isActive, true);
});

test("CallLog model validates required fields and generates clean schema", () => {
  const callLog = new CallLog({
    leadPhone: "+919876543210",
    cmiuid: "cmi_test_uuid_12345",
    callType: "outgoing",
    status: "connected",
    duration: 65,
    talkTime: 50,
    disposition: "Interested",
  });

  assert.equal(callLog.leadPhone, "+919876543210");
  assert.equal(callLog.cmiuid, "cmi_test_uuid_12345");
  assert.equal(callLog.duration, 65);
  assert.equal(callLog.talkTime, 50);
  assert.equal(callLog.status, "connected");
});

test("tenantManager registers CallLog model in tenant models", () => {
  const tenantModels = getTenantModels("sb_tenant_dummy_test");
  assert.ok(tenantModels.CallLog, "CallLog model must be registered in getTenantModels");
});

test("requireTelephonyAddon blocks requests when addon is disabled", () => {
  let nextCalled = false;
  let statusSent = null;
  let jsonSent = null;

  const req = {
    organization: {
      telephony: {
        isAddonEnabled: false,
      },
    },
    user: { role: "sales person" },
  };

  const res = {
    status(code) {
      statusSent = code;
      return {
        json(data) {
          jsonSent = data;
        },
      };
    },
  };

  const next = () => {
    nextCalled = true;
  };

  requireTelephonyAddon(req, res, next);
  assert.equal(nextCalled, false);
  assert.equal(statusSent, 403);
  assert.equal(jsonSent?.code, "TELEPHONY_ADDON_REQUIRED");
});

test("requireTelephonyAddon permits requests when addon is enabled", () => {
  let nextCalled = false;

  const req = {
    organization: {
      telephony: {
        isAddonEnabled: true,
      },
    },
    user: { role: "sales person" },
  };

  const res = {};
  const next = () => {
    nextCalled = true;
  };

  requireTelephonyAddon(req, res, next);
  assert.equal(nextCalled, true);
});

test("downloadAndArchiveRecording returns null when no filename provided", async () => {
  const result = await downloadAndArchiveRecording("appid", "secret", null);
  assert.equal(result, null);
});
