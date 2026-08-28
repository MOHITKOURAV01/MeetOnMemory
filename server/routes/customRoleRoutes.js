// server/routes/customRoleRoutes.js
//
// Mounted at /api/custom-roles by routes/index.js.
//
// This router existed but was never imported anywhere (Issue #2570), so every
// endpoint below returned 404 in the running app. When wiring it up, the
// authorization it *should* have had became visible: reading the role matrix
// is a settings-view concern, while creating roles and writing resource ACLs
// is administration — `userAuth` alone let any member grant themselves ADMIN
// on any resource id.

import express from "express";
import userAuth from "../middleware/userAuth.js";
import { requireOrgMembership, requirePermission } from "../middleware/rbac.js";
import {
  createCustomRole,
  getCustomRoles,
  setResourceAclEntry,
  listResourceAclEntries,
  checkResourcePermission,
} from "../controllers/customRoleController.js";

const router = express.Router();

router.use(userAuth);
router.use(requireOrgMembership);

// Reading the configured roles is part of viewing organization settings.
router.get("/roles", requirePermission("settings", "view"), getCustomRoles);

// Defining a role changes what everyone in the organization may do.
router.post(
  "/roles",
  requirePermission("admin_panel", "manage"),
  createCustomRole,
);

// Granting or revoking access to a specific resource is an admin action.
router.post(
  "/acl",
  requirePermission("admin_panel", "manage"),
  setResourceAclEntry,
);

router.get(
  "/acl",
  requirePermission("settings", "view"),
  listResourceAclEntries,
);

// A caller asking "may I do X here?" about themselves needs no extra
// privilege — the answer is already scoped to their session.
router.get("/check-permission", checkResourcePermission);

export default router;
