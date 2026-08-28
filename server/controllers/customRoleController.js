import mongoose from "mongoose";
import CustomRole from "../models/customRoleModel.js";
import ResourceAcl from "../models/resourceAclModel.js";
import rbacMatrixService from "../services/rbacMatrixService.js";
import { requireOrganizationId } from "../utils/organizationContext.js";

/**
 * Controller handling Custom Roles and Resource-Level ACL configurations.
 *
 * Every handler resolves its tenant through `requireOrganizationId`, which
 * reads the authenticated session and ignores request headers entirely
 * (Issue #2570). Nothing here should ever read `req.headers` for scope.
 */

/** Grantee kinds the ACL model accepts. */
const GRANTEE_TYPES = ["USER", "ROLE"];

/** Resource kinds the ACL model accepts. */
const RESOURCE_TYPES = ["MEETING", "FOLDER", "POLICY", "REPORT"];

/** Permission verbs the ACL model accepts. */
const ACL_PERMISSIONS = ["READ", "WRITE", "ADMIN", "DELEGATE", "EXPORT"];

/**
 * Validates a permission list against the model's enum.
 *
 * The schema enum rejects bad values at save time, but as a `ValidationError`
 * that the old catch-all reported as a 500. Checking here turns operator typos
 * into a 400 that names the offending value.
 *
 * @param {*} permissions
 * @returns {{ok: true, value: string[]}|{ok: false, message: string}}
 */
const validatePermissions = (permissions) => {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    return { ok: false, message: "permissions must be a non-empty array" };
  }

  const normalized = permissions.map((p) => String(p).toUpperCase());
  const unknown = normalized.filter((p) => !ACL_PERMISSIONS.includes(p));

  if (unknown.length > 0) {
    return {
      ok: false,
      message: `Unsupported permission(s): ${unknown.join(", ")}. Allowed: ${ACL_PERMISSIONS.join(", ")}`,
    };
  }

  return { ok: true, value: [...new Set(normalized)] };
};

export const createCustomRole = async (req, res) => {
  try {
    const organizationId = requireOrganizationId(req, res);
    if (!organizationId) return;

    const { name, description, permissions, priority } = req.body || {};

    if (!name || !String(name).trim()) {
      return res
        .status(400)
        .json({ success: false, error: "Role name is required" });
    }

    // `priority` orders roles when several apply. A non-numeric value used to
    // reach Mongoose as-is and surface as a 500 CastError.
    let resolvedPriority = 10;
    if (priority !== undefined && priority !== null && priority !== "") {
      const parsed = Number(priority);
      if (!Number.isFinite(parsed)) {
        return res
          .status(400)
          .json({ success: false, error: "priority must be a number" });
      }
      resolvedPriority = parsed;
    }

    const role = await CustomRole.create({
      organizationId,
      name: String(name).trim(),
      description: description ? String(description) : "",
      permissions,
      priority: resolvedPriority,
    });

    return res.status(201).json({
      success: true,
      message: "Custom role created successfully",
      role,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: "Role name already exists in organization",
      });
    }
    if (error.name === "ValidationError") {
      return res.status(400).json({ success: false, error: error.message });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const getCustomRoles = async (req, res) => {
  try {
    const organizationId = requireOrganizationId(req, res);
    if (!organizationId) return;

    const roles = await CustomRole.find({ organizationId })
      .sort({ priority: 1 })
      .lean();

    return res.status(200).json({ success: true, roles });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const setResourceAclEntry = async (req, res) => {
  try {
    const organizationId = requireOrganizationId(req, res);
    if (!organizationId) return;

    const userId = req.user?._id || req.user?.id;
    const { resourceType, resourceId, granteeType, granteeId, permissions } =
      req.body || {};

    if (!resourceType || !resourceId || !granteeType || !granteeId) {
      return res.status(400).json({
        success: false,
        error:
          "resourceType, resourceId, granteeType and granteeId are required",
      });
    }

    const normalizedResourceType = String(resourceType).toUpperCase();
    if (!RESOURCE_TYPES.includes(normalizedResourceType)) {
      return res.status(400).json({
        success: false,
        error: `resourceType must be one of: ${RESOURCE_TYPES.join(", ")}`,
      });
    }

    const normalizedGranteeType = String(granteeType).toUpperCase();
    if (!GRANTEE_TYPES.includes(normalizedGranteeType)) {
      return res.status(400).json({
        success: false,
        error: `granteeType must be one of: ${GRANTEE_TYPES.join(", ")}`,
      });
    }

    if (!mongoose.Types.ObjectId.isValid(String(resourceId))) {
      return res
        .status(400)
        .json({ success: false, error: "resourceId must be a valid id" });
    }

    if (!mongoose.Types.ObjectId.isValid(String(granteeId))) {
      return res
        .status(400)
        .json({ success: false, error: "granteeId must be a valid id" });
    }

    const permissionCheck = validatePermissions(permissions);
    if (!permissionCheck.ok) {
      return res
        .status(400)
        .json({ success: false, error: permissionCheck.message });
    }

    const acl = await rbacMatrixService.setResourceAcl({
      organizationId,
      resourceType: normalizedResourceType,
      resourceId,
      granteeType: normalizedGranteeType,
      granteeId,
      permissions: permissionCheck.value,
      grantedBy: userId,
    });

    return res.status(200).json({
      success: true,
      message: "Resource ACL updated successfully",
      acl,
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ success: false, error: error.message });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const listResourceAclEntries = async (req, res) => {
  try {
    const organizationId = requireOrganizationId(req, res);
    if (!organizationId) return;

    const { resourceType, resourceId } = req.query || {};

    if (!resourceType || !resourceId) {
      return res.status(400).json({
        success: false,
        error: "resourceType and resourceId are required",
      });
    }

    const normalizedResourceType = String(resourceType).toUpperCase();
    if (!RESOURCE_TYPES.includes(normalizedResourceType)) {
      return res.status(400).json({
        success: false,
        error: `resourceType must be one of: ${RESOURCE_TYPES.join(", ")}`,
      });
    }

    if (!mongoose.Types.ObjectId.isValid(String(resourceId))) {
      return res
        .status(400)
        .json({ success: false, error: "resourceId must be a valid id" });
    }

    const entries = await ResourceAcl.find({
      organizationId,
      resourceType: normalizedResourceType,
      resourceId,
    })
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({ success: true, entries });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const checkResourcePermission = async (req, res) => {
  try {
    const organizationId = requireOrganizationId(req, res);
    if (!organizationId) return;

    const userId = req.user?._id || req.user?.id;
    const userRoleId = req.user?.customRoleId || req.user?.roleId;
    const { resourceType, resourceId, requiredPermission } = req.query || {};

    if (!resourceType || !resourceId) {
      return res.status(400).json({
        success: false,
        error: "resourceType and resourceId are required",
      });
    }

    const normalizedResourceType = String(resourceType).toUpperCase();
    if (!RESOURCE_TYPES.includes(normalizedResourceType)) {
      return res.status(400).json({
        success: false,
        error: `resourceType must be one of: ${RESOURCE_TYPES.join(", ")}`,
      });
    }

    if (!mongoose.Types.ObjectId.isValid(String(resourceId))) {
      return res
        .status(400)
        .json({ success: false, error: "resourceId must be a valid id" });
    }

    const normalizedPermission = String(
      requiredPermission || "READ",
    ).toUpperCase();
    if (!ACL_PERMISSIONS.includes(normalizedPermission)) {
      return res.status(400).json({
        success: false,
        error: `requiredPermission must be one of: ${ACL_PERMISSIONS.join(", ")}`,
      });
    }

    const hasAccess = await rbacMatrixService.evaluateResourceAccess({
      organizationId,
      userId,
      userRoleId,
      resourceType: normalizedResourceType,
      resourceId,
      requiredPermission: normalizedPermission,
    });

    return res.status(200).json({ success: true, hasAccess });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
