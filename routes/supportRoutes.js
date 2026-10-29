import express from "express";
import {
  handleAiSupportChat,
  createSupportTicket,
  getOrganizationTickets,
  getAllTicketsAdmin,
  getTicketById,
  updateTicketStatusAdmin,
} from "../controllers/supportController.js";
import { protect, verifySuperAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

// ============================================================================
// CLIENT WEB CRM ROUTES (Authenticated Tenant Users)
// ============================================================================

// 1. Instant Support (AI Help) Chat
router.post("/ai-chat", protect, handleAiSupportChat);

// 2. Raise a Support Ticket (with optional AI Chat History handoff)
router.post("/tickets", protect, createSupportTicket);

// 3. Get Organization's Raised Tickets & Statuses
router.get("/tickets", protect, getOrganizationTickets);

// ============================================================================
// SUPER ADMIN PORTAL ROUTES (Strictly Protected by verifySuperAdmin)
// ============================================================================

// 4. Master Ticket Queue across all client organizations
router.get("/admin/tickets", verifySuperAdmin, getAllTicketsAdmin);

// 5. Inspect single ticket with full AI chat history & details
router.get("/admin/tickets/:id", verifySuperAdmin, getTicketById);

// 6. Update Ticket Status (Open -> In Progress -> Resolved) & write resolution notes
router.patch("/admin/tickets/:id/status", verifySuperAdmin, updateTicketStatusAdmin);

export default router;
