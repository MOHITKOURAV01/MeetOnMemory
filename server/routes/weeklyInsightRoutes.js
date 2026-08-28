import express from "express";
import {
  getLatestInsight,
  getInsightHistory,
  triggerManualGeneration,
} from "../controllers/weeklyInsightController.js";
import userAuth from "../middleware/userAuth.js";
import {
  requireRole,
  requireOrganizationParamMatch,
} from "../middleware/rbac.js";

const router = express.Router();

router.use(userAuth);

// `requireRole` asserts the caller *has* a role. It says nothing about which
// organization that role is in, so on its own it let a member of org A read
// org B's insights by editing the id in the path (Issue #2571).
//
// `requireOrganizationParamMatch` closes that, and sets
// `req.authorizedOrganizationId` — the server-resolved membership org, which
// is what the handlers query with. The raw `:orgId` is never used again.
router.use("/:orgId", requireOrganizationParamMatch("orgId"));

router.get(
  "/:orgId/latest",
  requireRole(["owner", "admin", "member"]),
  getLatestInsight,
);
router.get(
  "/:orgId",
  requireRole(["owner", "admin", "member"]),
  getInsightHistory,
);
router.post(
  "/:orgId/generate",
  requireRole(["owner", "admin"]),
  triggerManualGeneration,
);

export default router;
