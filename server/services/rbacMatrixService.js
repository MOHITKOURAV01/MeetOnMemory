import CustomRole from "../models/customRoleModel.js";
import ResourceAcl from "../models/resourceAclModel.js";
import { isUsableScope } from "../utils/organizationContext.js";

/**
 * Service evaluating workspace custom roles, permission inheritance,
 * and fine-grained resource-level ACLs.
 *
 * Tenant scoping note (Issue #2570): every query in here filters on
 * `organizationId`. Mongoose drops `undefined` keys from a filter, so an
 * `organizationId` that never got resolved does not narrow the query — it
 * removes the tenant boundary and matches ACL rows belonging to other
 * organizations. Each entry point therefore verifies the scope is usable
 * before it queries, and refuses rather than guesses.
 */
class RbacMatrixService {
  /**
   * Evaluate if a role has a specific global capability.
   *
   * @returns {Promise<boolean>}
   */
  async hasGlobalPermission(organizationId, roleId, domain, action) {
    if (!isUsableScope(organizationId) || !isUsableScope(roleId)) return false;

    const role = await CustomRole.findOne({
      _id: roleId,
      organizationId,
    }).lean();
    if (!role) return false;

    return Boolean(role.permissions?.[domain]?.[action]);
  }

  /**
   * Reads a permission list off an ACL row.
   *
   * `permissions` is an optional array in the schema, so a row written before
   * the field existed — or written with an empty body — has `undefined` here.
   * The previous code called `.includes()` on it directly, turning that row
   * into a 500 for every caller who happened to match it.
   */
  #grants(acl, requiredPermission) {
    const permissions = Array.isArray(acl?.permissions) ? acl.permissions : [];
    return (
      permissions.includes(requiredPermission) || permissions.includes("ADMIN")
    );
  }

  /**
   * Evaluate effective permission on a specific resource
   * (Resource ACL, then role ACL, then the global domain permission).
   *
   * @returns {Promise<boolean>} `false` — never a throw — when the request
   *   cannot be scoped to a tenant.
   */
  async evaluateResourceAccess({
    organizationId,
    userId,
    userRoleId,
    resourceType,
    resourceId,
    requiredPermission,
  }) {
    // Without a tenant there is no question to answer. Returning false is the
    // safe answer; querying anyway would search every organization's ACLs.
    if (!isUsableScope(organizationId)) return false;
    if (!isUsableScope(resourceId)) return false;
    if (!resourceType) return false;

    const permission = requiredPermission || "READ";

    // 1. Direct user ACL
    if (isUsableScope(userId)) {
      const userAcl = await ResourceAcl.findOne({
        organizationId,
        resourceType,
        resourceId,
        granteeType: "USER",
        granteeId: userId,
      }).lean();

      if (this.#grants(userAcl, permission)) return true;
    }

    // 2. Role ACL
    if (isUsableScope(userRoleId)) {
      const roleAcl = await ResourceAcl.findOne({
        organizationId,
        resourceType,
        resourceId,
        granteeType: "ROLE",
        granteeId: userRoleId,
      }).lean();

      if (this.#grants(roleAcl, permission)) return true;
    }

    // 3. Fallback to the global domain permission carried by the custom role.
    const domainMap = {
      MEETING: "meetings",
      FOLDER: "knowledge",
      POLICY: "policies",
      REPORT: "analytics",
    };
    const actionMap = {
      READ: "view",
      WRITE: "edit",
      ADMIN: "delete",
    };

    const domain = domainMap[resourceType] || "meetings";
    const action = actionMap[permission] || "view";

    return await this.hasGlobalPermission(
      organizationId,
      userRoleId,
      domain,
      action,
    );
  }

  /**
   * Set or update a resource-level ACL.
   *
   * The upsert filter includes `granteeType`. The unique index is
   * `{organizationId, resourceType, resourceId, granteeId}` — it does not
   * contain `granteeType` — so matching without it meant a USER grant and a
   * ROLE grant that happened to share an id overwrote one another, silently
   * flipping who a grant applied to.
   *
   * @throws {Error} when the call cannot be scoped to a tenant. This is a
   *   programming error at the call site, not user input, and must not be
   *   allowed to write an unscoped document.
   */
  async setResourceAcl({
    organizationId,
    resourceType,
    resourceId,
    granteeType,
    granteeId,
    permissions,
    grantedBy,
  }) {
    if (!isUsableScope(organizationId)) {
      throw new Error("setResourceAcl requires a resolved organizationId");
    }

    return await ResourceAcl.findOneAndUpdate(
      {
        organizationId,
        resourceType,
        resourceId,
        granteeType,
        granteeId,
      },
      {
        organizationId,
        resourceType,
        resourceId,
        granteeType,
        granteeId,
        permissions,
        grantedBy,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }
}

export default new RbacMatrixService();
