import WeeklyInsight from "../models/weeklyInsightModel.js";
import { generateInsight } from "../services/weeklyInsightService.js";
import { parsePagination, buildPaginationMeta } from "../utils/pagination.js";

/**
 * Weekly insight handlers.
 *
 * Every query below is scoped with `req.authorizedOrganizationId`, which
 * `requireOrganizationParamMatch` sets after confirming the `:orgId` in the
 * path is the caller's own organization (Issue #2571). Reading `req.params.orgId`
 * here would reintroduce the IDOR — the middleware's guarantee only holds if
 * the handler uses the value the middleware produced.
 */

/** The organization the middleware authorized, never the raw path parameter. */
const scopeOf = (req) => req.authorizedOrganizationId;

export const getLatestInsight = async (req, res, next) => {
  try {
    const insight = await WeeklyInsight.findOne({ organization: scopeOf(req) })
      .sort({ createdAt: -1 })
      .populate("stalledActionItems.actionItem")
      .populate("stalledActionItems.meetingId");

    if (!insight) {
      return res.status(200).json(null); // No insight yet
    }

    res.status(200).json(insight);
  } catch (error) {
    next(error);
  }
};

export const getInsightHistory = async (req, res, next) => {
  try {
    const organization = scopeOf(req);

    // `parseInt(req.query.limit, 10) || 10` had no ceiling and no floor, so
    // `?limit=1000000` streamed the whole history and `?page=0` produced a
    // negative skip that MongoDB rejects.
    const { page, limit, skip } = parsePagination(req.query, {
      defaultLimit: 10,
      maxLimit: 50,
    });

    const [insights, total] = await Promise.all([
      WeeklyInsight.find({ organization })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      WeeklyInsight.countDocuments({ organization }),
    ]);

    const meta = buildPaginationMeta({ total, page, limit });

    res.status(200).json({
      insights,
      pagination: meta,
      // Retained so existing clients reading these keys keep working.
      totalPages: meta.totalPages,
      currentPage: meta.page,
    });
  } catch (error) {
    next(error);
  }
};

export const triggerManualGeneration = async (req, res, next) => {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    const insight = await generateInsight(scopeOf(req), startDate, endDate);
    if (!insight) {
      return res
        .status(404)
        .json({ message: "No meetings found in the past 7 days to analyze." });
    }

    res.status(201).json(insight);
  } catch (error) {
    next(error);
  }
};
