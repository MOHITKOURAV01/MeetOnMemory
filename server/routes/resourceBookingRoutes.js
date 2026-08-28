import express from "express";
import {
  getPhysicalResources,
  createPhysicalResource,
  getAvailableResources,
  createBooking,
  cancelBooking,
  getMeetingBookings,
} from "../controllers/resourceBookingController.js";
import protect from "../middleware/userAuth.js";
import { requireOrganizationParamMatch } from "../middleware/rbac.js";

const router = express.Router();

router.use(protect);

// `protect` alone authenticated the caller and then let the handler query with
// whatever `:organizationId` was in the URL (Issue #2571) — enough to list, and
// to *create*, physical resources inside any organization.
router.use(
  "/organization/:organizationId",
  requireOrganizationParamMatch("organizationId"),
);

router.get("/organization/:organizationId", getPhysicalResources);
router.post("/organization/:organizationId", createPhysicalResource);
router.get("/organization/:organizationId/available", getAvailableResources);
router.post("/organization/:organizationId/bookings", createBooking);

// These two take a booking / meeting id rather than an organization id, so the
// path parameter cannot be matched against membership. They are scoped inside
// the controller against the caller's own organization instead.
router.delete("/bookings/:bookingId", cancelBooking);
router.get("/meetings/:meetingId/bookings", getMeetingBookings);

export default router;
