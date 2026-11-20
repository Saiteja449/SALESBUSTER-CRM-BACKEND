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
  if (callToAction && callToAction.buttonTitle && callToAction.buttonUrl) {
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
  const { id: commentId, text, from, media } = commentEvent;
  if (!text || !from?.id) return;

  const igsid = from.id;
  const username = from.username || "";
  const postId = media?.id || "";

  const { InstagramAccount, InstagramContact, InstagramAutomationRule, InstagramMessage } =
    tenantModels;

  const account = await InstagramAccount.findOne({
    organizationId,
    status: "connected",
  });
  if (!account) return;

  // Find matching comment_to_dm rules
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

    const matches = rule.keywords.some((kw) => {
      const cleanKw = kw.toLowerCase().trim();
      return rule.matchType === "exact"
        ? normalizedComment === cleanKw
        : normalizedComment.includes(cleanKw);
    });

    if (matches) {
      matchedRule = rule;
      break;
    }
  }

  if (!matchedRule) return;

  // 1. Post randomized public reply to the comment if configured
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

  // 2. Send automated DM to the commenter
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

    // 3. Upsert contact and log message
    let contact = await InstagramContact.findOne({
      accountId: account._id,
      igsid,
    });

    if (!contact) {
      contact = await InstagramContact.create({
        organizationId,
        accountId: account._id,
        igsid,
        username,
        lastInteractedAt: new Date(),
      });
    }

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
      });
    }

    await InstagramAutomationRule.findByIdAndUpdate(matchedRule._id, {
      $inc: { timesTriggered: 1 },
    });

    if (io) {
      io.to(`org_${organizationId}`).emit("instagram_new_message", {
        type: "comment_to_dm",
        igsid,
        username,
        text: dmText,
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
        await sendInstagramMessage({
          pageAccessToken: account.pageAccessTokenEncrypted,
          igsid,
          text: matchedRule.dmMessageTemplate,
          callToAction: matchedRule.callToAction,
        });

        await InstagramAutomationRule.findByIdAndUpdate(matchedRule._id, {
          $inc: { timesTriggered: 1 },
        });
        console.log(`[InstagramService] Auto-reply triggered for rule: '${matchedRule.title}' to IGSID: ${igsid}`);
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
