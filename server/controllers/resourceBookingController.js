import mongoose from "mongoose";
import resourceBookingService from "../services/resourceBookingService.js";

/**
 * Physical resource / booking handlers.
 *
 * Before Issue #2571 not one handler in this file referenced
 * `req.user.organization` — each read `req.params.organizationId` and passed it
 * straight to the service. The organization-scoped routes now sit behind
 * `requireOrganizationParamMatch`, so they read `req.authorizedOrganizationId`;
 * the two routes keyed by a booking or meeting id cannot be guarded that way
 * and resolve the caller's organization here instead.
 */

/** The organization the middleware authorized, never the raw path parameter. */
const scopeOf = (req) => req.authorizedOrganizationId;

const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id));

/**
 * Resolves the caller's organization for routes with no `:organizationId` to
 * match against, responding 403 when there is none.
 *
 * Handles both shapes `userAuth` can leave behind: a raw `ObjectId` and a
 * populated `Organization` document.
 */
const callerOrganization = (req, res) => {
  const raw = req.user?.organization;
  const organization = raw?._id ?? raw;

  if (!organization) {
    res.status(403).json({ message: "Organization membership is required" });
    return null;
  }

  return organization;
};

// Fetch physical resources for an organization
export const getPhysicalResources = async (req, res) => {
  try {
    const resources = await resourceBookingService.getPhysicalResources(
      scopeOf(req),
    );
    res.status(200).json(resources);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch physical resources",
      error: error.message,
    });
  }
};

// Create a physical resource
export const createPhysicalResource = async (req, res) => {
  try {
    // `organization` is applied last so a body field of the same name cannot
    // redirect the write to another tenant.
    const data = { ...req.body, organization: scopeOf(req) };
    const resource = await resourceBookingService.createPhysicalResource(data);
    res.status(201).json(resource);
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({
      message: "Failed to create physical resource",
      error: error.message,
    });
  }
};

// Get available resources for a specific time window
export const getAvailableResources = async (req, res) => {
  try {
    const { startTime, endTime, type } = req.query;

    if (!startTime || !endTime) {
      return res.status(400).json({
        message: "startTime and endTime are required query parameters",
      });
    }

    const start = new Date(startTime);
    const end = new Date(endTime);

    // An unparseable date produced an `Invalid Date`, which compares false
    // against everything and quietly returned every resource as "available".
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res
        .status(400)
        .json({ message: "startTime and endTime must be valid dates" });
    }
    if (start >= end) {
      return res
        .status(400)
        .json({ message: "startTime must be before endTime" });
    }

    const availableResources =
      await resourceBookingService.getAvailableResources(
        scopeOf(req),
        start,
        end,
        type,
      );
    res.status(200).json(availableResources);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch available resources",
      error: error.message,
    });
  }
};

// Create a resource booking
export const createBooking = async (req, res) => {
  try {
    const organizationId = scopeOf(req);
    const { resourceId, meetingId, startTime, endTime } = req.body || {};

    if (!isValidId(resourceId)) {
      return res
        .status(400)
        .json({ message: "A valid resourceId is required" });
    }
    if (!isValidId(meetingId)) {
      return res.status(400).json({ message: "A valid meetingId is required" });
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res
        .status(400)
        .json({ message: "startTime and endTime must be valid dates" });
    }
    if (start >= end) {
      return res
        .status(400)
        .json({ message: "startTime must be before endTime" });
    }

    const booking = await resourceBookingService.createBooking(
      resourceId,
      meetingId,
      start,
      end,
      organizationId,
    );
    res.status(201).json(booking);
  } catch (error) {
    if (
      error.message === "Resource is not available during the requested time."
    ) {
      return res.status(409).json({ message: error.message });
    }
    // The service refuses to book a resource that belongs to another tenant.
    if (error.message === "Resource not found in this organization.") {
      return res.status(404).json({ message: error.message });
    }
    res
      .status(500)
      .json({ message: "Failed to create booking", error: error.message });
  }
};

// Cancel a resource booking
export const cancelBooking = async (req, res) => {
  try {
    const organization = callerOrganization(req, res);
    if (!organization) return;

    const { bookingId } = req.params;
    if (!isValidId(bookingId)) {
      return res.status(400).json({ message: "Invalid booking id" });
    }

    // Scoped delete: a booking in another organization does not match, so it
    // is reported as missing rather than cancelled.
    const cancelled = await resourceBookingService.cancelBooking(
      bookingId,
      organization,
    );

    if (!cancelled) {
      return res.status(404).json({ message: "Booking not found" });
    }

    res.status(200).json({ message: "Booking cancelled successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to cancel booking", error: error.message });
  }
};

// Get bookings for a specific meeting
export const getMeetingBookings = async (req, res) => {
  try {
    const organization = callerOrganization(req, res);
    if (!organization) return;

    const { meetingId } = req.params;
    if (!isValidId(meetingId)) {
      return res.status(400).json({ message: "Invalid meeting id" });
    }

    const bookings = await resourceBookingService.getBookingsForMeeting(
      meetingId,
      organization,
    );
    res.status(200).json(bookings);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch meeting bookings",
      error: error.message,
    });
  }
};
