/**
 * Server-side tenant resolution (Issue #2570).
 *
 * `customRoleController` resolved the caller's organization like this:
 *
 *   const organizationId =
 *     req.user?.organizationId || req.headers["x-organization-id"];
 *
 * Both halves of that expression are wrong, and they are wrong in a way that
 * compounds.
 *
 * The left half never produces a value. `userAuth` assigns `req.user = user`,
 * and the `User` schema's field is `organization` — there is no
 * `organizationId` on the document. So the `||` *always* falls through.
 *
 * The right half is a request header. Headers are chosen by the client. The
 * net effect was that the tenant every Custom Role / Resource ACL query ran
 * against was whatever the caller asked for, with no membership check at all.
 *
 * The fix is not "read the correct field" — it is to stop offering a
 * client-controlled fallback. This module resolves the organization from the
 * authenticated session and from nowhere else, and it distinguishes "no
 * organization" from "organization is undefined", because Mongoose silently
 * strips an `undefined` value out of a filter and turns a scoped query into an
 * unscoped one.
 */

import mongoose from "mongoose";

/**
 * Extracts the organization id from an authenticated request.
 *
 * Handles both shapes `userAuth` can leave behind: a raw `ObjectId` and a
 * populated `Organization` document.
 *
 * @param {object} req  an Express request that has passed `userAuth`
 * @returns {string|null} the organization id as a string, or `null` when the
 *   caller has no organization
 */
export const resolveOrganizationId = (req) => {
  const organization = req?.user?.organization;
  if (!organization) return null;

  const raw = organization._id ?? organization;
  if (!raw) return null;

  const asString = String(raw);
  return mongoose.Types.ObjectId.isValid(asString) ? asString : null;
};

/**
 * Resolves the caller's organization or writes the appropriate error response.
 *
 * Returns `null` when it has already responded, so handlers read as:
 *
 *   const organizationId = requireOrganizationId(req, res);
 *   if (!organizationId) return;
 *
 * A missing organization is a 403, not a 400: the request is well-formed, the
 * caller simply is not a member of anything. The previous code returned 400
 * with "Organization context is required", which invited clients to "fix" it
 * by supplying the header.
 *
 * @param {object} req
 * @param {object} res
 * @returns {string|null}
 */
export const requireOrganizationId = (req, res) => {
  const organizationId = resolveOrganizationId(req);

  if (!organizationId) {
    res.status(403).json({
      success: false,
      error: "Organization membership is required for this resource",
    });
    return null;
  }

  return organizationId;
};

/**
 * Guard for values that are about to be used as a query filter.
 *
 * `ResourceAcl.findOne({ organizationId: undefined, ... })` does not match
 * nothing — Mongoose removes the key, so it matches ACL rows in *every*
 * tenant. Any code path that builds a scoped filter has to prove the scope
 * exists first; this makes that check a single call instead of an assumption.
 *
 * @param {*} value
 * @returns {boolean}
 */
export const isUsableScope = (value) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  mongoose.Types.ObjectId.isValid(String(value));
