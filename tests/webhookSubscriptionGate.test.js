import assert from "node:assert/strict";
import test from "node:test";
import { isOrganizationSubscriptionActive } from "../services/addonEntitlementService.js";
import { processChangeItem } from "../controllers/whatsappWebhookController.js";
import { handleInstagramWebhook } from "../controllers/instagramController.js";

const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

test("isOrganizationSubscriptionActive checks status, trialEndsAt for trials, and subscriptionEndDate for paid plans", () => {
  assert.equal(
    isOrganizationSubscriptionActive({
      status: "active",
      isTrial: true,
      trialEndsAt: futureDate,
    }),
    true
  );
  assert.equal(
    isOrganizationSubscriptionActive({
      status: "active",
      isTrial: true,
      trialEndsAt: pastDate,
      subscriptionEndDate: futureDate, // trialEndsAt must take precedence for trials
    }),
    false
  );
  assert.equal(
    isOrganizationSubscriptionActive({
      status: "active",
      isTrial: false,
      subscriptionEndDate: futureDate,
    }),
    true
  );
  assert.equal(
    isOrganizationSubscriptionActive({
      status: "active",
      isTrial: false,
      subscriptionEndDate: pastDate,
    }),
    false
  );
  assert.equal(
    isOrganizationSubscriptionActive({
      status: "suspended",
      isTrial: false,
      subscriptionEndDate: futureDate,
    }),
    false
  );
  assert.equal(
    isOrganizationSubscriptionActive({
      status: "active",
      isTrial: false,
      isExpired: true,
      subscriptionEndDate: futureDate,
    }),
    false
  );
});

test("WhatsApp processChangeItem skips expired trial and expired paid organizations and marks event processed", async () => {
  for (const org of [
    {
      _id: "org_trial_exp",
      tenantDbName: "tenant_trial_exp",
      status: "active",
      isTrial: true,
      trialEndsAt: pastDate,
    },
    {
      _id: "org_paid_exp",
      tenantDbName: "tenant_paid_exp",
      status: "active",
      isTrial: false,
      subscriptionEndDate: pastDate,
    },
  ]) {
    const eventUpdates = [];
    let tenantDbAccessed = 0;
    const proxiedOrg = new Proxy(org, {
      get(target, prop) {
        if (prop === "tenantDbName") {
          tenantDbAccessed += 1;
        }
        return target[prop];
      },
    });

    await processChangeItem(
      {
        entryId: "waba_1",
        field: "messages",
        phoneNumberId: "phone_1",
        changeLevelEventId: "evt_1",
        value: {
          messages: [{ id: "m1", from: "919999999999", type: "text", text: { body: "Hi" } }],
        },
      },
      {
        Organization: {
          findById: async () => proxiedOrg,
          findOne: async () => proxiedOrg,
        },
        WAAccount: {
          findOne: async () => ({ organizationId: org._id, phoneNumberId: "phone_1" }),
        },
        WAWebhookEvent: {
          updateOne: async (filter, update) => {
            eventUpdates.push({ filter, update });
          },
        },
      }
    );

    // tenantDbName is checked once for `!org.tenantDbName`, then subscription gate returns before getTenantModels
    assert.equal(tenantDbAccessed, 1);
    assert.equal(eventUpdates.length, 1);
    assert.equal(eventUpdates[0].update.$set.status, "processed");
  }
});

test("WhatsApp processChangeItem proceeds for active organizations", async () => {
  const activeOrg = {
    _id: "org_active",
    tenantDbName: "tenant_active_test_db",
    status: "active",
    isTrial: false,
    subscriptionEndDate: futureDate,
  };
  let tenantDbAccessed = 0;
  const proxiedOrg = new Proxy(activeOrg, {
    get(target, prop) {
      if (prop === "tenantDbName") {
        tenantDbAccessed += 1;
      }
      return target[prop];
    },
  });

  await processChangeItem(
    {
      entryId: "waba_1",
      field: "unknown_noop_field",
      phoneNumberId: "phone_1",
      changeLevelEventId: "evt_active",
      value: {},
    },
    {
      Organization: {
        findById: async () => proxiedOrg,
        findOne: async () => proxiedOrg,
      },
      WAAccount: {
        findOne: async () => ({ organizationId: activeOrg._id, phoneNumberId: "phone_1" }),
      },
      WAWebhookEvent: {
        updateOne: async () => {},
      },
    }
  );

  // Accessed twice: once in `!org.tenantDbName` guard, once in `getTenantModels(org.tenantDbName)`
  assert.equal(tenantDbAccessed, 2);
});

test("Instagram handleInstagramWebhook acknowledges Meta 200 and skips expired trial/paid messages and comments", async () => {
  for (const org of [
    {
      _id: "ig_trial_exp",
      tenantDbName: "tenant_ig_trial",
      status: "active",
      isTrial: true,
      trialEndsAt: pastDate,
    },
    {
      _id: "ig_paid_exp",
      tenantDbName: "tenant_ig_paid",
      status: "active",
      isTrial: false,
      subscriptionEndDate: pastDate,
    },
  ]) {
    let statusCode = 0;
    let bodySent = "";
    let fallbackScanCalled = false;

    const req = {
      app: { get: () => null },
      body: {
        object: "instagram",
        entry: [
          {
            id: "ig_biz_1",
            time: Date.now(),
            messaging: [
              {
                sender: { id: "user_1" },
                recipient: { id: "ig_biz_1" },
                message: { mid: "mid_1", text: "Hello" },
              },
            ],
            changes: [
              {
                field: "comments",
                value: {
                  id: "comment_1",
                  text: "Price please",
                  from: { id: "user_2", username: "buyer" },
                },
              },
            ],
          },
        ],
      },
      masterModels: {
        InstagramAccount: {
          findOne: () => ({
            lean: async () => ({ organizationId: org._id, instagramBusinessId: "ig_biz_1" }),
          }),
        },
        Organization: {
          findById: () => ({
            lean: async () => org,
          }),
          find: () => ({
            lean: async () => {
              fallbackScanCalled = true;
              return [];
            },
          }),
        },
      },
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      send(payload) {
        bodySent = payload;
        return this;
      },
    };

    await handleInstagramWebhook(req, res);

    assert.equal(statusCode, 200);
    assert.equal(bodySent, "EVENT_RECEIVED");
    assert.equal(fallbackScanCalled, false);
  }
});
