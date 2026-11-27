import crypto from "crypto";
import mongoose from "mongoose";
import { encryptApiKey, decryptApiKey } from "../utils/encryption.js";
import { getMasterModels, getTenantModels } from "../services/tenantManager.js";
import {
  sendInstagramMessage,
  handleIncomingInstagramComment,
  handleIncomingInstagramMessage,
  syncRecentInstagramComments,
} from "../services/instagramService.js";

const getGraphApiVersion = () => process.env.META_GRAPH_API_VERSION || "v21.0";
const getGraphApiBaseUrl = () => `https://graph.facebook.com/${getGraphApiVersion()}`;

/**
 * Webhook Verification (GET /api/instagram/webhook)
 */
export const verifyInstagramWebhook = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const expectedToken =
    process.env.META_VERIFY_TOKEN ||
    process.env.WHATSAPP_CLOUD_VERIFY_TOKEN ||
    "salesbuster_meta_verify_token_2026";

  if (mode === "subscribe" && token === expectedToken) {
    console.log("[InstagramWebhook] Webhook successfully verified by Meta.");
    return res.status(200).send(challenge);
  }

  console.warn("[InstagramWebhook] Verification failed. Token mismatch.");
  return res.sendStatus(403);
};

/**
 * Webhook Ingestion (POST /api/instagram/webhook)
 */
export const handleInstagramWebhook = async (req, res) => {
  // Acknowledge Meta immediately
  res.status(200).send("EVENT_RECEIVED");

  const body = req.body;
  console.log("[InstagramWebhook] Incoming event:", JSON.stringify(body));

  if (body?.object !== "instagram" && body?.object !== "page") {
    return;
  }

  const io = req.app.get("io");

  try {
    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
      const pageOrIgId = entry.id ? String(entry.id) : null;
      if (!pageOrIgId) continue;

      // Fast O(1) indexed lookup from Master DB cache first
      const { Organization, InstagramAccount: MasterInstagramAccount } = getMasterModels();
      let matchedOrg = null;
      let tenantModels = null;
      let matchedAccount = null;

      if (MasterInstagramAccount) {
        const cachedMasterAcc = await MasterInstagramAccount.findOne({
          $or: [{ instagramBusinessId: pageOrIgId }, { facebookPageId: pageOrIgId }],
          status: "connected",
        }).lean();

        if (cachedMasterAcc && cachedMasterAcc.organizationId) {
          const org = await Organization.findById(cachedMasterAcc.organizationId).lean();
          if (org && org.status !== "suspended" && org.tenantDbName) {
            matchedOrg = org;
            tenantModels = getTenantModels(org.tenantDbName);
            matchedAccount = await tenantModels.InstagramAccount.findOne({
              organizationId: org._id,
              status: "connected",
            });
          }
        }
      }

      // Fallback: Scan active organizations if not yet indexed in master cache
      if (!matchedOrg || !tenantModels) {
        const orgs = await Organization.find({ status: { $ne: "suspended" } }).lean();
        for (const org of orgs) {
          if (!org.tenantDbName) continue;
          const models = getTenantModels(org.tenantDbName);
          const acc = await models.InstagramAccount.findOne({
            $or: [{ instagramBusinessId: pageOrIgId }, { facebookPageId: pageOrIgId }],
            status: "connected",
          });

          if (acc) {
            matchedOrg = org;
            tenantModels = models;
            matchedAccount = acc;
            break;
          }
        }
      }

      if (!matchedOrg || !tenantModels) {
        console.warn(`[InstagramWebhook] No organization found for ID: ${pageOrIgId}`);
        continue;
      }

      const orgId = matchedOrg._id;

      // 1. Direct Messages
      if (Array.isArray(entry.messaging)) {
        for (const messageEvent of entry.messaging) {
          if (messageEvent.message && !messageEvent.message.is_echo) {
            await handleIncomingInstagramMessage({
              messageEvent,
              organizationId: orgId,
              tenantModels,
              io,
            });
          }
        }
      }

      // 2. Changes (e.g. comments on Posts or Reels)
      if (Array.isArray(entry.changes)) {
        for (const change of entry.changes) {
          console.log(`[InstagramWebhook] Change received (field: '${change.field}'):`, JSON.stringify(change.value));
          const isComment =
            change.field === "comments" ||
            change.field === "comment" ||
            change.field === "live_comments" ||
            (change.field === "feed" && (change.value?.item === "comment" || change.value?.comment_id));

          if (isComment && change.value) {
            const commentEvent = {
              ...change.value,
              // Fallback to entry timestamp if not provided inside change.value
              created_time: change.value.created_time || change.value.timestamp || entry.time,
            };
            await handleIncomingInstagramComment({
              commentEvent,
              organizationId: orgId,
              tenantModels,
              io,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("[InstagramWebhook] Event processing error:", err);
  }
};

/**
 * Connects an Instagram Business Account via Facebook User Access Token
 * POST /api/instagram/onboard
 */
export const onboardInstagramAccount = async (req, res) => {
  const { accessToken, userId, targetInstagramId } = req.body;
  const organizationId = req.user?.organizationId || req.organization?._id;

  if (!organizationId) {
    return res.status(400).json({ success: false, message: "Organization context required." });
  }

  if (!accessToken) {
    return res.status(400).json({ success: false, message: "User access token is required." });
  }

  try {
    // 0. Optional Upgrade: Exchange for 60-day Long-Lived Token if META_APP_SECRET is configured
    // This allows Meta to return permanent (never-expiring) Page Access Tokens
    let effectiveUserToken = accessToken;
    const metaAppSecret = process.env.META_APP_SECRET;
    const metaAppId = process.env.META_APP_ID || "1486860230013437";

    if (metaAppSecret) {
      try {
        const exchangeUrl = `${getGraphApiBaseUrl()}/oauth/access_token?grant_type=fb_exchange_token&client_id=${metaAppId}&client_secret=${metaAppSecret}&fb_exchange_token=${accessToken}`;
        const exRes = await fetch(exchangeUrl);
        const exData = await exRes.json();
        if (exData.access_token) {
          effectiveUserToken = exData.access_token;
          console.log("[InstagramOnboard] Upgraded to long-lived Meta User Token (never-expiring page token enabled).");
        }
      } catch (exErr) {
        console.warn("[InstagramOnboard] Long-lived token exchange warning:", exErr.message);
      }
    }

    // 1. Get Facebook Pages and linked Instagram Business Account
    const pagesUrl = `${getGraphApiBaseUrl()}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}`;
    const pagesRes = await fetch(pagesUrl, {
      headers: { Authorization: `Bearer ${effectiveUserToken}` },
    });
    const pagesData = await pagesRes.json();

    if (!pagesRes.ok || !Array.isArray(pagesData.data) || pagesData.data.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No Facebook Pages found. Please ensure you have admin access to a Facebook Page.",
      });
    }

    // Filter pages that have a connected Instagram Business Account
    const pagesWithIg = pagesData.data.filter((p) => p.instagram_business_account?.id);
    if (!pagesWithIg.length) {
      return res.status(400).json({
        success: false,
        message:
          "Found Facebook Pages, but none have a connected Instagram Professional/Business account. Please connect your Instagram profile to your Facebook Page first.",
      });
    }

    // If multiple Instagram accounts are found and user hasn't selected one yet, prompt selection
    if (pagesWithIg.length > 1 && !targetInstagramId) {
      return res.status(200).json({
        success: true,
        requiresSelection: true,
        availableAccounts: pagesWithIg.map((p) => ({
          pageId: p.id,
          pageName: p.name,
          instagramId: p.instagram_business_account.id,
          username: p.instagram_business_account.username,
          name: p.instagram_business_account.name || p.instagram_business_account.username,
          profilePictureUrl: p.instagram_business_account.profile_picture_url || "",
        })),
      });
    }

    // Find the target page or default to the first one
    const pageWithIg = targetInstagramId
      ? pagesWithIg.find((p) => p.instagram_business_account?.id === targetInstagramId) || pagesWithIg[0]
      : pagesWithIg[0];

    const pageId = pageWithIg.id;
    const pageToken = pageWithIg.access_token;
    const igAccount = pageWithIg.instagram_business_account;
    const igId = igAccount.id;
    const username = igAccount.username;
    const name = igAccount.name || username;
    const profilePic = igAccount.profile_picture_url || "";

    const encryptedPageToken = encryptApiKey(pageToken);

    // 2. Subscribe Page and Instagram Account to Webhooks
    try {
      const pageSubUrl = `${getGraphApiBaseUrl()}/${pageId}/subscribed_apps?subscribed_fields=feed,messages,messaging_postbacks,conversations`;
      const pageRes = await fetch(pageSubUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${pageToken}` },
      });
      let pageSubData = await pageRes.json();
      if (pageSubData?.error) {
        // Fallback to feed if pages_messaging is not yet granted on the page token
        try {
          const fallbackPageRes = await fetch(
            `${getGraphApiBaseUrl()}/${pageId}/subscribed_apps?subscribed_fields=feed`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${pageToken}` },
            }
          );
          const fallbackPageData = await fallbackPageRes.json();
          if (fallbackPageData?.success) pageSubData = fallbackPageData;
        } catch (_) {}
      }
      console.log("[InstagramOnboard] Page subscribed_apps response:", pageSubData);

      if (igId) {
        const igSubUrl = `${getGraphApiBaseUrl()}/${igId}/subscribed_apps?subscribed_fields=comments,messages,messaging_postbacks,live_comments`;
        const igSubRes = await fetch(igSubUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${pageToken}` },
        });
        let igSubData = await igSubRes.json();
        if (igSubData?.error) {
          // Fallback to direct app install on IG user edge without fields if rejected
          try {
            const fallbackRes = await fetch(`${getGraphApiBaseUrl()}/${igId}/subscribed_apps`, {
              method: "POST",
              headers: { Authorization: `Bearer ${pageToken}` },
            });
            const fallbackData = await fallbackRes.json();
            if (fallbackData?.success) igSubData = fallbackData;
          } catch (_) {}
        }
        console.log("[InstagramOnboard] IG subscribed_apps response:", igSubData);
      }
    } catch (subErr) {
      console.warn("[InstagramOnboard] Subscribed apps warning:", subErr.message);
    }

    // 3. Persist in Database
    const tenantModels = req.tenantModels || getTenantModels(req.organization?.tenantDbName);
    const { InstagramAccount } = tenantModels;

    const account = await InstagramAccount.findOneAndUpdate(
      { organizationId },
      {
        $set: {
          organizationId,
          userId: userId || req.user?._id || null,
          instagramBusinessId: igId,
          facebookPageId: pageId,
          pageAccessTokenEncrypted: encryptedPageToken,
          username,
          name,
          profilePictureUrl: profilePic,
          status: "connected",
          disconnectReason: "",
          connectedAt: new Date(),
          lastActivityAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after" }
    );

    // Sync master index for fast O(1) webhook routing
    try {
      const { InstagramAccount: MasterInstagramAccount } = getMasterModels();
      if (MasterInstagramAccount) {
        await MasterInstagramAccount.findOneAndUpdate(
          { organizationId },
          {
            $set: {
              organizationId,
              userId: userId || req.user?._id || null,
              instagramBusinessId: igId,
              facebookPageId: pageId,
              pageAccessTokenEncrypted: encryptedPageToken,
              username,
              name,
              profilePictureUrl: profilePic,
              status: "connected",
              disconnectReason: "",
              connectedAt: new Date(),
              lastActivityAt: new Date(),
            },
          },
          { upsert: true }
        );
      }
    } catch (masterSyncErr) {
      console.warn("[InstagramOnboard] Master index sync warning:", masterSyncErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `Instagram @${username} connected successfully!`,
      account: {
        id: account._id,
        username: account.username,
        name: account.name,
        profilePictureUrl: account.profilePictureUrl,
        status: account.status,
      },
    });
  } catch (err) {
    console.error("[InstagramOnboard] Error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to complete Instagram onboarding.",
    });
  }
};

/**
 * Refreshes / re-subscribes webhooks for connected Instagram & Page
 * POST /api/instagram/subscribe-webhooks
 */
export const resubscribeInstagramWebhooks = async (req, res) => {
  const organizationId = req.user?.organizationId || req.organization?._id;
  const tenantModels = req.tenantModels || getTenantModels(req.organization?.tenantDbName);

  try {
    const account = await tenantModels.InstagramAccount.findOne({
      organizationId,
      status: "connected",
    });

    if (!account || !account.pageAccessTokenEncrypted) {
      return res.status(400).json({
        success: false,
        message: "No connected Instagram account found. Please connect your account first.",
      });
    }

    const pageToken = decryptApiKey(account.pageAccessTokenEncrypted);
    if (!pageToken) {
      return res.status(400).json({
        success: false,
        message: "Page access token could not be decrypted or is missing. Please disconnect and reconnect your Instagram account.",
      });
    }

    const pageId = account.facebookPageId;
    const igId = account.instagramBusinessId;

    let pageSubData = null;
    let igSubData = null;

    if (pageId) {
      const pageSubUrl = `${getGraphApiBaseUrl()}/${pageId}/subscribed_apps?subscribed_fields=feed,messages,messaging_postbacks,conversations`;
      const pageRes = await fetch(pageSubUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${pageToken}` },
      });
      pageSubData = await pageRes.json();
      if (pageSubData?.error) {
        // Fallback to feed if pages_messaging is not yet granted on the page token
        try {
          const fallbackPageRes = await fetch(
            `${getGraphApiBaseUrl()}/${pageId}/subscribed_apps?subscribed_fields=feed`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${pageToken}` },
            }
          );
          const fallbackPageData = await fallbackPageRes.json();
          if (fallbackPageData?.success) pageSubData = fallbackPageData;
        } catch (_) {}
      }
    }

    if (igId) {
      const igSubUrl = `${getGraphApiBaseUrl()}/${igId}/subscribed_apps?subscribed_fields=comments,messages,messaging_postbacks,live_comments`;
      const igRes = await fetch(igSubUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${pageToken}` },
      });
      igSubData = await igRes.json();
      if (igSubData?.error) {
        try {
          const fallbackRes = await fetch(`${getGraphApiBaseUrl()}/${igId}/subscribed_apps`, {
            method: "POST",
            headers: { Authorization: `Bearer ${pageToken}` },
          });
          const fallbackData = await fallbackRes.json();
          if (fallbackData?.success) igSubData = fallbackData;
        } catch (_) {}
      }
    }

    console.log("[InstagramSubscribe] Meta response:", { pageSubData, igSubData });

    account.lastActivityAt = new Date();
    await account.save();

    return res.status(200).json({
      success: true,
      message: "Webhook subscriptions refreshed successfully with Meta.",
      pageResult: pageSubData,
      igResult: igSubData,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Manual Trigger to sync recent comments from Meta Graph API
 * POST /api/instagram/sync-comments
 */
export const syncInstagramCommentsHandler = async (req, res) => {
  const organizationId = req.user?.organizationId || req.organization?._id;
  if (!organizationId) {
    return res.status(400).json({ success: false, message: "Organization context required." });
  }

  const io = req.app.get("io");
  try {
    const result = await syncRecentInstagramComments(organizationId, io);
    return res.status(200).json({
      success: true,
      message: `Sync completed. ${result.synced || 0} new comment(s) imported.`,
      result,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Gets the current Instagram connection status
 * GET /api/instagram/status
 */
export const getInstagramStatus = async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  const organizationId = req.user?.organizationId || req.organization?._id;
  const tenantModels = req.tenantModels || getTenantModels(req.organization?.tenantDbName);

  try {
    let account = null;

    // 1. Primary check: Tenant-scoped database
    if (tenantModels?.InstagramAccount) {
      account = await tenantModels.InstagramAccount.findOne({
        organizationId,
        status: "connected",
      });
    }

    // 2. Secondary fallback check: Master database (prevents false logouts if tenant context shifts)
    if (!account) {
      try {
        const { InstagramAccount: MasterInstagramAccount } = getMasterModels();
        if (MasterInstagramAccount) {
          const masterAcc = await MasterInstagramAccount.findOne({
            organizationId,
            status: "connected",
          });
          if (masterAcc) {
            account = masterAcc;
            // Self-healing: sync master copy into tenant models
            if (tenantModels?.InstagramAccount) {
              await tenantModels.InstagramAccount.findOneAndUpdate(
                { organizationId },
                { $set: masterAcc.toObject ? masterAcc.toObject() : masterAcc },
                { upsert: true }
              );
            }
          }
        }
      } catch (masterLookupErr) {
        console.warn("[InstagramStatus] Master fallback warning:", masterLookupErr.message);
      }
    }

    if (!account || account.status !== "connected") {
      return res.status(200).json({
        success: true,
        isConnected: false,
        account: null,
      });
    }

    return res.status(200).json({
      success: true,
      isConnected: true,
      account: {
        id: account._id,
        username: account.username,
        name: account.name,
        profilePictureUrl: account.profilePictureUrl,
        connectedAt: account.connectedAt,
        settings: account.settings,
      },
    });
  } catch (err) {
    console.error("[getInstagramStatus] Error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Disconnects the Instagram account
 * POST /api/instagram/disconnect
 */
export const disconnectInstagramAccount = async (req, res) => {
  const organizationId = req.user?.organizationId || req.organization?._id;
  const tenantModels = req.tenantModels || getTenantModels(req.organization?.tenantDbName);

  try {
    await tenantModels.InstagramAccount.findOneAndUpdate(
      { organizationId },
      { $set: { status: "disconnected", disconnectReason: "Disconnected by user" } }
    );

    try {
      const { InstagramAccount: MasterInstagramAccount } = getMasterModels();
      if (MasterInstagramAccount) {
        await MasterInstagramAccount.findOneAndUpdate(
          { organizationId },
          { $set: { status: "disconnected", disconnectReason: "Disconnected by user" } }
        );
      }
    } catch (masterSyncErr) {}

    return res.status(200).json({ success: true, message: "Instagram disconnected." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Automation Rules CRUD
 */
export const getAutomationRules = async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  const organizationId = req.user?.organizationId || req.organization?._id;
  const tenantModels = req.tenantModels || getTenantModels(req.organization?.tenantDbName);

  try {
    const rules = await tenantModels.InstagramAutomationRule.find({ organizationId }).sort({
      createdAt: -1,
    });
    return res.status(200).json({ success: true, rules });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createAutomationRule = async (req, res) => {
  const organizationId = req.user?.organizationId || req.organization?._id;
  const tenantModels = req.tenantModels || getTenantModels(req.organization?.tenantDbName);

  try {
    const rule = await tenantModels.InstagramAutomationRule.create({
      ...req.body,
      organizationId,
    });
    return res.status(201).json({ success: true, rule });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
};

export const updateAutomationRule = async (req, res) => {
  const { id } = req.params;
  const organizationId = req.user?.organizationId || req.organization?._id;
  const tenantModels = req.tenantModels || getTenantModels(req.organization?.tenantDbName);

  try {
    const rule = await tenantModels.InstagramAutomationRule.findOneAndUpdate(
      { _id: id, organizationId },
      { $set: req.body },
      { returnDocument: "after" }
    );
    if (!rule) return res.status(404).json({ success: false, message: "Rule not found." });
    return res.status(200).json({ success: true, rule });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
};

export const deleteAutomationRule = async (req, res) => {
  const { id } = req.params;
  const organizationId = req.user?.organizationId || req.organization?._id;
  const tenantModels = req.tenantModels || getTenantModels(req.organization?.tenantDbName);

  try {
    await tenantModels.InstagramAutomationRule.findOneAndDelete({ _id: id, organizationId });
    return res.status(200).json({ success: true, message: "Rule deleted." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Lists all Instagram contacts / conversations
 * GET /api/instagram/conversations
 */
export const getInstagramConversations = async (req, res) => {
  const organizationId = req.user?.organizationId || req.organization?._id;
  const tenantModels = req.tenantModels || getTenantModels(req.organization?.tenantDbName);

  try {
    const contacts = await tenantModels.InstagramContact.find({ organizationId })
      .populate("leadId")
      .sort({ lastInteractedAt: -1 })
      .lean();

    // Deduplicate contacts by user identity (username, customerName, or igsid)
    const groupedMap = new Map();

    for (const c of contacts) {
      const uname = (c.username || "").toLowerCase().trim();
      const cname = (c.name || "").toLowerCase().trim();
      const igsid = (c.igsid || "").trim();

      let groupKey = "";
      if (uname && uname !== "instagram_user" && uname !== "instagram user") {
        groupKey = `ig_user_${uname}`;
      } else if (cname && cname !== "instagram user" && cname !== "unknown") {
        groupKey = `ig_name_${cname}`;
      } else if (igsid && !igsid.startsWith("commenter_")) {
        groupKey = `ig_igsid_${igsid}`;
      } else {
        groupKey = `ig_contact_${c._id.toString()}`;
      }

      if (!groupedMap.has(groupKey)) {
        groupedMap.set(groupKey, {
          primaryContact: c,
          allContacts: [c],
          allContactIds: [c._id.toString()],
          allIgsids: igsid ? [igsid] : [],
        });
      } else {
        const group = groupedMap.get(groupKey);
        group.allContacts.push(c);
        group.allContactIds.push(c._id.toString());
        if (igsid && !group.allIgsids.includes(igsid)) {
          group.allIgsids.push(igsid);
        }
        // Prefer contact with richer details or latest interaction
        if (
          (!group.primaryContact.profilePic && c.profilePic) ||
          (!group.primaryContact.leadId && c.leadId) ||
          (new Date(c.lastInteractedAt || 0) > new Date(group.primaryContact.lastInteractedAt || 0))
        ) {
          group.primaryContact = {
            ...group.primaryContact,
            ...c,
            name: c.name || group.primaryContact.name,
            username: c.username || group.primaryContact.username,
            profilePic: c.profilePic || group.primaryContact.profilePic,
            leadId: c.leadId || group.primaryContact.leadId,
          };
        }
      }
    }

    const formatted = [];
    for (const [groupKey, group] of groupedMap.entries()) {
      const c = group.primaryContact;
      const contactObjectIds = group.allContactIds
        .filter((id) => mongoose.isValidObjectId(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      const lastMsg = await tenantModels.InstagramMessage.findOne({
        organizationId,
        $or: [
          { contactId: { $in: contactObjectIds } },
          { igsid: { $in: group.allIgsids } },
        ],
      })
        .sort({ timestamp: -1 })
        .lean();

      // Look up existing unified Conversation record if present
      const leadObjId = c.leadId?._id || c.leadId;
      let convo = null;
      if (tenantModels.Conversation) {
        convo = await tenantModels.Conversation.findOne({
          $or: [
            { instagramContactId: { $in: contactObjectIds } },
            { instagramIgsid: { $in: group.allIgsids } },
            ...(leadObjId ? [{ leadId: leadObjId }] : []),
          ],
        })
          .sort({ lastMessageTime: -1 })
          .lean();
      }

      const isComment =
        convo?.channel === "instagram_comment" ||
        lastMsg?.triggerSource === "comment_to_dm" ||
        (lastMsg?.text && lastMsg.text.startsWith("[Comment"));

      const channel = isComment ? "instagram_comment" : (convo?.channel || "instagram");

      // Compute unread count: count incoming messages newer than lastReadAt so AI auto-replies don't mask unread incoming messages
      let unreadCount = 0;
      const incomingUnreadFilter = {
        organizationId,
        direction: "incoming",
        $or: [
          { contactId: { $in: contactObjectIds } },
          { igsid: { $in: group.allIgsids } },
        ],
        ...(c.lastReadAt ? { timestamp: { $gt: new Date(c.lastReadAt) } } : {}),
      };
      const unreadIncomingCount = await tenantModels.InstagramMessage.countDocuments(incomingUnreadFilter).catch(() => 0);

      if (typeof convo?.unreadCount === "number" && convo.unreadCount > 0) {
        unreadCount = Math.max(convo.unreadCount, unreadIncomingCount);
      } else {
        unreadCount = unreadIncomingCount;
      }

      // Always display whichever message is newer between Conversation cache and InstagramMessage
      const convoTime = convo?.lastMessageTime ? new Date(convo.lastMessageTime).getTime() : 0;
      const msgTime = lastMsg?.timestamp ? new Date(lastMsg.timestamp).getTime() : 0;
      const latestMessageText =
        msgTime >= convoTime
          ? (lastMsg?.text || convo?.lastMessage || "Conversation started")
          : (convo?.lastMessage || lastMsg?.text || "Conversation started");
      const latestMessageTime =
        msgTime >= convoTime
          ? (lastMsg?.timestamp || convo?.lastMessageTime || c.lastInteractedAt)
          : (convo?.lastMessageTime || lastMsg?.timestamp || c.lastInteractedAt);

      let leadDoc = null;
      if (c.leadId && tenantModels.Lead) {
        leadDoc = await tenantModels.Lead.findById(c.leadId)
          .select("_id name phone aiEnabled aiPausedUntil")
          .lean()
          .catch(() => null);
      }

      formatted.push({
        _id: c._id,
        id: c._id.toString(),
        conversationId: convo?._id?.toString() || null,
        igsid: c.igsid || group.allIgsids[0] || "",
        instagramIgsid: c.igsid || group.allIgsids[0] || "",
        instagramContactId: c._id.toString(),
        allContactIds: group.allContactIds,
        allIgsids: group.allIgsids,
        channel,
        subChannel: isComment ? "comment" : "dm",
        triggerSource: lastMsg?.triggerSource || (isComment ? "comment_to_dm" : "direct_message"),
        customerName: c.name || c.username || "Instagram User",
        username: c.username || "",
        instagramUsername: c.username || "",
        phone: leadDoc?.phone || c.phone || "",
        profilePic: c.profilePic || "",
        leadId: leadDoc || c.leadId,
        isLead: Boolean(leadDoc || c.leadId),
        unreadCount,
        lastMessage: latestMessageText,
        lastMessageTime: latestMessageTime,
      });
    }

    return res.status(200).json(formatted);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Gets message history for an Instagram contact
 * GET /api/instagram/conversation/:contactId/messages
 */
export const getInstagramMessages = async (req, res) => {
  const { contactId } = req.params;
  const organizationId = req.user?.organizationId || req.organization?._id;
  const tenantModels = req.tenantModels || getTenantModels(req.organization?.tenantDbName);

  try {
    let resolvedContactId = mongoose.isValidObjectId(contactId) ? contactId : null;
    let resolvedIgsid = contactId;
    let contactDoc = null;

    if (tenantModels.Conversation && resolvedContactId && typeof tenantModels.Conversation.findById === "function") {
      const convQuery = tenantModels.Conversation.findById(contactId);
      const convo = convQuery && typeof convQuery.lean === "function"
        ? await convQuery.lean().catch(() => null)
        : await Promise.resolve(convQuery).catch(() => null);
      if (convo?.instagramContactId) {
        resolvedContactId = convo.instagramContactId.toString();
      }
      if (convo?.instagramIgsid) {
        resolvedIgsid = convo.instagramIgsid;
      }
    }

    // Lookup contact
    if (tenantModels.InstagramContact) {
      if (resolvedContactId) {
        contactDoc = await tenantModels.InstagramContact.findById(resolvedContactId).lean().catch(() => null);
      }
      if (!contactDoc && resolvedIgsid) {
        contactDoc = await tenantModels.InstagramContact.findOne({
          $or: [{ igsid: resolvedIgsid }, { username: resolvedIgsid }],
        }).lean().catch(() => null);
      }
      if (contactDoc) {
        resolvedContactId = contactDoc._id.toString();
        resolvedIgsid = contactDoc.igsid || resolvedIgsid;
      }
    }

    // Find ALL related contact IDs and IGSIDs for this customer
    const contactOrConditions = [];
    if (resolvedContactId && mongoose.isValidObjectId(resolvedContactId)) {
      contactOrConditions.push({ _id: new mongoose.Types.ObjectId(resolvedContactId) });
    }
    if (resolvedIgsid) {
      contactOrConditions.push({ igsid: resolvedIgsid });
    }
    if (contactDoc?.username && contactDoc.username !== "instagram_user") {
      contactOrConditions.push({ username: new RegExp("^" + contactDoc.username.trim() + "$", "i") });
    }
    if (contactDoc?.name && contactDoc.name !== "Instagram User" && contactDoc.name !== "unknown") {
      contactOrConditions.push({ name: new RegExp("^" + contactDoc.name.trim() + "$", "i") });
    }

    let allRelatedContacts = [];
    if (tenantModels.InstagramContact && contactOrConditions.length > 0) {
      allRelatedContacts = await tenantModels.InstagramContact.find({
        organizationId,
        $or: contactOrConditions,
      }).lean().catch(() => []);
    }

    const allContactObjectIds = [
      ...(resolvedContactId && mongoose.isValidObjectId(resolvedContactId) ? [new mongoose.Types.ObjectId(resolvedContactId)] : []),
      ...allRelatedContacts.map((c) => c._id),
    ];
    const allIgsids = Array.from(
      new Set([
        ...(resolvedIgsid ? [resolvedIgsid] : []),
        ...allRelatedContacts.map((c) => c.igsid).filter(Boolean),
      ])
    );

    const queryFilter = {
      $or: [
        { contactId: { $in: allContactObjectIds } },
        { igsid: { $in: allIgsids } },
      ],
    };
    if (organizationId) {
      queryFilter.organizationId = organizationId;
    }

    const messages = await tenantModels.InstagramMessage.find(queryFilter).sort({ timestamp: 1 }).lean();

    // Deduplicate messages by mid
    const seenMids = new Set();
    const uniqueMessages = [];
    for (const m of messages) {
      const key = m.mid || m._id.toString();
      if (!seenMids.has(key)) {
        seenMids.add(key);
        uniqueMessages.push(m);
      }
    }

    // Mark as read automatically in Conversation and InstagramContact
    try {
      const convOrConditions = [];
      if (mongoose.isValidObjectId(contactId)) convOrConditions.push({ _id: new mongoose.Types.ObjectId(contactId) });
      if (allContactObjectIds.length > 0) convOrConditions.push({ instagramContactId: { $in: allContactObjectIds } });
      if (allIgsids.length > 0) convOrConditions.push({ instagramIgsid: { $in: allIgsids } });

      if (tenantModels.Conversation && convOrConditions.length > 0) {
        await tenantModels.Conversation.updateMany(
          { $or: convOrConditions },
          { $set: { unreadCount: 0 } }
        );
      }
      if (tenantModels.InstagramContact) {
        const contactConditions = [];
        if (allContactObjectIds.length > 0) contactConditions.push({ _id: { $in: allContactObjectIds } });
        if (allIgsids.length > 0) contactConditions.push({ igsid: { $in: allIgsids } });
        if (contactConditions.length > 0) {
          await tenantModels.InstagramContact.updateMany(
            { $or: contactConditions },
            { $set: { lastReadAt: new Date() } }
          );
        }
      }

      const io = req.app.get("io");
      if (io && organizationId) {
        io.to(`org_${organizationId}`).emit("conversation_read", {
          contactId: resolvedContactId,
          igsid: resolvedIgsid,
        });
        io.to(`org_${organizationId}`).emit("conversation_read_status", {
          contactId: resolvedContactId,
          igsid: resolvedIgsid,
          unreadCount: 0,
        });
      }
    } catch (readErr) {
      console.warn("[getInstagramMessages] Mark as read warning:", readErr.message);
    }

    const formatted = uniqueMessages.map((m) => ({
      _id: m._id,
      id: m._id.toString(),
      messageId: m.mid,
      sender: m.direction === "outgoing" ? "You" : m.igsid,
      senderName: m.direction === "outgoing" ? "Agent" : (contactDoc?.name || "Instagram User"),
      direction: m.direction,
      messageType: m.mediaType !== "none" ? m.mediaType : "text",
      text: m.text,
      mediaUrl: m.mediaUrl,
      timestamp: m.timestamp,
      channel: "instagram",
    }));

    return res.status(200).json(formatted);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Marks an Instagram conversation as read or unread
 * PATCH /api/instagram/conversation/:contactId/read
 */
export const markInstagramConversationRead = async (req, res) => {
  const { contactId } = req.params;
  const { unread } = req.body || {};
  const organizationId = req.user?.organizationId || req.organization?._id;
  const tenantModels = req.tenantModels || getTenantModels(req.organization?.tenantDbName);

  try {
    let resolvedContactId = mongoose.isValidObjectId(contactId) ? contactId : null;
    let resolvedIgsid = contactId;
    let contactDoc = null;

    if (tenantModels.Conversation && resolvedContactId && typeof tenantModels.Conversation.findById === "function") {
      const convQuery = tenantModels.Conversation.findById(contactId);
      const convo = convQuery && typeof convQuery.lean === "function"
        ? await convQuery.lean().catch(() => null)
        : await Promise.resolve(convQuery).catch(() => null);
      if (convo?.instagramContactId) resolvedContactId = convo.instagramContactId.toString();
      if (convo?.instagramIgsid) resolvedIgsid = convo.instagramIgsid;
    }

    if (tenantModels.InstagramContact) {
      if (resolvedContactId) {
        contactDoc = await tenantModels.InstagramContact.findById(resolvedContactId).lean().catch(() => null);
      }
      if (!contactDoc && resolvedIgsid) {
        contactDoc = await tenantModels.InstagramContact.findOne({
          $or: [{ igsid: resolvedIgsid }, { username: resolvedIgsid }],
        }).lean().catch(() => null);
      }
      if (contactDoc) {
        resolvedContactId = contactDoc._id.toString();
        resolvedIgsid = contactDoc.igsid || resolvedIgsid;
      }
    }

    const contactOrConditions = [];
    if (resolvedContactId && mongoose.isValidObjectId(resolvedContactId)) {
      contactOrConditions.push({ _id: new mongoose.Types.ObjectId(resolvedContactId) });
    }
    if (resolvedIgsid) {
      contactOrConditions.push({ igsid: resolvedIgsid });
    }
    if (contactDoc?.username && contactDoc.username !== "instagram_user") {
      contactOrConditions.push({ username: new RegExp("^" + contactDoc.username.trim() + "$", "i") });
    }
    if (contactDoc?.name && contactDoc.name !== "Instagram User" && contactDoc.name !== "unknown") {
      contactOrConditions.push({ name: new RegExp("^" + contactDoc.name.trim() + "$", "i") });
    }

    let allRelatedContacts = [];
    if (tenantModels.InstagramContact && contactOrConditions.length > 0) {
      allRelatedContacts = await tenantModels.InstagramContact.find({
        organizationId,
        $or: contactOrConditions,
      }).lean().catch(() => []);
    }

    const allContactObjectIds = [
      ...(resolvedContactId && mongoose.isValidObjectId(resolvedContactId) ? [new mongoose.Types.ObjectId(resolvedContactId)] : []),
      ...allRelatedContacts.map((c) => c._id),
    ];
    const allIgsids = Array.from(
      new Set([
        ...(resolvedIgsid ? [resolvedIgsid] : []),
        ...allRelatedContacts.map((c) => c.igsid).filter(Boolean),
      ])
    );

    const newUnreadCount = unread ? 1 : 0;
    const convOrConditions = [];
    if (mongoose.isValidObjectId(contactId)) convOrConditions.push({ _id: new mongoose.Types.ObjectId(contactId) });
    if (allContactObjectIds.length > 0) convOrConditions.push({ instagramContactId: { $in: allContactObjectIds } });
    if (allIgsids.length > 0) convOrConditions.push({ instagramIgsid: { $in: allIgsids } });

    if (tenantModels.Conversation && convOrConditions.length > 0) {
      await tenantModels.Conversation.updateMany(
        { $or: convOrConditions },
        { $set: { unreadCount: newUnreadCount } }
      );
    }

    if (tenantModels.InstagramContact) {
      const contactConditions = [];
      if (allContactObjectIds.length > 0) contactConditions.push({ _id: { $in: allContactObjectIds } });
      if (allIgsids.length > 0) contactConditions.push({ igsid: { $in: allIgsids } });
      if (contactConditions.length > 0) {
        await tenantModels.InstagramContact.updateMany(
          { $or: contactConditions },
          { $set: { lastReadAt: unread ? new Date(0) : new Date() } }
        );
      }
    }

    const io = req.app.get("io");
    if (io && organizationId) {
      io.to(`org_${organizationId}`).emit("conversation_read_status", {
        contactId: resolvedContactId,
        igsid: resolvedIgsid,
        unreadCount: newUnreadCount,
      });
      if (!unread) {
        io.to(`org_${organizationId}`).emit("conversation_read", {
          contactId: resolvedContactId,
          igsid: resolvedIgsid,
        });
      }
    }

    return res.status(200).json({
      success: true,
      unreadCount: newUnreadCount,
      message: unread ? "Conversation marked as unread" : "Conversation marked as read",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Sends a manual agent message to an Instagram contact
 * POST /api/instagram/message/send
 */
export const sendInstagramAgentMessage = async (req, res) => {
  const { contactId, igsid, text, leadId } = req.body;
  const organizationId = req.user?.organizationId || req.organization?._id;
  const tenantModels = req.tenantModels || getTenantModels(req.organization?.tenantDbName);

  if ((!contactId && !igsid) || !text) {
    return res
      .status(400)
      .json({ success: false, message: "Recipient (contactId or igsid) and text are required." });
  }

  try {
    const account = await tenantModels.InstagramAccount.findOne({
      organizationId,
      status: "connected",
    });
    if (!account) {
      return res.status(400).json({ success: false, message: "No connected Instagram account found." });
    }

    let targetIgsid = igsid;
    let contact = null;

    if (contactId) {
      if (mongoose.isValidObjectId(contactId)) {
        contact = await tenantModels.InstagramContact.findById(contactId).catch(() => null);
        if (!contact && tenantModels.Conversation) {
          const convo = await tenantModels.Conversation.findById(contactId).catch(() => null);
          if (convo?.instagramContactId && mongoose.isValidObjectId(convo.instagramContactId)) {
            contact = await tenantModels.InstagramContact.findById(convo.instagramContactId).catch(() => null);
          }
          if (!targetIgsid && convo?.instagramIgsid) {
            targetIgsid = convo.instagramIgsid;
          }
        }
      }
      if (!contact) {
        contact = await tenantModels.InstagramContact.findOne({
          organizationId,
          $or: [{ igsid: contactId }, { username: contactId }],
        }).catch(() => null);
      }
      if (contact) targetIgsid = contact.igsid || targetIgsid;
      if (!targetIgsid && contactId && !mongoose.isValidObjectId(contactId)) {
        targetIgsid = contactId;
      }
    } else if (igsid) {
      contact = await tenantModels.InstagramContact.findOne({ organizationId, igsid }).catch(() => null);
    }

    if (!targetIgsid) {
      return res.status(404).json({ success: false, message: "Instagram contact not found." });
    }

    const sendRes = await sendInstagramMessage({
      pageAccessToken: account.pageAccessTokenEncrypted,
      igsid: targetIgsid,
      text,
    });

    const mid = sendRes?.message_id || `ig_out_${Date.now()}`;

    // Mark contact read
    if (contact) {
      contact.lastReadAt = new Date();
      contact.lastInteractedAt = new Date();
      await contact.save().catch(() => {});
    }

    // 1. Save in InstagramMessage
    const igMsg = await tenantModels.InstagramMessage.create({
      organizationId,
      accountId: account._id,
      contactId: contact?._id || null,
      igsid: targetIgsid,
      mid,
      direction: "outgoing",
      senderType: "agent",
      text,
      triggerSource: "direct_message",
    });

    // 2. Save in Message (for unified timeline)
    let unifiedMsg = null;
    if (tenantModels.Message) {
      unifiedMsg = await tenantModels.Message.create({
        messageId: mid,
        leadId: leadId || contact?.leadId || null,
        contactPhone: contact?.phone || "",
        sender: req.user?.name || "Agent",
        senderName: req.user?.name || "Agent",
        direction: "outgoing",
        messageType: "text",
        text,
        timestamp: new Date(),
        delivered: true,
        rawPayload: { igsid: targetIgsid, channel: "instagram" },
      });
    }

    // 3. Update Conversation
    if (tenantModels.Conversation) {
      await tenantModels.Conversation.findOneAndUpdate(
        {
          $or: [
            { instagramContactId: contact?._id },
            { instagramIgsid: targetIgsid },
            ...(leadId ? [{ leadId }] : []),
          ],
        },
        {
          $set: {
            channel: "instagram",
            instagramIgsid: targetIgsid,
            instagramUsername: contact?.username || "",
            instagramContactId: contact?._id || null,
            customerName: contact?.name || contact?.username || "Instagram User",
            lastMessage: text,
            lastMessageTime: new Date(),
            unreadCount: 0,
          },
        },
        { upsert: true }
      );
    }

    const io = req.app.get("io");
    if (io) {
      io.to(`org_${organizationId}`).emit("instagram_new_message", {
        contact,
        message: igMsg,
      });
    }

    return res.status(200).json({ success: true, message: unifiedMsg || igMsg });
  } catch (err) {
    console.error("[sendInstagramAgentMessage] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
