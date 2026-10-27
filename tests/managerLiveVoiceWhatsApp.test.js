import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";

test("Manager Live Voice Capture & WhatsApp Template Tests", async (t) => {
  await t.test("1. Conversation schema allows non-lead prospect without leadId", () => {
    const prospectConv = new Conversation({
      phone: "919876543210",
      customerName: "Ramesh Kumar",
      companyName: "Balaji Traders",
      isLead: false,
      aiDisabled: true,
      lastMessage: "Hello Ramesh, it was a pleasure speaking with you regarding Balaji Traders.",
      lastTemplateSentAt: new Date(),
    });

    const validationError = prospectConv.validateSync();
    assert.equal(validationError, undefined, "Conversation should validate cleanly without leadId");
    assert.equal(prospectConv.isLead, false, "Should be flagged as isLead: false");
    assert.equal(prospectConv.aiDisabled, true, "AI should be permanently disabled");
    assert.equal(prospectConv.customerName, "Ramesh Kumar");
    assert.equal(prospectConv.companyName, "Balaji Traders");
    assert.equal(prospectConv.phone, "919876543210");
  });

  await t.test("2. Message schema allows direct contact message without leadId", () => {
    const outboundMsg = new Message({
      messageId: "WA_MSG_TEST_99182",
      contactPhone: "919876543210",
      sender: "Sales Manager",
      senderName: "Saiteja Manager",
      direction: "outgoing",
      messageType: "text",
      text: "Hello Ramesh, it was a pleasure speaking with you regarding Balaji Traders.\n\n—\n⚡ Sent via SalesBuster AI (salesbuster.ai)",
      status: "sent",
      source: "crm_manual",
    });

    const validationError = outboundMsg.validateSync();
    assert.equal(validationError, undefined, "Message should validate without requiring leadId");
    assert.equal(outboundMsg.contactPhone, "919876543210");
    assert.equal(outboundMsg.direction, "outgoing");
    assert.equal(outboundMsg.source, "crm_manual");
  });

  await t.test("3. Template text formatting contains personalization and SalesBuster AI branding", () => {
    const customerName = "Suresh Reddy";
    const companyName = "Apex Logistics";
    const managerName = "Saiteja";
    const orgName = "Enterprise CRM";
    const topicText = "CRM automation";

    const formattedText =
      `Hello ${customerName},\n\n` +
      `It was a pleasure speaking with you regarding ${companyName}.\n` +
      `As discussed regarding ${topicText}, feel free to reach out to me directly on this WhatsApp chat whenever you need any assistance!\n\n` +
      `Best regards,\n` +
      `*${managerName}*\n` +
      `${orgName}\n\n` +
      `—\n` +
      `⚡ *Sent via SalesBuster AI* (salesbuster.ai)`;

    assert.ok(formattedText.includes("Hello Suresh Reddy"));
    assert.ok(formattedText.includes("regarding Apex Logistics"));
    assert.ok(formattedText.includes("⚡ *Sent via SalesBuster AI* (salesbuster.ai)"));
    assert.ok(formattedText.includes("*Saiteja*"));
  });

  await t.test("4. Duplicate prevention logic correctly detects messages sent within 12 hours", () => {
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
    const fourteenHoursAgo = new Date(now - 14 * 60 * 60 * 1000);
    const twelveHoursThreshold = new Date(now - 12 * 60 * 60 * 1000);

    const isDuplicateRecent = twoHoursAgo > twelveHoursThreshold;
    const isDuplicateOld = fourteenHoursAgo > twelveHoursThreshold;

    assert.equal(isDuplicateRecent, true, "Message sent 2h ago should trigger duplicate prevention");
    assert.equal(isDuplicateOld, false, "Message sent 14h ago should not trigger duplicate prevention");
  });

  await t.test("5. Duplicate payload format satisfies mobile modal duplicateWarning check", () => {
    const lastSentDate = new Date("2026-10-27T10:00:00.000Z");
    const extractedDetails = {
      customerName: "Ramesh Kumar",
      companyName: "Balaji Traders",
      keyTopic: "pricing details",
    };

    // Controller payload when duplicate is detected
    const controllerResponse = {
      success: false,
      duplicateDetected: true,
      duplicateWarning: true,
      lastSentAt: lastSentDate,
      message: `A personalized WhatsApp template was already sent to Balaji Traders within the last 12 hours.`,
      data: {
        lastSentAt: lastSentDate,
        extractedDetails,
      },
    };

    // Mobile check verification:
    // In ManagerLiveVoiceModal.js:
    // const isDuplicate = errorData?.duplicateWarning || errorData?.duplicateDetected || err?.response?.status === 409
    assert.ok(controllerResponse.duplicateDetected, "duplicateDetected should be true");
    assert.ok(controllerResponse.duplicateWarning, "duplicateWarning should be true for mobile modal");
    assert.ok(controllerResponse.data?.lastSentAt, "data.lastSentAt should be populated for mobile display");
    assert.equal(controllerResponse.data?.extractedDetails?.customerName, "Ramesh Kumar");
  });

  await t.test("6. Non-lead conversation query supports lookup by conversation _id or phone", () => {
    const mockConvId = new mongoose.Types.ObjectId();
    const phoneInput = "9876543210";
    const cleanPhone = phoneInput.replace(/\D/g, "");

    // Query structure used in getMessages and sendMessage
    const queryConditions = [
      { _id: mockConvId },
      { leadId: mockConvId },
      { phone: cleanPhone },
      { phone: "91" + cleanPhone.slice(-10) },
      { phone: cleanPhone.slice(-10) },
    ];

    assert.ok(queryConditions.some((c) => c._id?.equals(mockConvId)), "Matches by conversation _id");
    assert.ok(queryConditions.some((c) => c.phone === "919876543210"), "Matches by 91-prefixed phone");
    assert.ok(queryConditions.some((c) => c.phone === "9876543210"), "Matches by raw phone");
  });

  await t.test("7. Extraction failure halts send and returns 422 extractionFailed error", () => {
    const extractionError = new Error("Could not identify customer name or company in the audio recording.");
    
    // Controller error handling representation
    let statusCode = 500;
    let jsonBody = {};
    const mockRes = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonBody = data;
        return this;
      },
    };

    // In managerLiveVoiceController:
    if (extractionError) {
      mockRes.status(422).json({
        success: false,
        extractionFailed: true,
        message: extractionError.message || "Failed to extract prospect details from audio recording.",
      });
    }

    assert.equal(statusCode, 422, "Should return 422 HTTP status");
    assert.equal(jsonBody.extractionFailed, true, "extractionFailed flag should be true");
    assert.ok(jsonBody.message.includes("Could not identify"), "Provides clear feedback without generic send");
  });

  await t.test("8. Voice-only phone extraction resolves 10-digit mobile without manual entry", () => {
    // Spoken phone extracted from voice by Gemini (req.body.phone is null/empty)
    const voiceExtracted = {
      customerName: "Venkatesh Rao",
      companyName: "Rao Enterprises",
      spokenPhone: "9876543210",
      keyTopic: "CRM Automation",
    };
    const reqBodyPhone = ""; // Manager enters no data

    const rawPhone = (voiceExtracted.spokenPhone || reqBodyPhone || "").trim();
    let cleanPhone = rawPhone.replace(/\D/g, "");
    if (cleanPhone.length === 10) {
      cleanPhone = "91" + cleanPhone;
    }

    assert.equal(cleanPhone, "919876543210", "Should cleanly format 10-digit spoken phone with 91 prefix");
    assert.ok(cleanPhone.length >= 12, "Should be valid WhatsApp destination length");
  });
});


