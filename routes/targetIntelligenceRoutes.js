import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { requireAddon } from "../middleware/addonMiddleware.js";
import {
  getQuota,
  interpretPrompt,
  searchProspects,
  resolveProspect,
  unresolveProspect,
  bulkResolveProspects,
  getResolvedProspects,
  getSearches,
  getCompanies,
  getCompanyById,
  enrichCompany,
  exportProspects,
  getTargetLists,
  createTargetList,
  updateTargetList,
  deleteTargetList,
  getProviderStatus,
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

// Quota & Health
router.get("/quota", getQuota);
router.get("/providers/status", getProviderStatus);

// Search & Prompt Interpretation
router.post("/interpret-prompt", interpretPrompt);
router.post("/search", searchProspects);
router.get("/searches", getSearches);

// Companies & Enrichment
router.get("/companies", getCompanies);
router.get("/companies/:id", getCompanyById);
router.post("/companies/:id/enrich", enrichCompany);

// Resolution Tracking
router.post("/resolve", resolveProspect);
router.post("/unresolve", unresolveProspect);
router.post("/bulk-resolve", bulkResolveProspects);
router.get("/resolved-list", getResolvedProspects);

// Export (Excel / CSV)
router.post("/export", exportProspects);

// Target Lists
router.get("/lists", getTargetLists);
router.post("/lists", createTargetList);
router.patch("/lists/:id", updateTargetList);
router.delete("/lists/:id", deleteTargetList);

export default router;
