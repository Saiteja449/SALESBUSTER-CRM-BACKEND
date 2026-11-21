import crypto from "crypto";
import { decryptApiKey } from "../utils/encryption.js";
import { getMasterModels, getTenantModels } from "./tenantManager.js";
import { toInternationalPhone } from "../utils/phoneUtils.js";

const getGraphApiVersion = () => process.env.META_GRAPH_API_VERSION || "v21.0";
const getGraphApiBaseUrl = () => `https://graph.facebook.com/${getGraphApiVersion()}`;

/**
 * Sends a direct message to an Instagram user via Meta Graph API
 */
export const sendInstagramMessage = async ({
  pageAccessToken,
  igsid,
  commentId = null,
  text,
  callToAction = null,
}) => {
  if (!pageAccessToken || (!igsid && !commentId)) {
    throw new Error("Page access token and recipient (IGSID or commentId) are required.");
  }

  const token = decryptApiKey(pageAccessToken);
  const url = `${getGraphApiBaseUrl()}/me/messages`;

  let messagePayload;
  if (commentId) {
    // Meta Graph API Private Reply to comment REQUIREMENT:
    // Private replies to comments only support plain text messages.
    // Template buttons and attachments are strictly rejected with (#100) by Meta.
    const fullText =
      callToAction && callToAction.buttonUrl
        ? `${text || ""}\n\n👉 ${callToAction.buttonTitle || "View Details"}: ${callToAction.buttonUrl}`
        : text;
    messagePayload = { text: fullText };
  } else if (callToAction && callToAction.buttonTitle && callToAction.buttonUrl) {
    messagePayload = {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: text || "Here is your requested link:",
          buttons: [
            {
              type: "web_url",
              url: callToAction.buttonUrl,
              title: callToAction.buttonTitle.slice(0, 20),
            },
          ],
        },
      },
    };
  } else {
    messagePayload = { text };
  }

  // Use comment_id for Private Replies (Reels/Post Comment-to-DM), fallback to user igsid
  const recipient = commentId ? { comment_id: commentId } : { id: igsid };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient,
      message: messagePayload,
    }),
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    console.error("[InstagramService] sendInstagramMessage failure:", data);
    throw new Error(data.error?.message || "Failed to send Instagram direct message.");
  }

  return data;
};

/**
 * Replies publicly to an Instagram comment on a Post or Reel
 */
export const replyToInstagramComment = async ({ pageAccessToken, commentId, text }) => {
  if (!pageAccessToken || !commentId || !text) {
    throw new Error("Page access token, commentId, and text are required.");
  }

  const token = decryptApiKey(pageAccessToken);
  const url = `${getGraphApiBaseUrl()}/${commentId}/replies`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: text }),
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    console.error("[InstagramService] replyToInstagramComment failure:", data);
    throw new Error(data.error?.message || "Failed to reply to Instagram comment.");
  }

  return data;
};

/**
 * Fetches basic public profile info for an Instagram user (IGSID)
 */
export const fetchInstagramUserProfile = async ({ pageAccessToken, igsid }) => {
  if (!pageAccessToken || !igsid) return null;

  try {
    const token = decryptApiKey(pageAccessToken);
    const url = `${getGraphApiBaseUrl()}/${igsid}?fields=name,username,profile_pic`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.warn("[InstagramService] Failed to fetch profile:", err.message);
    return null;
  }
};

/**
 * Extracts a potential phone number from message text
 */
export const extractPhoneNumber = (text) => {
  if (!text || typeof text !== "string") return null;

  // Match phone-like strings with optional country code, spaces, and dashes
  const matches = text.match(/(?:\+?\d{1,3}[\s-]?)?(?:\d[\s-]?){10,12}\b/);
  if (matches && matches[0]) {
    const cleaned = matches[0].replace(/\D/g, "");
    if (cleaned.length >= 10 && cleaned.length <= 15) {
      return toInternationalPhone(cleaned);
    }
  }
  return null;
};

/**
 * Handles incoming Instagram comment webhook event
 */
export const handleIncomingInstagramComment = async ({
  commentEvent,
  organizationId,
  tenantModels,
  io,
}) => {
  const { id: commentId, text: rawText, message: rawMsg, from, user, media } = commentEvent;
  const text = rawText || rawMsg || "";
  const igsid = from?.id || user?.id;
  const username = from?.username || user?.username || "";
  const postId = media?.id || commentEvent.post_id || "";

  if (!text || !igsid) {
    console.warn("[InstagramComment] Missing text or commenter ID:", commentEvent);
    return;
  }

  const { InstagramAccount, InstagramContact, InstagramAutomationRule, InstagramMessage, Conversation, Message } =
    tenantModels;

  const account = await InstagramAccount.findOne({
    organizationId,
    status: "connected",
  });
  if (!account) {
    console.warn(`[InstagramComment] No connected Instagram account found for org ${organizationId}`);
    return;
  }

  // Prevent bot reply loops if the comment is made by the business account itself
  if (account.instagramBusinessId && String(account.instagramBusinessId) === String(igsid)) {
    console.log("[InstagramComment] Skipping comment made by business account itself.");
    return;
  }

  console.log(`[InstagramComment] Processing incoming comment from @${username} (${igsid}) on post ${postId}: "${text}"`);

  // 1. ALWAYS Upsert Contact
  let contact = await InstagramContact.findOne({
    accountId: account._id,
    igsid,
  });

  if (!contact) {
    contact = await InstagramContact.create({
      organizationId,
      accountId: account._id,
      igsid,
      username: username || "instagram_user",
      name: username || "Instagram User",
      lastInteractedAt: new Date(),
    });
  } else {
    contact.lastInteractedAt = new Date();
    if (username && (!contact.username || contact.username === "instagram_user")) {
      contact.username = username;
      contact.name = contact.name || username;
    }
    await contact.save();
  }

  // 2. ALWAYS Save Incoming Comment Event to InstagramMessage
  const incomingMsg = await InstagramMessage.create({
    organizationId,
    accountId: account._id,
    contactId: contact._id,
    igsid,
    mid: commentId || `comment_${Date.now()}`,
    direction: "incoming",
    senderType: "user",
    text: `[Comment on Reel/Post]: "${text}"`,
    triggerSource: "comment_to_dm",
    timestamp: new Date(),
  });

  // 3. ALWAYS Upsert Unified Conversation Record so it appears in the "Instagram comments" tab
  if (Conversation) {
    try {
      await Conversation.findOneAndUpdate(
        {
          $or: [
            { instagramContactId: contact._id },
            { instagramIgsid: igsid },
            ...(contact.leadId ? [{ leadId: contact.leadId }] : []),
          ],
        },
        {
          $set: {
            channel: "instagram_comment",
            subChannel: "comment",
            triggerSource: "comment_to_dm",
            instagramIgsid: igsid,
            instagramUsername: contact.username,
            instagramContactId: contact._id,
            customerName: contact.name || contact.username || "Instagram Commenter",
            ...(contact.leadId ? { leadId: contact.leadId } : {}),
            isLead: Boolean(contact.leadId),
            lastMessage: `[Comment on Reel/Post]: "${text}"`,
            lastMessageTime: new Date(),
          },
          $inc: { unreadCount: 1 },
        },
        { upsert: true, returnDocument: "after" }
      );
    } catch (cErr) {
      console.warn("[InstagramComment] Conversation upsert warning:", cErr.message);
    }
  }

  // 4. Emit Socket.io Real-time update so the comment shows up instantly in "Instagram comments" tab
  if (io) {
    io.to(`org_${organizationId}`).emit("instagram_new_message", {
      contact,
      message: incomingMsg,
      type: "comment_to_dm",
      igsid,
      username,
      text: `[Comment on Reel/Post]: "${text}"`,
    });
    io.to(`org_${organizationId}`).emit("conversation_updated", {
      channel: "instagram_comment",
      contactId: contact._id,
    });
  }

  // 5. Check Automated Comment-to-DM Rules
  const rules = await InstagramAutomationRule.find({
    organizationId,
    triggerType: "comment_to_dm",
    isActive: true,
  });

  const normalizedComment = text.toLowerCase().trim();
  let matchedRule = null;

  for (const rule of rules) {
    if (rule.postScope === "specific_post" && rule.targetPostId && rule.targetPostId !== postId) {
      continue;
    }

    // Direct title match or keyword match
    const titleMatches =
      rule.title &&
      (normalizedComment === rule.title.toLowerCase().trim() ||
        normalizedComment.includes(rule.title.toLowerCase().trim()));

    const keywordMatches = (rule.keywords || []).some((kw) => {
      const cleanKw = kw.toLowerCase().trim();
      if (!cleanKw) return false;
      return rule.matchType === "exact"
        ? normalizedComment === cleanKw
        : normalizedComment.includes(cleanKw) || cleanKw.includes(normalizedComment);
    });

    if (titleMatches || keywordMatches) {
      matchedRule = rule;
      break;
    }
  }

  if (!matchedRule) {
    console.log(`[InstagramComment] No active comment_to_dm rule matched for "${text}". Saved to Unified Inbox.`);
    return;
  }

  const commentTime = commentEvent.created_time || commentEvent.timestamp;
  const isWithin7Days = commentTime
    ? Date.now() - new Date(commentTime).getTime() < 7 * 24 * 60 * 60 * 1000
    : true;

  if (!isWithin7Days) {
    console.log(`[InstagramComment] Comment ${commentId} is older than 7 days; skipping Meta Private Reply DM per Meta policy.`);
    return;
  }

  console.log(`[InstagramComment] Rule matched: '${matchedRule.title}'. Sending auto-DM & public reply...`);

  // Post randomized public reply to the comment if configured
  if (matchedRule.publicCommentReplies && matchedRule.publicCommentReplies.length > 0) {
    try {
      const replies = matchedRule.publicCommentReplies;
      const chosenReply = replies[Math.floor(Math.random() * replies.length)];
      await replyToInstagramComment({
        pageAccessToken: account.pageAccessTokenEncrypted,
        commentId,
        text: chosenReply,
      });
    } catch (e) {
      console.warn("[InstagramService] Public comment reply skipped/failed:", e.message);
    }
  }

  // Send automated DM to the commenter
  const dmText =
    matchedRule.dmMessageTemplate ||
    `Hey @${username}! Thanks for reaching out. Here are the details you requested:`;

  try {
    const dmResult = await sendInstagramMessage({
      pageAccessToken: account.pageAccessTokenEncrypted,
      igsid,
      commentId, // Private Reply for Reel/Post comment
      text: dmText,
      callToAction: matchedRule.callToAction,
    });

    if (dmResult?.message_id) {
      await InstagramMessage.create({
        organizationId,
        accountId: account._id,
        contactId: contact._id,
        igsid,
        mid: dmResult.message_id,
        direction: "outgoing",
        senderType: "auto_dm",
        text: dmText,
        triggerSource: "comment_to_dm",
        ruleId: matchedRule._id,
        timestamp: new Date(),
      });
    }

    if (Conversation) {
      try {
        await Conversation.findOneAndUpdate(
          {
            $or: [
              { instagramContactId: contact._id },
              { instagramIgsid: igsid },
              ...(contact.leadId ? [{ leadId: contact.leadId }] : []),
            ],
          },
          {
            $set: {
              lastMessage: `[Comment]: "${text}" ➔ Auto-DM Sent`,
              lastMessageTime: new Date(),
            },
          }
        );
      } catch (_) {}
    }

    if (Message && dmResult?.message_id) {
      try {
        await Message.create({
          messageId: dmResult.message_id,
          leadId: contact.leadId || null,
          contactPhone: contact.phone || "",
          sender: "System",
          senderName: "SalesBuster AI",
          direction: "outgoing",
          messageType: "text",
          text: dmText,
          timestamp: new Date(),
          rawPayload: { igsid, channel: "instagram_comment", commentId },
        });
      } catch (_) {}
    }

    await InstagramAutomationRule.findByIdAndUpdate(matchedRule._id, {
      $inc: { timesTriggered: 1 },
    });

    if (io) {
      io.to(`org_${organizationId}`).emit("instagram_new_message", {
        contact,
        type: "comment_to_dm",
        igsid,
        username,
        text: dmText,
      });
      io.to(`org_${organizationId}`).emit("conversation_updated", {
        channel: "instagram_comment",
        contactId: contact._id,
      });
    }
  } catch (dmErr) {
    console.error("[InstagramService] Auto DM failed for commenter:", dmErr.message);
  }
};

/**
 * Handles incoming Instagram direct message webhook event
 */
export const handleIncomingInstagramMessage = async ({
  messageEvent,
  organizationId,
  tenantModels,
  io,
}) => {
  const { sender, recipient, message } = messageEvent;
  if (!sender?.id || !message?.mid) return;

  const igsid = sender.id;
  const mid = message.mid;
  const text = message.text || "";

  const {
    InstagramAccount,
    InstagramContact,
    InstagramAutomationRule,
    InstagramMessage,
    Lead,
    Conversation,
    Message,
  } = tenantModels;

  const account = await InstagramAccount.findOne({
    organizationId,
    status: "connected",
  });
  if (!account) return;

  // 1. Get or create contact
  let contact = await InstagramContact.findOne({
    accountId: account._id,
    igsid,
  });

  if (!contact) {
    const profile = await fetchInstagramUserProfile({
      pageAccessToken: account.pageAccessTokenEncrypted,
      igsid,
    });

    contact = await InstagramContact.create({
      organizationId,
      accountId: account._id,
      igsid,
      username: profile?.username || "",
      name: profile?.name || "",
      profilePic: profile?.profile_pic || "",
      lastInteractedAt: new Date(),
    });
  } else {
    contact.lastInteractedAt = new Date();
    await contact.save();
  }

  // 2. Persist incoming message
  const incomingMsg = await InstagramMessage.create({
    organizationId,
    accountId: account._id,
    contactId: contact._id,
    igsid,
    mid,
    direction: "incoming",
    senderType: "user",
    text,
    triggerSource: "direct_message",
  });

  if (Message) {
    try {
      await Message.create({
        messageId: mid,
        leadId: contact.leadId || null,
        contactPhone: contact.phone || "",
        sender: contact.username || igsid,
        senderName: contact.name || contact.username || "Instagram User",
        direction: "incoming",
        messageType: "text",
        text,
        timestamp: new Date(),
        rawPayload: { igsid, channel: "instagram" },
      });
    } catch (_) {}
  }

  if (Conversation) {
    try {
      await Conversation.findOneAndUpdate(
        {
          $or: [
            { instagramContactId: contact._id },
            { instagramIgsid: igsid },
            ...(contact.leadId ? [{ leadId: contact.leadId }] : []),
          ],
        },
        {
          $set: {
            channel: "instagram",
            instagramIgsid: igsid,
            instagramUsername: contact.username,
            instagramContactId: contact._id,
            customerName: contact.name || contact.username || "Instagram User",
            leadId: contact.leadId || null,
            isLead: Boolean(contact.leadId),
            lastMessage: text,
            lastMessageTime: new Date(),
          },
          $inc: { unreadCount: 1 },
        },
        { upsert: true, returnDocument: "after" }
      );
    } catch (_) {}
  }

  // 3. Lead Detection: Check if user shared phone number
  const detectedPhone = extractPhoneNumber(text);
  if (detectedPhone && !contact.leadId) {
    try {
      const leadName = contact.name || contact.username || "Instagram Prospect";
      const newLead = await Lead.create({
        name: leadName,
        phone: detectedPhone,
        source: "Instagram",
        service: "General Enquiry",
        assignedTo: account.userId || null,
        organizationId,
      });

      contact.phone = detectedPhone;
      contact.leadId = newLead._id;
      await contact.save();

      console.log(`[InstagramLead] Created new lead ${newLead._id} from IGSID ${igsid}`);

      // Send confirmation DM
      const confirmText =
        "Thank you! We've received your contact number and our team will get in touch shortly.";
      await sendInstagramMessage({
        pageAccessToken: account.pageAccessTokenEncrypted,
        igsid,
        text: confirmText,
      });

      if (io) {
        io.to(`org_${organizationId}`).emit("new_lead", {
          lead: newLead,
          source: "Instagram",
        });
      }
    } catch (leadErr) {
      console.error("[InstagramLead] Failed to create lead:", leadErr.message);
    }
  }

  // 4. Keyword Auto-DM trigger check
  if (!detectedPhone) {
    const normalizedText = text.toLowerCase().trim();
    const rules = await InstagramAutomationRule.find({
      organizationId,
      triggerType: "dm_keyword",
      isActive: true,
    });

    let matchedRule = null;
    for (const r of rules) {
      // 1. Direct title match (e.g. if the user titled the rule "Hi")
      if (r.title && r.title.toLowerCase().trim() === normalizedText) {
        matchedRule = r;
        break;
      }

      // 2. Keyword match (case-insensitive & supports exact or contains)
      const matches = (r.keywords || []).some((kw) => {
        const cleanKw = kw.toLowerCase().trim();
        if (!cleanKw) return false;
        return r.matchType === "exact"
          ? normalizedText === cleanKw
          : normalizedText.includes(cleanKw) || cleanKw.includes(normalizedText);
      });

      if (matches) {
        matchedRule = r;
        break;
      }
    }

    if (matchedRule && matchedRule.dmMessageTemplate) {
      try {
        const dmResult = await sendInstagramMessage({
          pageAccessToken: account.pageAccessTokenEncrypted,
          igsid,
          text: matchedRule.dmMessageTemplate,
          callToAction: matchedRule.callToAction,
        });

        await InstagramAutomationRule.findByIdAndUpdate(matchedRule._id, {
          $inc: { timesTriggered: 1 },
        });
        console.log(`[InstagramService] Auto-reply triggered for rule: '${matchedRule.title}' to IGSID: ${igsid}`);

        const replyMid = dmResult?.message_id || `mid_out_${Date.now()}`;
        const autoReplyMsg = await InstagramMessage.create({
          organizationId,
          accountId: account._id,
          contactId: contact._id,
          igsid,
          mid: replyMid,
          direction: "outgoing",
          senderType: "auto_dm",
          text: matchedRule.dmMessageTemplate,
          triggerSource: "direct_message",
          ruleId: matchedRule._id,
          timestamp: new Date(),
        });

        if (Message) {
          try {
            await Message.create({
              messageId: replyMid,
              leadId: contact.leadId || null,
              contactPhone: contact.phone || "",
              sender: "System",
              senderName: "SalesBuster AI",
              direction: "outgoing",
              messageType: "text",
              text: matchedRule.dmMessageTemplate,
              timestamp: new Date(),
              rawPayload: { igsid, channel: "instagram" },
            });
          } catch (_) {}
        }

        if (Conversation) {
          try {
            await Conversation.findOneAndUpdate(
              {
                $or: [
                  { instagramContactId: contact._id },
                  { instagramIgsid: igsid },
                  ...(contact.leadId ? [{ leadId: contact.leadId }] : []),
                ],
              },
              {
                $set: {
                  lastMessage: matchedRule.dmMessageTemplate,
                  lastMessageTime: new Date(),
                },
              }
            );
          } catch (_) {}
        }

        if (io) {
          io.to(`org_${organizationId}`).emit("instagram_new_message", {
            contact,
            message: autoReplyMsg,
          });
          io.to(`org_${organizationId}`).emit("conversation_updated", {
            channel: "instagram",
            contactId: contact._id,
          });
        }
      } catch (err) {
        console.warn("[InstagramService] DM Keyword response failed:", err.message);
      }
    }
  }

  if (io) {
    io.to(`org_${organizationId}`).emit("instagram_new_message", {
      contact,
      message: incomingMsg,
    });
  }
};

/**
 * Polling Backstop: Syncs recent comments across an organization's connected Instagram account.
 * Fetches recent media and comments from Meta Graph API to ingest any comments that were not delivered via webhook.
 */
export const syncRecentInstagramComments = async (organizationId, io = null) => {
  if (!organizationId) return { synced: 0, error: "organizationId required" };

  try {
    const { getMasterModels, getTenantModels } = await import("./tenantManager.js");
    const { Organization } = getMasterModels();
    const org = await Organization.findById(organizationId).lean();
    if (!org || !org.tenantDbName) return { synced: 0, error: "Organization not found" };

    const tenantModels = getTenantModels(org.tenantDbName);
    const { InstagramAccount, InstagramMessage } = tenantModels;

    const account = await InstagramAccount.findOne({
      organizationId,
      status: "connected",
    });

    if (!account || !account.pageAccessTokenEncrypted || !account.instagramBusinessId) {
      return { synced: 0, error: "No connected Instagram account" };
    }

    const token = decryptApiKey(account.pageAccessTokenEncrypted);
    if (!token) {
      return { synced: 0, error: "Could not decrypt page access token" };
    }

    const igId = account.instagramBusinessId;
    let syncedCount = 0;

    // 1. Fetch recent media (posts and reels)
    const mediaUrl = `${getGraphApiBaseUrl()}/${igId}/media?fields=id,caption,media_type,comments_count,timestamp&limit=15&access_token=${token}`;
    const mediaRes = await fetch(mediaUrl);
    const mediaJson = await mediaRes.json();

    if (!mediaJson.data || !Array.isArray(mediaJson.data)) {
      return { synced: 0, metaResponse: mediaJson };
    }

    for (const media of mediaJson.data) {
      if (!media.comments_count || media.comments_count <= 0) continue;

      // 2. Fetch comments for this media
      const commentsUrl = `${getGraphApiBaseUrl()}/${media.id}/comments?fields=id,text,timestamp,from,username,parent_id&limit=30&access_token=${token}`;
      const comRes = await fetch(commentsUrl);
      const comJson = await comRes.json();

      if (!comJson.data || !Array.isArray(comJson.data)) continue;

      for (const comment of comJson.data) {
        if (!comment.id || !comment.text) continue;

        // Skip if comment is already ingested
        const existingMsg = await InstagramMessage.findOne({ mid: comment.id });
        if (existingMsg) continue;

        // Ingest new comment
        const commentEvent = {
          id: comment.id,
          text: comment.text,
          from: comment.from || (comment.username ? { id: comment.username, username: comment.username } : null),
          user: comment.from || { username: comment.username },
          media: { id: media.id },
          created_time: comment.timestamp,
        };

        await handleIncomingInstagramComment({
          commentEvent,
          organizationId,
          tenantModels,
          io,
        });

        syncedCount++;
      }
    }

    if (syncedCount > 0) {
      console.log(`[InstagramSync] Organization ${organizationId}: synced ${syncedCount} new comments.`);
    }
    return { success: true, synced: syncedCount };
  } catch (err) {
    console.error("[InstagramSync] Error syncing comments:", err);
    return { synced: 0, error: err.message };
  }
};

/**
 * Background watcher: Periodically checks and syncs recent comments across all active organizations
 */
let watcherInterval = null;
let isWatcherRunning = false;

export const startInstagramCommentWatcher = (io = null) => {
  if (watcherInterval) return;

  const runWatcherPass = async () => {
    if (isWatcherRunning) return;
    isWatcherRunning = true;

    try {
      const { getMasterModels } = await import("./tenantManager.js");
      const { Organization, InstagramAccount: MasterInstagramAccount } = getMasterModels();

      let orgIds = [];
      if (MasterInstagramAccount) {
        const accounts = await MasterInstagramAccount.find({ status: "connected" }).lean();
        orgIds = accounts.map((a) => a.organizationId).filter(Boolean);
      } else {
        const orgs = await Organization.find({ status: { $ne: "suspended" } }).lean();
        orgIds = orgs.map((o) => o._id);
      }

      for (const orgId of orgIds) {
        try {
          await syncRecentInstagramComments(orgId, io);
        } catch (_) {}
      }
    } catch (e) {
      console.warn("[InstagramCommentWatcher] Pass warning:", e.message);
    } finally {
      isWatcherRunning = false;
    }
  };

  // Run initial pass after 10 seconds, then every 45 seconds
  setTimeout(runWatcherPass, 10000);
  watcherInterval = setInterval(runWatcherPass, 45000);
  console.log("[InstagramCommentWatcher] Background watcher started (interval: 45000ms).");
};
