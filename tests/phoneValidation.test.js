import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateAndNormalizePhone,
  buildPhoneDuplicateQuery,
} from "../helpers/phoneHelper.js";
import { addSalesPerson } from "../controllers/userController.js";

describe("Phone Validation & Normalization Helper", () => {
  it("normalizes a 10-digit Indian mobile number to E.164 (+91)", () => {
    const res = validateAndNormalizePhone("9876543210");
    assert.equal(res.isValid, true);
    assert.equal(res.normalized, "+919876543210");
    assert.equal(res.cleanDigits, "9876543210");
  });

  it("normalizes a formatted Indian mobile number with spaces and dashes", () => {
    const res = validateAndNormalizePhone("+91 98765-43210");
    assert.equal(res.isValid, true);
    assert.equal(res.normalized, "+919876543210");
    assert.equal(res.cleanDigits, "919876543210");
  });

  it("normalizes a number with leading zero (09876543210)", () => {
    const res = validateAndNormalizePhone("09876543210");
    assert.equal(res.isValid, true);
    assert.equal(res.normalized, "+919876543210");
  });

  it("handles valid international numbers with country codes", () => {
    const res = validateAndNormalizePhone("+1 415 555 2671");
    assert.equal(res.isValid, true);
    assert.equal(res.normalized, "+14155552671");
  });

  it("rejects numbers that are too short", () => {
    const res = validateAndNormalizePhone("98765");
    assert.equal(res.isValid, false);
    assert.ok(res.error.includes("between 10 and 15 digits"));
  });

  it("rejects numbers that are too long", () => {
    const res = validateAndNormalizePhone("123456789012345678");
    assert.equal(res.isValid, false);
    assert.ok(res.error.includes("between 10 and 15 digits"));
  });

  it("rejects repeating dummy numbers", () => {
    const res1 = validateAndNormalizePhone("0000000000");
    assert.equal(res1.isValid, false);
    assert.ok(res1.error.includes("Repeating dummy numbers"));

    const res2 = validateAndNormalizePhone("1111111111");
    assert.equal(res2.isValid, false);
  });

  it("rejects empty or whitespace-only phone", () => {
    const res1 = validateAndNormalizePhone("");
    assert.equal(res1.isValid, false);

    const res2 = validateAndNormalizePhone("   ");
    assert.equal(res2.isValid, false);
  });

  it("builds a comprehensive MongoDB query to catch duplicate formats", () => {
    const query = buildPhoneDuplicateQuery("+919876543210", "9876543210");
    assert.ok(Array.isArray(query.$or));
    const phoneVals = query.$or.map((c) => (c.phone instanceof RegExp ? c.phone.source : c.phone));
    assert.ok(phoneVals.includes("+919876543210"));
    assert.ok(phoneVals.includes("9876543210"));
    assert.ok(phoneVals.includes("+9876543210"));
  });
});

describe("addSalesPerson Unique Phone Enforcement Controller", () => {
  it("rejects creation if mobile number is already registered in tenant", async () => {
    let statusCode = null;
    let responseBody = null;

    const req = {
      user: { role: "sales manager", organizationId: "66dd0a1a2c3d4e5f6a7b8c8f" },
      organization: { _id: "66dd0a1a2c3d4e5f6a7b8c8f", seats: 10 },
      body: {
        name: "Test Rep",
        email: "unique@acme.io",
        phone: "9876543210",
      },
      tenantModels: {
        User: {
          countDocuments: async () => 2,
          findOne: async (query) => {
            if (query.$or) {
              return { _id: "existing_user_id", phone: "+919876543210" };
            }
            return null;
          },
        },
      },
    };

    const res = {
      status: (code) => {
        statusCode = code;
        return {
          json: (data) => {
            responseBody = data;
          },
        };
      },
    };

    await addSalesPerson(req, res);

    assert.equal(statusCode, 400);
    assert.equal(responseBody.success, false);
    assert.equal(responseBody.field, "phone");
    assert.ok(responseBody.message.includes("already exists in your team"));
  });

  it("rejects creation if mobile number is invalid format", async () => {
    let statusCode = null;
    let responseBody = null;

    const req = {
      user: { role: "sales manager", organizationId: "66dd0a1a2c3d4e5f6a7b8c8f" },
      organization: { _id: "66dd0a1a2c3d4e5f6a7b8c8f", seats: 10 },
      body: {
        name: "Test Rep",
        email: "unique@acme.io",
        phone: "0000000000",
      },
    };

    const res = {
      status: (code) => {
        statusCode = code;
        return {
          json: (data) => {
            responseBody = data;
          },
        };
      },
    };

    await addSalesPerson(req, res);

    assert.equal(statusCode, 400);
    assert.equal(responseBody.success, false);
    assert.equal(responseBody.field, "phone");
    assert.ok(responseBody.message.includes("dummy numbers"));
  });
});
