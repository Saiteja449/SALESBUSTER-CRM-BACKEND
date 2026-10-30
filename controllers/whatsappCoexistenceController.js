import fs from "fs";
import WAAccount from "../models/WhatsAppAccount.js";
import { encryptApiKey, decryptApiKey } from "../utils/encryption.js";
import { enqueueSyncJob } from "../services/whatsappSyncService.js";
import { getMasterModels } from "../services/tenantManager.js";

const getGraphApiVersion = () => process.env.META_GRAPH_API_VERSION || "v26.0";
const getGraphApiBaseUrl = () =>
  `https://graph.facebook.com/${getGraphApiVersion()}`;

/**
 * Handles official Meta WhatsApp Cloud API Embedded Signup v4 Onboarding with Coexistence.
 * POST /api/whatsapp/coexistence/onboard
 */
export const onboardCoexistenceAccount = async (req, res) => {
  const { code, wabaId: requestedWabaId, phoneNumberId: requestedPhoneId } = req.body;
  const organizationId =
    req.user?.organizationId || req.organization?._id;

  if (!organizationId) {
    return res.status(400).json({
      success: false,
      message: "Organization context is required for onboarding.",
    });
  }

  if (!code) {
    return res.status(400).json({
      success: false,
      message: "Meta authorization code is required.",
    });
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    return res.status(500).json({
      success: false,
      message:
        "Server configuration error: META_APP_ID or META_APP_SECRET is missing.",
    });
  }

  try {
    // -------------------------------------------------------------
    // STEP 1: Exchange Authorization Code for System/User Access Token
    // -------------------------------------------------------------
    const tokenUrl = new URL(`${getGraphApiBaseUrl()}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", appId);
    tokenUrl.searchParams.set("client_secret", appSecret);
    tokenUrl.searchParams.set("code", code);

    const tokenRes = await fetch(tokenUrl.toString(), { method: "GET" });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("[CoexistenceOnboard] Token exchange failure:", tokenData);
      return res.status(400).json({
        success: false,
        message:
          tokenData.error?.message || "Failed to exchange authorization code with Meta.",
      });
    }

    const accessToken = tokenData.access_token;
    const encryptedToken = encryptApiKey(accessToken);

    // -------------------------------------------------------------
    // STEP 2: Resolve WABA ID and Subscribe App
    // -------------------------------------------------------------
    let wabaId = requestedWabaId;
    let phoneNumberId = requestedPhoneId;

    // Fallback 1: Resolve WABA ID from phoneNumberId if provided
    if (!wabaId && phoneNumberId) {
      try {
        const phoneCheckRes = await fetch(
          `${getGraphApiBaseUrl()}/${phoneNumberId}?fields=whatsapp_business_account`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const phoneCheckData = await phoneCheckRes.json();
        if (phoneCheckData?.whatsapp_business_account?.id) {
          wabaId = phoneCheckData.whatsapp_business_account.id;
          console.log(`[CoexistenceOnboard] Resolved WABA ${wabaId} from phone ${phoneNumberId}`);
        }
      } catch (phoneErr) {
        console.warn("[CoexistenceOnboard] Warning resolving WABA from phone ID:", phoneErr.message);
      }
    }

    let debugData = null;
    let waWabaData = null;
    let bizData = null;

    // Fallback 2: Inspect debug_token granular_scopes
    if (!wabaId) {
      try {
        const debugUrl = new URL(`${getGraphApiBaseUrl()}/debug_token`);
        debugUrl.searchParams.set("input_token", accessToken);
        debugUrl.searchParams.set("access_token", `${appId}|${appSecret}`);

        const debugRes = await fetch(debugUrl.toString(), { method: "GET" });
        debugData = await debugRes.json();
        console.log("[CoexistenceOnboard] debug_token output:", JSON.stringify(debugData));
        const granularScopes = debugData.data?.granular_scopes || [];
        for (const scopeObj of granularScopes) {
          if (
            (scopeObj.scope === "whatsapp_business_management" ||
              scopeObj.scope === "whatsapp_business_messaging") &&
            Array.isArray(scopeObj.target_ids) &&
            scopeObj.target_ids.length > 0
          ) {
            wabaId = scopeObj.target_ids[0];
            break;
          }
        }
      } catch (debugErr) {
        console.warn("[CoexistenceOnboard] debug_token warning:", debugErr.message);
      }
    }

    // Fallback 3: Query /me/whatsapp_business_accounts
    if (!wabaId) {
      try {
        const waWabaRes = await fetch(
          `${getGraphApiBaseUrl()}/me/whatsapp_business_accounts`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        waWabaData = await waWabaRes.json();
        console.log("[CoexistenceOnboard] /me/whatsapp_business_accounts output:", JSON.stringify(waWabaData));
        if (Array.isArray(waWabaData.data) && waWabaData.data.length > 0) {
          wabaId = waWabaData.data[0].id;
        }
      } catch (waErr) {
        console.warn("[CoexistenceOnboard] /me/whatsapp_business_accounts warning:", waErr.message);
      }
    }

    // Fallback 4: Query /me/businesses (client & owned accounts)
    if (!wabaId) {
      try {
        const bizRes = await fetch(
          `${getGraphApiBaseUrl()}/me/businesses?fields=client_whatsapp_business_accounts{id,name},owned_whatsapp_business_accounts{id,name}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        bizData = await bizRes.json();
        console.log("[CoexistenceOnboard] /me/businesses output:", JSON.stringify(bizData));
        for (const biz of (bizData.data || [])) {
          const clientWabas = biz.client_whatsapp_business_accounts?.data || [];
          const ownedWabas = biz.owned_whatsapp_business_accounts?.data || [];
          if (clientWabas.length > 0) {
            wabaId = clientWabas[0].id;
            break;
          }
          if (ownedWabas.length > 0) {
            wabaId = ownedWabas[0].id;
            break;
          }
        }
      } catch (bizErr) {
        console.warn("[CoexistenceOnboard] /me/businesses warning:", bizErr.message);
      }
    }

    try {
      fs.writeFileSync(
        "coexistence_debug.log",
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            requestedWabaId,
            requestedPhoneId,
            tokenDataError: tokenData.error,
            scopes: debugData?.data?.scopes,
            granular_scopes: debugData?.data?.granular_scopes,
            waWabaData,
            bizData,
          },
          null,
          2
        )
      );
    } catch (logErr) {}

    if (!wabaId) {
      return res.status(400).json({
        success: false,
        message:
          "Unable to resolve WhatsApp Business Account (WABA) ID from token permissions. Please ensure your Meta App has WhatsApp permissions configured in Facebook Login for Business.",
      });
    }

    // Subscribe Meta App to the WABA's webhooks
    try {
      const subscribeRes = await fetch(
        `${getGraphApiBaseUrl()}/${wabaId}/subscribed_apps`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      const subData = await subscribeRes.json();
      console.log(`[CoexistenceOnboard] Subscribed apps result for WABA ${wabaId}:`, subData);
    } catch (subErr) {
      console.warn(`[CoexistenceOnboard] Subscribed apps warning for WABA ${wabaId}:`, subErr.message);
    }

    // -------------------------------------------------------------
    // STEP 3: Fetch Primary Phone Number ID from WABA
    // -------------------------------------------------------------
    let primaryPhone = null;

    if (phoneNumberId) {
      try {
        const singlePhoneRes = await fetch(
          `${getGraphApiBaseUrl()}/${phoneNumberId}?fields=id,display_phone_number,verified_name`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const singlePhoneData = await singlePhoneRes.json();
        if (singlePhoneData?.id) {
          primaryPhone = singlePhoneData;
        }
      } catch (singleErr) {
        console.warn("[CoexistenceOnboard] Warning fetching single phone details:", singleErr.message);
      }
    }

    if (!primaryPhone) {
      const phoneRes = await fetch(
        `${getGraphApiBaseUrl()}/${wabaId}/phone_numbers`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      const phoneData = await phoneRes.json();
      const allPhones = Array.isArray(phoneData.data) ? phoneData.data : [];
      // Prioritize real verified official numbers over sandbox 555 numbers
      primaryPhone =
        allPhones.find((p) => p.quality_rating === "GREEN" || (p.verified_name && !p.display_phone_number?.includes("555"))) ||
        allPhones[0];
    }

    if (!primaryPhone || !primaryPhone.id) {
      return res.status(400).json({
        success: false,
        message: "No phone number found under this WhatsApp Business Account.",
      });
    }

    phoneNumberId = primaryPhone.id;
    const displayPhone = primaryPhone.display_phone_number || primaryPhone.id;

    // -------------------------------------------------------------
    // STEP 4: Register Phone Number with Cloud API (Standard Onboarding)
    // -------------------------------------------------------------
    try {
      const regPin = process.env.META_TWO_STEP_VERIFICATION_PIN || "123456";
      const regRes = await fetch(
        `${getGraphApiBaseUrl()}/${phoneNumberId}/register`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            pin: regPin,
          }),
        }
      );
      const regData = await regRes.json();
      console.log(`[WhatsAppOnboard] Phone registration response for ${phoneNumberId}:`, regData);
      if (!regRes.ok && regData.error) {
        console.warn(`[WhatsAppOnboard] Phone registration notice: ${regData.error.message}`);
      }
    } catch (regErr) {
      console.warn(`[WhatsAppOnboard] Phone registration call warning:`, regErr.message);
    }

    // -------------------------------------------------------------
    // STEP 5: Verify Capability Flags
    // -------------------------------------------------------------
    let isOnBizApp = false;
    let platformType = "CLOUD_API";

    try {
      const verifyRes = await fetch(
        `${getGraphApiBaseUrl()}/${phoneNumberId}?fields=is_on_biz_app,platform_type`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      const verifyData = await verifyRes.json();
      if (verifyData.is_on_biz_app !== undefined) {
        isOnBizApp = Boolean(verifyData.is_on_biz_app);
      }
      if (verifyData.platform_type) {
        platformType = verifyData.platform_type;
      }
    } catch (verifyErr) {
      console.warn(`[WhatsAppOnboard] Non-fatal check warning for ${phoneNumberId}:`, verifyErr.message);
    }

    // -------------------------------------------------------------
    // STEP 6: Multi-User / Rep Line Assignment Logic
    // -------------------------------------------------------------
    const isSalesRep =
      req.user?.role === "sales person" ||
      req.user?.role === "sales representative";
    const assignedUserId = isSalesRep ? req.user._id : null;

    // -------------------------------------------------------------
    // STEP 7: Persist WAAccount in Database
    // -------------------------------------------------------------
    const onboardedAt = new Date();
    const syncDeadline = new Date(onboardedAt.getTime() + 24 * 60 * 60 * 1000);
    const initialStatus = isOnBizApp ? "syncing" : "connected";

    const accountPayload = {
      organizationId,
      userId: assignedUserId,
      wabaId,
      phoneNumberId,
      displayPhone,
      accessTokenEncrypted: encryptedToken,
      status: initialStatus,
      isOnBizApp,
      platformType,
      onboardedAt,
      syncDeadline,
      disconnectReason: "",
      contactsSyncRequested: false,
      historySyncRequested: false,
      historySharingDeclined: false,
      "historyProgress.isComplete": !isOnBizApp,
      lastActivityAt: onboardedAt,
    };

    const account = await WAAccount.findOneAndUpdate(
      { phoneNumberId },
      { $set: accountPayload },
      { upsert: true, returnDocument: "after" }
    );

    // Synchronize to Master DB and Tenant DB
    try {
      const { WAAccount: MasterWA, Organization } = getMasterModels();
      await MasterWA.findOneAndUpdate(
        { phoneNumberId },
        { $set: accountPayload },
        { upsert: true }
      );
      if (req.tenantModels?.WAAccount) {
        await req.tenantModels.WAAccount.findOneAndUpdate(
          { phoneNumberId },
          { $set: accountPayload },
          { upsert: true }
        );
      } else {
        const orgRec = await Organization.findById(organizationId).lean();
        if (orgRec?.tenantDbName) {
          const tenantModels = getTenantModels(orgRec.tenantDbName);
          await tenantModels.WAAccount.findOneAndUpdate(
            { phoneNumberId },
            { $set: accountPayload },
            { upsert: true }
          );
        }
      }
    } catch (syncDbErr) {
      console.warn("[WhatsAppOnboard] Cross-database sync warning:", syncDbErr.message);
    }

    // Also update Organization.whatsappCloudSettings for backward-compatibility with existing campaigns
    try {
      const { Organization } = getMasterModels();
      await Organization.findByIdAndUpdate(organizationId, {
        $set: {
          "whatsappCloudSettings.isConfigured": true,
          "whatsappCloudSettings.wabaId": wabaId,
          "whatsappCloudSettings.phoneNumberId": phoneNumberId,
          "whatsappCloudSettings.displayPhoneNumber": displayPhone,
          "whatsappCloudSettings.accessTokenEncrypted": encryptedToken,
          "whatsappCloudSettings.lastSyncedAt": onboardedAt,
        },
      });
    } catch (orgErr) {
      console.warn("[WhatsAppOnboard] Org cloud settings mirror error:", orgErr.message);
    }

    // -------------------------------------------------------------
    // STEP 8: If Coexistence mobile app, enqueue sync; else complete
    // -------------------------------------------------------------
    if (isOnBizApp) {
      await enqueueSyncJob({
        accountId: account._id.toString(),
        phoneNumberId,
        accessToken,
      });
    }

    return res.status(200).json({
      success: true,
      message: "WhatsApp Business Coexistence connected successfully. Sync underway.",
      account: {
        id: account._id,
        phoneNumberId: account.phoneNumberId,
        displayPhone: account.displayPhone,
        status: account.status,
        isOnBizApp: account.isOnBizApp,
        syncDeadline: account.syncDeadline,
        isRepLine: Boolean(assignedUserId),
      },
    });
  } catch (error) {
    console.error("[CoexistenceOnboardError]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "An unexpected error occurred during coexistence onboarding.",
    });
  }
};

/**
 * Disconnects a Coexistence account.
 * POST /api/whatsapp/coexistence/disconnect
 */
export const disconnectCoexistenceAccount = async (req, res) => {
  try {
    const { phoneNumberId, accountId } = req.body;
    const organizationId = req.user?.organizationId || req.organization?._id;
    const isSalesRep =
      req.user?.role === "sales person" ||
      req.user?.role === "sales representative";

    const query = { organizationId };
    if (accountId) {
      query._id = accountId;
    } else if (phoneNumberId) {
      query.phoneNumberId = phoneNumberId;
    } else if (isSalesRep) {
      query.userId = req.user._id;
    }

    // 1. Mark disconnected across Default DB
    await WAAccount.updateMany(query, {
      $set: { status: "disconnected", disconnectReason: "USER_REMOVED" },
    });

    // 2. Mark disconnected across Master DB and Tenant DB
    try {
      const { Organization, WAAccount: MasterWA } = getMasterModels();
      await MasterWA.updateMany(query, {
        $set: { status: "disconnected", disconnectReason: "USER_REMOVED" },
      });

      if (req.tenantModels?.WAAccount) {
        await req.tenantModels.WAAccount.updateMany(query, {
          $set: { status: "disconnected", disconnectReason: "USER_REMOVED" },
        });
      } else {
        const orgRec = await Organization.findById(organizationId).lean();
        if (orgRec?.tenantDbName) {
          const tenantModels = getTenantModels(orgRec.tenantDbName);
          await tenantModels.WAAccount.updateMany(query, {
            $set: { status: "disconnected", disconnectReason: "USER_REMOVED" },
          });
        }
      }

      // 3. Mark Organization whatsappCloudSettings as unconfigured
      await Organization.findByIdAndUpdate(organizationId, {
        $set: {
          "whatsappCloudSettings.isConfigured": false,
          "whatsappCloudSettings.lastSyncedAt": new Date(),
        },
      });
    } catch (dbErr) {
      console.warn("[CoexistenceDisconnect] Multi-DB disconnect sync warning:", dbErr.message);
    }

    console.log(`[CoexistenceDisconnect] Line ${phoneNumberId || organizationId} marked disconnected.`);

    return res.status(200).json({
      success: true,
      message: "WhatsApp Business line disconnected successfully.",
    });
  } catch (error) {
    console.error("[CoexistenceDisconnectError]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to disconnect WhatsApp line.",
    });
  }
};

/**
 * Retrieves the current coexistence connection and sync status.
 * GET /api/whatsapp/coexistence/status
 */
export const getCoexistenceStatus = async (req, res) => {
  try {
    const organizationId = req.user?.organizationId || req.organization?._id;
    const isSalesRep =
      req.user?.role === "sales person" ||
      req.user?.role === "sales representative";

    if (isSalesRep) {
      // Rep sees their personal line or organization fallback
      let account = await WAAccount.findOne({
        organizationId,
        userId: req.user._id,
      }).lean();

      if (!account) {
        // Fallback to org line for reading
        account = await WAAccount.findOne({
          organizationId,
          userId: null,
        }).lean();
      }

      return res.status(200).json({
        success: true,
        isRepSession: true,
        account: account
          ? {
              id: account._id,
              phoneNumberId: account.phoneNumberId,
              displayPhone: account.displayPhone,
              status: account.status,
              isOnBizApp: account.isOnBizApp,
              syncDeadline: account.syncDeadline,
              historyProgress: account.historyProgress,
              historySharingDeclined: account.historySharingDeclined,
            }
          : null,
      });
    }

    // Admins and Managers see all lines in the organization
    const accounts = await WAAccount.find({ organizationId })
      .populate("userId", "name email role phone")
      .lean();

    return res.status(200).json({
      success: true,
      accounts: accounts.map((acc) => ({
        id: acc._id,
        phoneNumberId: acc.phoneNumberId,
        displayPhone: acc.displayPhone,
        status: acc.status,
        isOnBizApp: acc.isOnBizApp,
        assignedUser: acc.userId,
        isOrgLine: !acc.userId,
        syncDeadline: acc.syncDeadline,
        historyProgress: acc.historyProgress,
        historySharingDeclined: acc.historySharingDeclined,
      })),
    });
  } catch (error) {
    console.error("[CoexistenceStatusError]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to retrieve WhatsApp coexistence status.",
    });
  }
};
