import fs from "fs";
import path from "path";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import { getMasterModels } from "../services/tenantManager.js";
import { decryptApiKey } from "../utils/encryption.js";
import { extractProspectDetailsFromVoice } from "../services/voiceProspectExtractionService.js";
import { sessions, connectWhatsApp } from "../whatsapp/whatsappService.js";
import { getIO } from "../socket/socket.js";

/**
 * Capture customer details from live voice recording and send automated WhatsApp template
 * @route POST /api/whatsapp/manager/live-voice-send
 */
export const captureAndSendLiveVoiceWhatsApp = async (req, res) => {
  const audioFile = req.file;
  let audioPath = audioFile?.path;

  try {
    if (!audioFile) {
      return res.status(400).json({
        success: false,
        error: "Audio recording file is required.",
      });
    }

    const { Organization } = getMasterModels();
    const orgId = req.user?.organizationId
      ? req.user.organizationId.toString()
      : req.organization?._id?.toString();

    if (!orgId) {
      return res.status(401).json({
        success: false,
        error: "Organization context required.",
      });
    }

    const organization = await Organization.findById(orgId).lean();
    const geminiApiKey =
      decryptApiKey(organization?.aiSettings?.geminiApiKey) ||
      process.env.GEMINI_API_KEY;

    // 1. Voice extraction via Gemini Multimodal AI
    console.log(`[ManagerLiveVoice] Analyzing audio file: ${audioPath}`);
    let extracted;
    try {
      extracted = await extractProspectDetailsFromVoice(
        audioPath,
        audioFile.mimetype,
        geminiApiKey
      );
    } catch (extractErr) {
      console.error("[ManagerLiveVoice] Voice extraction failed:", extractErr.message);
      return res.status(422).json({
        success: false,
        extractionFailed: true,
        error: extractErr.message || "Failed to extract customer details from audio recording. Please speak clearly and try again.",
        message: extractErr.message || "Failed to extract customer details from audio recording. Please speak clearly and try again.",
      });
    }

    console.log(`[ManagerLiveVoice] Extracted details:`, extracted);

    // 2. Resolve Customer Phone (Voice extraction prioritized for zero manual data entry)
    let rawPhone = (extracted.spokenPhone || req.body?.phone || "").trim();
    let cleanPhone = rawPhone.replace(/\D/g, "");
    if (cleanPhone.length >= 10) {
      if (cleanPhone.length === 10) {
        cleanPhone = "91" + cleanPhone;
      }
    } else {
      return res.status(422).json({
        success: false,
        extractionFailed: true,
        error:
          "Could not detect a 10-digit customer mobile number from the voice recording. Please ensure the customer's phone number is spoken clearly during the conversation.",
        extractedDetails: extracted,
      });
    }

    const ConversationModel = req.tenantModels?.Conversation || Conversation;
    const MessageModel = req.tenantModels?.Message || Message;

    // 3. Duplicate Prevention Check (12-hour window)
    const forceResend =
      req.body?.forceResend === true || req.body?.forceResend === "true";

    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const existingConversation = await ConversationModel.findOne({
      phone: cleanPhone,
    }).lean();

    if (
      !forceResend &&
      existingConversation?.lastTemplateSentAt &&
      new Date(existingConversation.lastTemplateSentAt) > twelveHoursAgo
    ) {
      return res.status(409).json({
        success: false,
        duplicateDetected: true,
        duplicateWarning: true,
        message:
          "A personalized WhatsApp template was already sent to this customer within the last 12 hours.",
        lastSentAt: existingConversation.lastTemplateSentAt,
        data: {
          lastSentAt: existingConversation.lastTemplateSentAt,
          extractedDetails: {
            customerName: extracted.customerName,
            companyName: extracted.companyName,
            phone: cleanPhone,
            keyTopic: extracted.keyTopic,
          },
        },
        extractedDetails: {
          customerName: extracted.customerName,
          companyName: extracted.companyName,
          phone: cleanPhone,
          keyTopic: extracted.keyTopic,
        },
      });
    }

    // 4. Resolve Manager's Connected WhatsApp Session
    const targetSessionId = `org_${orgId}`;
    const sessionObj = sessions[targetSessionId];
    let sock = sessionObj?.sock;

    if (!sock) {
      // Check if session has stored credentials to auto-reconnect
      try {
        const AuthModel = req.tenantModels?.WhatsAppAuthState;
        const hasCreds = AuthModel
          ? await AuthModel.findOne({
              sessionId: targetSessionId,
              type: "creds",
            })
          : null;

        if (hasCreds) {
          connectWhatsApp({
            sessionId: targetSessionId,
            organizationId: orgId,
          }).catch((e) =>
            console.error("[ManagerLiveVoice] Reconnect failed:", e)
          );

          return res.status(503).json({
            success: false,
            error:
              "Your WhatsApp session is currently waking up. Please retry sending in 5-10 seconds.",
            extractedDetails: extracted,
          });
        }
      } catch (checkErr) {}

      return res.status(400).json({
        success: false,
        error:
          "WhatsApp is not connected for your organization. Please ensure your device is paired in WhatsApp Settings.",
        extractedDetails: extracted,
      });
    }

    // 5. Build Dynamic Personalized Template with SalesBuster AI Branding
    const customerName = extracted.customerName || "Valued Customer";
    const companyName = extracted.companyName || "your enterprise";
    const managerName = req.user?.name || "Sales Manager";
    const orgName = organization?.name || "SalesBuster";
    const topicText = extracted.keyTopic || "our discussion";

    const templateText =
      `Hello ${customerName},\n\n` +
      `It was a pleasure speaking with you regarding ${companyName}.\n` +
      `As discussed regarding ${topicText}, feel free to reach out to me directly on this WhatsApp chat whenever you need any assistance!\n\n` +
      `Best regards,\n` +
      `*${managerName}*\n` +
      `${orgName}\n\n` +
      `—\n` +
      `⚡ *Sent via SalesBuster AI* (salesbuster.ai)`;

    // 6. Send Outbound WhatsApp Message
    const targetJid = `${cleanPhone}@s.whatsapp.net`;
    const sendResult = await sock.sendMessage(targetJid, {
      text: templateText,
    });

    const messageId = sendResult?.key?.id || `msg_${Date.now()}`;
    const now = new Date();

    // 7. Upsert Conversation Record (Flagged isLead: false, aiDisabled: true)
    const updatedConversation = await ConversationModel.findOneAndUpdate(
      { phone: cleanPhone },
      {
        $set: {
          phone: cleanPhone,
          customerName,
          companyName,
          isLead: false, // Ensures it does NOT appear in active leads pipeline
          aiDisabled: true, // Permanently disables AI auto-replies for this prospect
          lastMessage: templateText,
          lastMessageTime: now,
          lastTemplateSentAt: now,
          lastTemplateMessageId: messageId,
          unreadCount: 0,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 8. Store Message in CRM (Linked to conversation _id without creating a Lead)
    const messageRecord = await MessageModel.create({
      messageId,
      leadId: updatedConversation._id,
      contactPhone: cleanPhone,
      sender: "Sales Manager",
      senderName: managerName,
      direction: "outgoing",
      messageType: "text",
      text: templateText,
      timestamp: now,
      aiGenerated: false,
      delivered: true,
      status: "sent",
      source: "crm_manual",
      sessionId: targetSessionId,
      salesRepId: req.user?._id,
    });

    // 9. Real-time Socket Broadcast
    const io = getIO();
    if (io) {
      io.to(targetSessionId).emit("new_message", messageRecord);
      io.to(`org_${orgId}`).emit("conversation_update", {
        _id: updatedConversation._id,
        phone: cleanPhone,
        customerName,
        companyName,
        isLead: false,
        lastMessage: templateText,
        lastMessageTime: now,
      });
    }
    

    return res.status(200).json({
      success: true,
      message: "Personalized WhatsApp message sent successfully via SalesBuster AI!",
      phone: cleanPhone,
      extracted: {
        customerName,
        companyName,
        spokenPhone: cleanPhone,
        phone: cleanPhone,
        keyTopic: extracted.keyTopic,
      },
      extractedDetails: {
        customerName,
        companyName,
        phone: cleanPhone,
        keyTopic: extracted.keyTopic,
      },
      messageId,
      sentText: templateText,
      conversationId: updatedConversation._id,
    });
  } catch (error) {
    console.error("[ManagerLiveVoice] Error in live voice WhatsApp send:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to process live voice and dispatch WhatsApp message.",
    });
  } finally {
    // Delete local temporary recording upload file from server disk
    if (audioPath && fs.existsSync(audioPath)) {
      try {
        fs.unlinkSync(audioPath);
      } catch (e) {}
    }
  }
};
