import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openai", () => ({
  default: class OpenAI {},
}));

vi.mock("../models/weeklyInsightModel.js", () => ({
  default: {
    find: vi.fn(),
    findOne: vi.fn(),
    countDocuments: vi.fn(),
  },
}));

vi.mock("../services/weeklyInsightService.js", () => ({
  generateInsight: vi.fn(),
}));

vi.mock("../models/physicalResourceModel.js", () => ({
  default: {
    find: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock("../models/resourceBookingModel.js", () => {
  const ResourceBooking = vi.fn(function (doc) {
    Object.assign(this, doc);
    this.save = vi.fn().mockResolvedValue(this);
  });
  ResourceBooking.find = vi.fn();
  ResourceBooking.findOne = vi.fn();
  ResourceBooking.findOneAndDelete = vi.fn();
  ResourceBooking.findByIdAndDelete = vi.fn();
  return { default: ResourceBooking };
});

import mongoose from "mongoose";
import WeeklyInsight from "../models/weeklyInsightModel.js";
import PhysicalResource from "../models/physicalResourceModel.js";
import ResourceBooking from "../models/resourceBookingModel.js";
import { generateInsight } from "../services/weeklyInsightService.js";
import { requireOrganizationParamMatch } from "../middleware/rbac.js";
import weeklyInsightRoutes from "../routes/weeklyInsightRoutes.js";
import resourceBookingRoutes from "../routes/resourceBookingRoutes.js";
import {
  getLatestInsight,
  getInsightHistory,
  triggerManualGeneration,
} from "../controllers/weeklyInsightController.js";
import {
  getPhysicalResources,
  createPhysicalResource,
  getAvailableResources,
  createBooking,
  cancelBooking,
  getMeetingBookings,
} from "../controllers/resourceBookingController.js";
import resourceBookingService from "../services/resourceBookingService.js";

const ORG_A = "507f1f77bcf86cd799439011";
const ORG_B = "507f1f77bcf86cd799439012";
const MEETING_ID = "507f1f77bcf86cd799439013";
const RESOURCE_ID = "507f1f77bcf86cd799439014";
const BOOKING_ID = "507f1f77bcf86cd799439015";

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
 * A request as it reaches a handler *after* `requireOrganizationParamMatch`
 * has run: the raw path parameter is still whatever the caller typed, and
 * `authorizedOrganizationId` is the server-resolved membership org. Keeping
 * both distinct is what lets these tests prove the handler reads the right one.
 */
const createReq = ({
  orgId = ORG_A,
  paramOrgId = ORG_A,
  authorized = ORG_A,
  params = {},
  query = {},
  body = {},
  role = "member",
} = {}) => ({
  params: { orgId: paramOrgId, organizationId: paramOrgId, ...params },
  query,
  body,
  authorizedOrganizationId: authorized,
  user: {
    _id: new mongoose.Types.ObjectId(),
    role,
    organization: orgId ? new mongoose.Types.ObjectId(orgId) : undefined,
  },
});

/**
 * Does this router refuse a request whose organization path parameter names a
 * different tenant?
 *
 * `requireOrganizationParamMatch` returns an anonymous closure, so its layer
 * carries no useful `name` — asserting on the identifier would test nothing.
 * Driving a foreign-organization request through the router's own middleware
 * layers tests the property we actually care about.
 */
const guardsOrgParam = (router, paramName) => {
  const layers = (router.stack || []).filter((layer) => !layer.route);

  return layers.some((layer) => {
    const req = createReq({ orgId: ORG_A, paramOrgId: ORG_B });
    req.params = { [paramName]: ORG_B };
    const res = createRes();
    const next = vi.fn();

    try {
      layer.handle(req, res, next);
    } catch {
      return false;
    }

    return res.statusCode === 403 && !next.mock.calls.length;
  });
};

const findChain = (result) => ({
  sort: vi.fn().mockReturnValue({
    skip: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(result),
    }),
    populate: vi.fn().mockReturnValue({
      populate: vi.fn().mockResolvedValue(result[0] ?? null),
    }),
  }),
});

describe("Organization path-parameter tenant isolation (#2571)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    WeeklyInsight.find.mockReturnValue(findChain([]));
    WeeklyInsight.findOne.mockReturnValue(findChain([]));
    WeeklyInsight.countDocuments.mockResolvedValue(0);
    PhysicalResource.find.mockResolvedValue([]);
    PhysicalResource.findOne.mockResolvedValue(null);
    ResourceBooking.find.mockReturnValue({
      populate: vi.fn().mockResolvedValue([]),
    });
    ResourceBooking.findOne.mockResolvedValue(null);
    ResourceBooking.findOneAndDelete.mockResolvedValue({ _id: BOOKING_ID });
  });

  describe("route wiring", () => {
    it("guards the weekly insight routes with requireOrganizationParamMatch", () => {
      expect(guardsOrgParam(weeklyInsightRoutes, "orgId")).toBe(true);
    });

    it("guards the organization-scoped resource booking routes", () => {
      expect(guardsOrgParam(resourceBookingRoutes, "organizationId")).toBe(
        true,
      );
    });
  });

  describe("requireOrganizationParamMatch behaviour", () => {
    const runMiddleware = (req) => {
      const res = createRes();
      const next = vi.fn();
      requireOrganizationParamMatch("orgId")(req, res, next);
      return { res, next };
    };

    it("allows the caller's own organization and publishes the resolved id", () => {
      const req = createReq({ orgId: ORG_A, paramOrgId: ORG_A });
      const { res, next } = runMiddleware(req);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.authorizedOrganizationId).toBe(ORG_A);
    });

    it("rejects another organization with 403", () => {
      const req = createReq({ orgId: ORG_A, paramOrgId: ORG_B });
      const { res, next } = runMiddleware(req);

      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects a malformed organization id with 400", () => {
      const req = createReq({ orgId: ORG_A, paramOrgId: "not-an-id" });
      const { res, next } = runMiddleware(req);

      expect(res.statusCode).toBe(400);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects a caller with no organization with 403", () => {
      const req = createReq({ orgId: null, paramOrgId: ORG_A });
      const { res, next } = runMiddleware(req);

      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("weekly insight handlers", () => {
    it("getLatestInsight queries the authorized organization", async () => {
      const req = createReq();
      await getLatestInsight(req, createRes(), vi.fn());

      expect(WeeklyInsight.findOne).toHaveBeenCalledWith({
        organization: ORG_A,
      });
    });

    it("getLatestInsight ignores the raw path parameter", async () => {
      // The middleware would have rejected this request; the assertion is that
      // the handler does not reintroduce the IDOR by reading req.params.
      const req = createReq({ paramOrgId: ORG_B, authorized: ORG_A });
      await getLatestInsight(req, createRes(), vi.fn());

      expect(WeeklyInsight.findOne).toHaveBeenCalledWith({
        organization: ORG_A,
      });
      expect(WeeklyInsight.findOne).not.toHaveBeenCalledWith({
        organization: ORG_B,
      });
    });

    it("getInsightHistory scopes both the page and the count", async () => {
      const req = createReq();
      await getInsightHistory(req, createRes(), vi.fn());

      expect(WeeklyInsight.find).toHaveBeenCalledWith({ organization: ORG_A });
      expect(WeeklyInsight.countDocuments).toHaveBeenCalledWith({
        organization: ORG_A,
      });
    });

    it("getInsightHistory clamps an oversized limit", async () => {
      const req = createReq({ query: { limit: "100000" } });
      const res = createRes();
      await getInsightHistory(req, res, vi.fn());

      expect(res.body.pagination.limit).toBe(50);
    });

    it("getInsightHistory falls back to page 1 for a malformed page", async () => {
      const req = createReq({ query: { page: "abc" } });
      const res = createRes();
      await getInsightHistory(req, res, vi.fn());

      expect(res.body.currentPage).toBe(1);
    });

    it("getInsightHistory keeps the legacy response keys", async () => {
      WeeklyInsight.countDocuments.mockResolvedValue(25);
      const req = createReq();
      const res = createRes();
      await getInsightHistory(req, res, vi.fn());

      expect(res.body).toHaveProperty("insights");
      expect(res.body).toHaveProperty("totalPages", 3);
      expect(res.body).toHaveProperty("currentPage", 1);
    });

    it("triggerManualGeneration generates for the authorized organization", async () => {
      generateInsight.mockResolvedValue({ _id: "insight-1" });
      const req = createReq({
        paramOrgId: ORG_B,
        authorized: ORG_A,
        role: "admin",
      });
      const res = createRes();

      await triggerManualGeneration(req, res, vi.fn());

      expect(res.statusCode).toBe(201);
      expect(generateInsight).toHaveBeenCalledWith(
        ORG_A,
        expect.any(Date),
        expect.any(Date),
      );
    });

    it("triggerManualGeneration reports 404 when there is nothing to analyze", async () => {
      generateInsight.mockResolvedValue(null);
      const res = createRes();

      await triggerManualGeneration(createReq({ role: "admin" }), res, vi.fn());

      expect(res.statusCode).toBe(404);
    });
  });

  describe("resource booking handlers", () => {
    it("getPhysicalResources reads the authorized organization", async () => {
      const spy = vi
        .spyOn(resourceBookingService, "getPhysicalResources")
        .mockResolvedValue([]);

      await getPhysicalResources(
        createReq({ paramOrgId: ORG_B, authorized: ORG_A }),
        createRes(),
      );

      expect(spy).toHaveBeenCalledWith(ORG_A);
      spy.mockRestore();
    });

    it("createPhysicalResource writes into the authorized organization", async () => {
      const spy = vi
        .spyOn(resourceBookingService, "createPhysicalResource")
        .mockResolvedValue({ _id: "res-1" });

      await createPhysicalResource(
        createReq({
          paramOrgId: ORG_B,
          authorized: ORG_A,
          body: { name: "Boardroom", type: "room" },
        }),
        createRes(),
      );

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ organization: ORG_A, name: "Boardroom" }),
      );
      spy.mockRestore();
    });

    it("createPhysicalResource cannot be redirected by an organization field in the body", async () => {
      const spy = vi
        .spyOn(resourceBookingService, "createPhysicalResource")
        .mockResolvedValue({ _id: "res-1" });

      await createPhysicalResource(
        createReq({ body: { name: "Boardroom", organization: ORG_B } }),
        createRes(),
      );

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ organization: ORG_A }),
      );
      spy.mockRestore();
    });

    it("getAvailableResources requires a time window", async () => {
      const res = createRes();
      await getAvailableResources(createReq({ query: {} }), res);

      expect(res.statusCode).toBe(400);
    });

    it("getAvailableResources rejects an unparseable date instead of returning everything", async () => {
      const res = createRes();
      await getAvailableResources(
        createReq({ query: { startTime: "yesterday", endTime: "tomorrow" } }),
        res,
      );

      expect(res.statusCode).toBe(400);
    });

    it("getAvailableResources rejects an inverted window", async () => {
      const res = createRes();
      await getAvailableResources(
        createReq({
          query: {
            startTime: "2026-01-02T10:00:00Z",
            endTime: "2026-01-02T09:00:00Z",
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
    });

    it("createBooking passes the authorized organization to the service", async () => {
      const spy = vi
        .spyOn(resourceBookingService, "createBooking")
        .mockResolvedValue({ _id: "booking-1" });

      const res = createRes();
      await createBooking(
        createReq({
          paramOrgId: ORG_B,
          authorized: ORG_A,
          body: {
            resourceId: RESOURCE_ID,
            meetingId: MEETING_ID,
            startTime: "2026-01-02T09:00:00Z",
            endTime: "2026-01-02T10:00:00Z",
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(201);
      expect(spy).toHaveBeenCalledWith(
        RESOURCE_ID,
        MEETING_ID,
        expect.any(Date),
        expect.any(Date),
        ORG_A,
      );
      spy.mockRestore();
    });

    it("createBooking rejects a malformed resourceId with 400", async () => {
      const res = createRes();
      await createBooking(
        createReq({
          body: {
            resourceId: "nope",
            meetingId: MEETING_ID,
            startTime: "2026-01-02T09:00:00Z",
            endTime: "2026-01-02T10:00:00Z",
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
    });

    it("createBooking maps a foreign resource to 404", async () => {
      const spy = vi
        .spyOn(resourceBookingService, "createBooking")
        .mockRejectedValue(
          new Error("Resource not found in this organization."),
        );

      const res = createRes();
      await createBooking(
        createReq({
          body: {
            resourceId: RESOURCE_ID,
            meetingId: MEETING_ID,
            startTime: "2026-01-02T09:00:00Z",
            endTime: "2026-01-02T10:00:00Z",
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(404);
      spy.mockRestore();
    });

    it("cancelBooking scopes the delete to the caller's organization", async () => {
      const spy = vi
        .spyOn(resourceBookingService, "cancelBooking")
        .mockResolvedValue({ _id: BOOKING_ID });

      const res = createRes();
      await cancelBooking(
        createReq({ params: { bookingId: BOOKING_ID } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith(BOOKING_ID, expect.anything());
      const [, org] = spy.mock.calls[0];
      expect(String(org)).toBe(ORG_A);
      spy.mockRestore();
    });

    it("cancelBooking reports a booking in another organization as missing", async () => {
      const spy = vi
        .spyOn(resourceBookingService, "cancelBooking")
        .mockResolvedValue(null);

      const res = createRes();
      await cancelBooking(
        createReq({ params: { bookingId: BOOKING_ID } }),
        res,
      );

      expect(res.statusCode).toBe(404);
      spy.mockRestore();
    });

    it("cancelBooking rejects a caller with no organization", async () => {
      const res = createRes();
      await cancelBooking(
        createReq({ orgId: null, params: { bookingId: BOOKING_ID } }),
        res,
      );

      expect(res.statusCode).toBe(403);
    });

    it("getMeetingBookings scopes to the caller's organization", async () => {
      const spy = vi
        .spyOn(resourceBookingService, "getBookingsForMeeting")
        .mockResolvedValue([]);

      await getMeetingBookings(
        createReq({ params: { meetingId: MEETING_ID } }),
        createRes(),
      );

      const [meetingId, org] = spy.mock.calls[0];
      expect(meetingId).toBe(MEETING_ID);
      expect(String(org)).toBe(ORG_A);
      spy.mockRestore();
    });

    it("getMeetingBookings rejects a malformed meeting id with 400", async () => {
      const res = createRes();
      await getMeetingBookings(
        createReq({ params: { meetingId: "nope" } }),
        res,
      );

      expect(res.statusCode).toBe(400);
    });
  });

  describe("resourceBookingService tenant scoping", () => {
    it("refuses to book a resource that is not in the organization", async () => {
      PhysicalResource.findOne.mockResolvedValue(null);

      await expect(
        resourceBookingService.createBooking(
          RESOURCE_ID,
          MEETING_ID,
          new Date("2026-01-02T09:00:00Z"),
          new Date("2026-01-02T10:00:00Z"),
          ORG_A,
        ),
      ).rejects.toThrow("Resource not found in this organization.");

      expect(PhysicalResource.findOne).toHaveBeenCalledWith({
        _id: RESOURCE_ID,
        organization: ORG_A,
      });
    });

    it("still refuses a double booking of an owned resource", async () => {
      PhysicalResource.findOne.mockResolvedValue({ _id: RESOURCE_ID });
      ResourceBooking.findOne.mockResolvedValue({ _id: "conflicting" });

      await expect(
        resourceBookingService.createBooking(
          RESOURCE_ID,
          MEETING_ID,
          new Date("2026-01-02T09:00:00Z"),
          new Date("2026-01-02T10:00:00Z"),
          ORG_A,
        ),
      ).rejects.toThrow("Resource is not available during the requested time.");
    });

    it("deletes only a booking inside the given organization", async () => {
      await resourceBookingService.cancelBooking(BOOKING_ID, ORG_A);

      expect(ResourceBooking.findOneAndDelete).toHaveBeenCalledWith({
        _id: BOOKING_ID,
        organization: ORG_A,
      });
      // The regression: findByIdAndDelete ignored the tenant entirely.
      expect(ResourceBooking.findByIdAndDelete).not.toHaveBeenCalled();
    });

    it("lists only bookings inside the given organization", async () => {
      await resourceBookingService.getBookingsForMeeting(MEETING_ID, ORG_A);

      expect(ResourceBooking.find).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        organization: ORG_A,
      });
    });
  });
});
