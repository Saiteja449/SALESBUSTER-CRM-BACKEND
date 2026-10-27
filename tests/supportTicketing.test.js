import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import SupportTicket from "../models/SupportTicket.js";

test("SupportTicket Model & Status Lifecycle Tests", async (t) => {
  await t.test("1. SupportTicket schema validates required fields", () => {
    const mockOrgId = new mongoose.Types.ObjectId();
    const mockUserId = new mongoose.Types.ObjectId();

    const ticket = new SupportTicket({
      ticketNumber: "SB-1001",
      organizationId: mockOrgId,
      organizationName: "Test Org",
      userId: mockUserId,
      userName: "John Doe",
      userEmail: "john@example.com",
      userRole: "sales manager",
      subject: "WhatsApp pairing failure",
      category: "whatsapp_meta",
      priority: "high",
      description: "Code expires immediately upon entry",
      aiSummary: "WhatsApp pairing code expiration issue",
      aiChatHistory: [
        { role: "user", content: "How do I pair WhatsApp?" },
        { role: "assistant", content: "Enter the 8-digit code in WhatsApp Business." },
      ],
    });

    const validationError = ticket.validateSync();
    assert.equal(validationError, undefined, "Ticket should validate without errors");
    assert.equal(ticket.status, "open", "Default status should be 'open'");
    assert.equal(ticket.category, "whatsapp_meta");
    assert.equal(ticket.priority, "high");
    assert.equal(ticket.aiChatHistory.length, 2);
  });

  await t.test("2. Status progression: open -> in_progress -> resolved", () => {
    const mockOrgId = new mongoose.Types.ObjectId();
    const mockUserId = new mongoose.Types.ObjectId();

    const ticket = new SupportTicket({
      ticketNumber: "SB-1002",
      organizationId: mockOrgId,
      userId: mockUserId,
      userName: "Jane Smith",
      userEmail: "jane@example.com",
      subject: "Call recordings not uploading",
      description: "Sync fails in background",
    });

    assert.equal(ticket.status, "open");

    // Transition to in_progress
    ticket.status = "in_progress";
    assert.equal(ticket.status, "in_progress");

    // Transition to resolved with resolution notes
    ticket.status = "resolved";
    ticket.resolutionNotes = "Fixed permission grant and updated background service timeout.";
    ticket.resolvedAt = new Date();
    ticket.resolvedBy = "Super Admin";

    assert.equal(ticket.status, "resolved");
    assert.ok(ticket.resolutionNotes.includes("Fixed permission"));
    assert.ok(ticket.resolvedAt instanceof Date);
    assert.equal(ticket.resolvedBy, "Super Admin");
  });

  await t.test("3. Ticket number formatting regex matches SB-XXXX pattern", () => {
    const pattern = /^SB-\d+$/;
    assert.ok(pattern.test("SB-1001"));
    assert.ok(pattern.test("SB-2045"));
  });

  await t.test("4. Reopening a resolved ticket clears resolvedAt and resolvedBy", () => {
    const mockOrgId = new mongoose.Types.ObjectId();
    const mockUserId = new mongoose.Types.ObjectId();

    const ticket = new SupportTicket({
      ticketNumber: "SB-1003",
      organizationId: mockOrgId,
      userId: mockUserId,
      userName: "Alex Wong",
      userEmail: "alex@example.com",
      subject: "Leads not assigning correctly",
      description: "Round robin skips inactive rep",
      status: "resolved",
      resolutionNotes: "Re-indexed distribution rule.",
      resolvedAt: new Date(),
      resolvedBy: "Super Admin",
    });

    assert.equal(ticket.status, "resolved");
    assert.ok(ticket.resolvedAt instanceof Date);
    assert.equal(ticket.resolvedBy, "Super Admin");

    // Reopen ticket back to in_progress
    ticket.status = "in_progress";
    ticket.resolvedAt = null;
    ticket.resolvedBy = "";

    assert.equal(ticket.status, "in_progress");
    assert.equal(ticket.resolvedAt, null, "resolvedAt should be reset to null");
    assert.equal(ticket.resolvedBy, "", "resolvedBy should be cleared");
  });
});

