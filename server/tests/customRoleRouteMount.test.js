import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openai", () => ({
  default: class OpenAI {},
}));

vi.mock("../models/customRoleModel.js", () => ({
  default: {
    create: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock("../models/resourceAclModel.js", () => ({
  default: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

import mongoose from "mongoose";
import routes from "../routes/index.js";
import customRoleRoutes from "../routes/customRoleRoutes.js";
import CustomRole from "../models/customRoleModel.js";
import ResourceAcl from "../models/resourceAclModel.js";
import rbacMatrixService from "../services/rbacMatrixService.js";
import {
  createCustomRole,
  getCustomRoles,
  setResourceAclEntry,
  listResourceAclEntries,
  checkResourcePermission,
} from "../controllers/customRoleController.js";
import {
  resolveOrganizationId,
  isUsableScope,
} from "../utils/organizationContext.js";

const ORG_A = "507f1f77bcf86cd799439011";
const ORG_B = "507f1f77bcf86cd799439012";
const RESOURCE_ID = "507f1f77bcf86cd799439013";
const GRANTEE_ID = "507f1f77bcf86cd799439014";
const ROLE_ID = "507f1f77bcf86cd799439015";

function countMatchingLayers(router, pathStr) {
  const stack = router.stack || [];
  return stack.filter(
    (layer) => typeof layer.match === "function" && layer.match(pathStr),
  ).length;
}

/**
 * Counts how many times a specific sub-router is mounted.
 *
 * `countMatchingLayers` answers "does this path resolve?", which is the right
 * question for reachability but the wrong one for uniqueness: several routers
 * are mounted on broad prefixes such as `/api`, so more than one layer legitimately
 * matches `/api/custom-roles`. Identity comparison is what "mounted once" means.
 */
function countMountsOf(router, subRouter) {
  const stack = router.stack || [];
  return stack.filter((layer) => layer.handle === subRouter).length;
}

const createRes = () => {
  const res = { statusCode: undefined, body: undefined };
  res.status = vi.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((payload) => {
    res.body = payload;
    return res;
  });
  return res;
};

/**
 * Builds a request in the shape `userAuth` actually leaves behind: the user
 * document carries `organization`, never `organizationId`. That distinction is
 * the whole bug — reading `req.user.organizationId` yields `undefined` on a
 * perfectly valid session.
 */
const createReq = ({
  orgId = ORG_A,
  headers = {},
  body = {},
  query = {},
  populated = false,
} = {}) => {
  let organization;
  if (orgId) {
    organization = populated
      ? { _id: new mongoose.Types.ObjectId(orgId), name: "Acme" }
      : new mongoose.Types.ObjectId(orgId);
  }

  return {
    headers,
    body,
    query,
    params: {},
    user: {
      _id: new mongoose.Types.ObjectId(),
      organization,
    },
  };
};

const mockFindChain = (result) => ({
  sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(result) }),
});

describe("Custom Roles & Resource ACL route mount and tenant scoping (#2570)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CustomRole.find.mockReturnValue(mockFindChain([]));
    CustomRole.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    ResourceAcl.find.mockReturnValue(mockFindChain([]));
    ResourceAcl.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    ResourceAcl.findOneAndUpdate.mockResolvedValue({ _id: "acl-1" });
  });

  describe("router registration", () => {
    it("mounts the custom role router at /api/custom-roles", () => {
      expect(countMountsOf(routes, customRoleRoutes)).toBe(1);
      expect(countMatchingLayers(routes, "/api/custom-roles")).toBeGreaterThan(
        0,
      );
    });

    it("resolves every endpoint the feature exposes", () => {
      for (const path of [
        "/api/custom-roles/roles",
        "/api/custom-roles/acl",
        "/api/custom-roles/check-permission",
      ]) {
        expect(countMatchingLayers(routes, path)).toBeGreaterThan(0);
      }
    });

    it("exports a usable Express router", () => {
      expect(typeof customRoleRoutes).toBe("function");
      expect((customRoleRoutes.stack || []).length).toBeGreaterThan(0);
    });

    it("does not register the router twice", () => {
      expect(countMountsOf(routes, customRoleRoutes)).toBe(1);
    });
  });

  describe("organization resolution", () => {
    it("reads the organization off the session, not a header", () => {
      const req = createReq({
        orgId: ORG_A,
        headers: { "x-organization-id": ORG_B },
      });
      expect(resolveOrganizationId(req)).toBe(ORG_A);
    });

    it("handles a populated organization document", () => {
      const req = createReq({ orgId: ORG_A, populated: true });
      expect(resolveOrganizationId(req)).toBe(ORG_A);
    });

    it("returns null when the session carries no organization", () => {
      expect(resolveOrganizationId(createReq({ orgId: null }))).toBeNull();
    });

    it("rejects an unusable scope so it can never reach a filter", () => {
      expect(isUsableScope(undefined)).toBe(false);
      expect(isUsableScope(null)).toBe(false);
      expect(isUsableScope("")).toBe(false);
      expect(isUsableScope("not-an-id")).toBe(false);
      expect(isUsableScope(ORG_A)).toBe(true);
    });
  });

  describe("getCustomRoles", () => {
    it("scopes the query to the caller's own organization", async () => {
      const req = createReq();
      const res = createRes();

      await getCustomRoles(req, res);

      expect(res.statusCode).toBe(200);
      expect(CustomRole.find).toHaveBeenCalledWith({ organizationId: ORG_A });
    });

    it("ignores an x-organization-id header naming another tenant", async () => {
      const req = createReq({
        orgId: ORG_A,
        headers: { "x-organization-id": ORG_B },
      });
      const res = createRes();

      await getCustomRoles(req, res);

      expect(CustomRole.find).toHaveBeenCalledWith({ organizationId: ORG_A });
      expect(CustomRole.find).not.toHaveBeenCalledWith({
        organizationId: ORG_B,
      });
    });

    it("refuses a caller with no organization instead of querying unscoped", async () => {
      const req = createReq({
        orgId: null,
        headers: { "x-organization-id": ORG_B },
      });
      const res = createRes();

      await getCustomRoles(req, res);

      expect(res.statusCode).toBe(403);
      expect(CustomRole.find).not.toHaveBeenCalled();
    });
  });

  describe("createCustomRole", () => {
    it("creates the role in the caller's organization", async () => {
      CustomRole.create.mockResolvedValue({ _id: "role-1", name: "Auditor" });
      const req = createReq({ body: { name: "Auditor" } });
      const res = createRes();

      await createCustomRole(req, res);

      expect(res.statusCode).toBe(201);
      expect(CustomRole.create).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORG_A, name: "Auditor" }),
      );
    });

    it("never takes the organization from the request body or headers", async () => {
      CustomRole.create.mockResolvedValue({ _id: "role-1" });
      const req = createReq({
        orgId: ORG_A,
        headers: { "x-organization-id": ORG_B },
        body: { name: "Auditor", organizationId: ORG_B },
      });
      const res = createRes();

      await createCustomRole(req, res);

      expect(CustomRole.create).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORG_A }),
      );
    });

    it("requires a name", async () => {
      const req = createReq({ body: { name: "   " } });
      const res = createRes();

      await createCustomRole(req, res);

      expect(res.statusCode).toBe(400);
      expect(CustomRole.create).not.toHaveBeenCalled();
    });

    it("rejects a non-numeric priority with 400 rather than a 500 CastError", async () => {
      const req = createReq({ body: { name: "Auditor", priority: "soon" } });
      const res = createRes();

      await createCustomRole(req, res);

      expect(res.statusCode).toBe(400);
      expect(CustomRole.create).not.toHaveBeenCalled();
    });

    it("maps a duplicate key error to 409", async () => {
      CustomRole.create.mockRejectedValue({ code: 11000 });
      const req = createReq({ body: { name: "Auditor" } });
      const res = createRes();

      await createCustomRole(req, res);

      expect(res.statusCode).toBe(409);
    });

    it("maps a schema validation error to 400, not 500", async () => {
      CustomRole.create.mockRejectedValue(
        Object.assign(new Error("bad"), { name: "ValidationError" }),
      );
      const req = createReq({ body: { name: "Auditor" } });
      const res = createRes();

      await createCustomRole(req, res);

      expect(res.statusCode).toBe(400);
    });

    it("tolerates a missing body", async () => {
      const req = createReq();
      req.body = undefined;
      const res = createRes();

      await createCustomRole(req, res);

      expect(res.statusCode).toBe(400);
    });
  });

  describe("setResourceAclEntry", () => {
    const validBody = {
      resourceType: "MEETING",
      resourceId: RESOURCE_ID,
      granteeType: "USER",
      granteeId: GRANTEE_ID,
      permissions: ["READ"],
    };

    it("writes the grant scoped to the caller's organization", async () => {
      const req = createReq({ body: validBody });
      const res = createRes();

      await setResourceAclEntry(req, res);

      expect(res.statusCode).toBe(200);
      expect(ResourceAcl.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORG_A }),
        expect.objectContaining({ organizationId: ORG_A }),
        expect.any(Object),
      );
    });

    it("matches on granteeType so USER and ROLE grants cannot overwrite each other", async () => {
      const req = createReq({ body: validBody });
      const res = createRes();

      await setResourceAclEntry(req, res);

      const [filter] = ResourceAcl.findOneAndUpdate.mock.calls[0];
      expect(filter.granteeType).toBe("USER");
    });

    it("rejects an unknown resourceType with 400", async () => {
      const req = createReq({
        body: { ...validBody, resourceType: "SPREADSHEET" },
      });
      const res = createRes();

      await setResourceAclEntry(req, res);

      expect(res.statusCode).toBe(400);
      expect(ResourceAcl.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects an unknown granteeType with 400", async () => {
      const req = createReq({ body: { ...validBody, granteeType: "GROUP" } });
      const res = createRes();

      await setResourceAclEntry(req, res);

      expect(res.statusCode).toBe(400);
    });

    it("rejects a malformed resourceId with 400", async () => {
      const req = createReq({ body: { ...validBody, resourceId: "nope" } });
      const res = createRes();

      await setResourceAclEntry(req, res);

      expect(res.statusCode).toBe(400);
    });

    it("rejects an unsupported permission verb with 400", async () => {
      const req = createReq({
        body: { ...validBody, permissions: ["READ", "SUDO"] },
      });
      const res = createRes();

      await setResourceAclEntry(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain("SUDO");
    });

    it("rejects an empty permission list", async () => {
      const req = createReq({ body: { ...validBody, permissions: [] } });
      const res = createRes();

      await setResourceAclEntry(req, res);

      expect(res.statusCode).toBe(400);
    });

    it("normalizes and de-duplicates permissions", async () => {
      const req = createReq({
        body: { ...validBody, permissions: ["read", "READ", "write"] },
      });
      const res = createRes();

      await setResourceAclEntry(req, res);

      const [, update] = ResourceAcl.findOneAndUpdate.mock.calls[0];
      expect(update.permissions).toEqual(["READ", "WRITE"]);
    });

    it("refuses to write anything for a caller with no organization", async () => {
      const req = createReq({
        orgId: null,
        headers: { "x-organization-id": ORG_B },
        body: validBody,
      });
      const res = createRes();

      await setResourceAclEntry(req, res);

      expect(res.statusCode).toBe(403);
      expect(ResourceAcl.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe("listResourceAclEntries", () => {
    it("lists grants for a resource inside the caller's organization", async () => {
      const req = createReq({
        query: { resourceType: "MEETING", resourceId: RESOURCE_ID },
      });
      const res = createRes();

      await listResourceAclEntries(req, res);

      expect(res.statusCode).toBe(200);
      expect(ResourceAcl.find).toHaveBeenCalledWith({
        organizationId: ORG_A,
        resourceType: "MEETING",
        resourceId: RESOURCE_ID,
      });
    });

    it("requires resourceType and resourceId", async () => {
      const req = createReq({ query: {} });
      const res = createRes();

      await listResourceAclEntries(req, res);

      expect(res.statusCode).toBe(400);
      expect(ResourceAcl.find).not.toHaveBeenCalled();
    });
  });

  describe("checkResourcePermission", () => {
    it("evaluates against the caller's own organization", async () => {
      const spy = vi
        .spyOn(rbacMatrixService, "evaluateResourceAccess")
        .mockResolvedValue(true);

      const req = createReq({
        headers: { "x-organization-id": ORG_B },
        query: { resourceType: "MEETING", resourceId: RESOURCE_ID },
      });
      const res = createRes();

      await checkResourcePermission(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.hasAccess).toBe(true);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORG_A }),
      );
      spy.mockRestore();
    });

    it("defaults requiredPermission to READ", async () => {
      const spy = vi
        .spyOn(rbacMatrixService, "evaluateResourceAccess")
        .mockResolvedValue(false);

      const req = createReq({
        query: { resourceType: "MEETING", resourceId: RESOURCE_ID },
      });
      await checkResourcePermission(req, createRes());

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ requiredPermission: "READ" }),
      );
      spy.mockRestore();
    });

    it("rejects an unsupported requiredPermission with 400", async () => {
      const req = createReq({
        query: {
          resourceType: "MEETING",
          resourceId: RESOURCE_ID,
          requiredPermission: "SUDO",
        },
      });
      const res = createRes();

      await checkResourcePermission(req, res);

      expect(res.statusCode).toBe(400);
    });

    it("refuses a caller with no organization before evaluating", async () => {
      const spy = vi.spyOn(rbacMatrixService, "evaluateResourceAccess");

      const req = createReq({
        orgId: null,
        headers: { "x-organization-id": ORG_B },
        query: { resourceType: "MEETING", resourceId: RESOURCE_ID },
      });
      const res = createRes();

      await checkResourcePermission(req, res);

      expect(res.statusCode).toBe(403);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("rbacMatrixService tenant safety", () => {
    it("returns false rather than running an unscoped ACL query", async () => {
      const result = await rbacMatrixService.evaluateResourceAccess({
        organizationId: undefined,
        userId: GRANTEE_ID,
        resourceType: "MEETING",
        resourceId: RESOURCE_ID,
        requiredPermission: "READ",
      });

      expect(result).toBe(false);
      // The regression: Mongoose strips `organizationId: undefined`, so this
      // query used to match ACL rows in every organization.
      expect(ResourceAcl.findOne).not.toHaveBeenCalled();
    });

    it("does not throw on an ACL row whose permissions array is missing", async () => {
      ResourceAcl.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: "acl-1", permissions: null }),
      });

      const result = await rbacMatrixService.evaluateResourceAccess({
        organizationId: ORG_A,
        userId: GRANTEE_ID,
        resourceType: "MEETING",
        resourceId: RESOURCE_ID,
        requiredPermission: "READ",
      });

      expect(result).toBe(false);
    });

    it("grants when the user ACL carries the required permission", async () => {
      ResourceAcl.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({ permissions: ["READ", "WRITE"] }),
      });

      await expect(
        rbacMatrixService.evaluateResourceAccess({
          organizationId: ORG_A,
          userId: GRANTEE_ID,
          resourceType: "MEETING",
          resourceId: RESOURCE_ID,
          requiredPermission: "WRITE",
        }),
      ).resolves.toBe(true);
    });

    it("treats an ADMIN grant as covering any permission", async () => {
      ResourceAcl.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({ permissions: ["ADMIN"] }),
      });

      await expect(
        rbacMatrixService.evaluateResourceAccess({
          organizationId: ORG_A,
          userId: GRANTEE_ID,
          resourceType: "MEETING",
          resourceId: RESOURCE_ID,
          requiredPermission: "EXPORT",
        }),
      ).resolves.toBe(true);
    });

    it("scopes the fallback role lookup to the organization", async () => {
      CustomRole.findOne.mockReturnValue({
        lean: vi
          .fn()
          .mockResolvedValue({ permissions: { meetings: { view: true } } }),
      });

      await rbacMatrixService.evaluateResourceAccess({
        organizationId: ORG_A,
        userId: GRANTEE_ID,
        userRoleId: ROLE_ID,
        resourceType: "MEETING",
        resourceId: RESOURCE_ID,
        requiredPermission: "READ",
      });

      expect(CustomRole.findOne).toHaveBeenCalledWith({
        _id: ROLE_ID,
        organizationId: ORG_A,
      });
    });

    it("refuses hasGlobalPermission without a tenant", async () => {
      await expect(
        rbacMatrixService.hasGlobalPermission(
          undefined,
          ROLE_ID,
          "meetings",
          "view",
        ),
      ).resolves.toBe(false);
      expect(CustomRole.findOne).not.toHaveBeenCalled();
    });

    it("throws rather than writing an unscoped ACL document", async () => {
      await expect(
        rbacMatrixService.setResourceAcl({
          organizationId: undefined,
          resourceType: "MEETING",
          resourceId: RESOURCE_ID,
          granteeType: "USER",
          granteeId: GRANTEE_ID,
          permissions: ["READ"],
        }),
      ).rejects.toThrow(/organizationId/);

      expect(ResourceAcl.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});
