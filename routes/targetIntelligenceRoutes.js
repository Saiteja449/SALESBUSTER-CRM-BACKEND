/* Target Intelligence feature commented out
import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { requireAddon } from "../middleware/addonMiddleware.js";
import {
  getQuota,
  interpretPrompt,
  searchProspects,
  importToCrm,
} from "../controllers/targetIntelligenceController.js";

const router = express.Router();

/**
 * Middleware: Restricts Target Intelligence strictly to Sales Managers, Org Owners, and Super Admins
 */
export const requireSalesManagerOrOwner = (req, res, next) => {
  const role = String(req.user?.role || "").toLowerCase().trim();
  const isAuthorized =
    role === "sales manager" ||
    role === "super_admin" ||
    role === "super admin" ||
    Boolean(req.user?.isOrgOwner);

  if (!isAuthorized) {
    return res.status(403).json({
      success: false,
      message: "Access forbidden: Target Intelligence is restricted to Sales Manager role.",
    });
  }

  next();
};

// All Target Intelligence routes require auth, Sales Manager / Owner role, and the targetIntelligence add-on
router.use(protect);
router.use(requireSalesManagerOrOwner);
router.use(requireAddon("targetIntelligence"));

router.get("/quota", getQuota);
router.post("/interpret-prompt", interpretPrompt);
router.post("/search", searchProspects);
router.post("/import-to-crm", importToCrm);

export default router;

*/
