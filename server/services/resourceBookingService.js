import PhysicalResource from "../models/physicalResourceModel.js";
import ResourceBooking from "../models/resourceBookingModel.js";

/**
 * Physical resource booking service.
 *
 * Tenant scoping note (Issue #2571): the methods that take an id — a booking,
 * a meeting, a resource — now also take the organization it must belong to and
 * put it in the query. Checking ownership after the fact leaks existence; a
 * filter that does not match simply returns nothing.
 */
class ResourceBookingService {
  /**
   * Check if a resource is available for a given time window.
   */
  async checkAvailability(
    resourceId,
    startTime,
    endTime,
    excludeBookingId = null,
  ) {
    const query = {
      resourceId,
      $or: [
        { startTime: { $lt: endTime, $gte: startTime } },
        { endTime: { $gt: startTime, $lte: endTime } },
        { startTime: { $lte: startTime }, endTime: { $gte: endTime } },
      ],
    };

    if (excludeBookingId) {
      query._id = { $ne: excludeBookingId };
    }

    const conflictingBooking = await ResourceBooking.findOne(query);
    return !conflictingBooking;
  }

  /**
   * Get all available resources of a specific type in an organization during a time window.
   */
  async getAvailableResources(organizationId, startTime, endTime, type = null) {
    const resourceQuery = { organization: organizationId };
    if (type) {
      resourceQuery.type = type;
    }

    const resources = await PhysicalResource.find(resourceQuery);
    const availableResources = [];

    for (const resource of resources) {
      const isAvailable = await this.checkAvailability(
        resource._id,
        startTime,
        endTime,
      );
      if (isAvailable) {
        availableResources.push(resource);
      }
    }

    return availableResources;
  }

  /**
   * Create a new resource booking.
   *
   * The resource is looked up *within* `organizationId` first. Without that,
   * a caller could book another organization's room by passing its id — the
   * booking would be written into their own tenant, but the room it reserves
   * belongs to someone else.
   *
   * @throws {Error} "Resource not found in this organization." — no such
   *   resource in this tenant.
   * @throws {Error} "Resource is not available during the requested time."
   */
  async createBooking(
    resourceId,
    meetingId,
    startTime,
    endTime,
    organizationId,
  ) {
    const resource = await PhysicalResource.findOne({
      _id: resourceId,
      organization: organizationId,
    });

    if (!resource) {
      throw new Error("Resource not found in this organization.");
    }

    const isAvailable = await this.checkAvailability(
      resourceId,
      startTime,
      endTime,
    );
    if (!isAvailable) {
      throw new Error("Resource is not available during the requested time.");
    }

    const booking = new ResourceBooking({
      resourceId,
      meetingId,
      startTime,
      endTime,
      organization: organizationId,
    });

    return await booking.save();
  }

  /**
   * Cancel (delete) a booking belonging to `organizationId`.
   *
   * @returns {Promise<object|null>} the deleted booking, or `null` when there
   *   is no such booking in this organization.
   */
  async cancelBooking(bookingId, organizationId) {
    return await ResourceBooking.findOneAndDelete({
      _id: bookingId,
      organization: organizationId,
    });
  }

  /**
   * Get bookings for a specific meeting within an organization.
   */
  async getBookingsForMeeting(meetingId, organizationId) {
    return await ResourceBooking.find({
      meetingId,
      organization: organizationId,
    }).populate("resourceId");
  }

  /**
   * Get all physical resources for an organization.
   */
  async getPhysicalResources(organizationId) {
    return await PhysicalResource.find({ organization: organizationId });
  }

  /**
   * Create a physical resource.
   */
  async createPhysicalResource(data) {
    const resource = new PhysicalResource(data);
    return await resource.save();
  }
}

export default new ResourceBookingService();
