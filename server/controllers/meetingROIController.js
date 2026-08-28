import MeetingROI from "../models/meetingROIModel.js";
import { parsePagination, buildPaginationMeta } from "../utils/pagination.js";

/**
 * Helper to calculate cost and ROI fields for payload/instance
 */
export const calculateROIFactors = (data) => {
  const durationHours = (Number(data.durationMinutes) || 60) / 60;
  const attendees = Number(data.attendeeCount) || 1;
  const hourly = Number(data.avgHourlyRate) || 0;
  const laborCost = Math.round(durationHours * attendees * hourly * 100) / 100;

  const direct = data.directCosts || {};
  const totalDirectCost =
    (Number(direct.venue) || 0) +
    (Number(direct.softwareLicenses) || 0) +
    (Number(direct.refreshments) || 0) +
    (Number(direct.materialsAndEquipment) || 0) +
    (Number(direct.externalConsultants) || 0) +
    (Number(direct.other) || 0);

  const totalMeetingCost =
    Math.round((laborCost + totalDirectCost) * 100) / 100;

  let decisionValue = Number(data.decisionValue) || 0;
  if (Array.isArray(data.decisionDetails) && data.decisionDetails.length > 0) {
    const sumDetails = data.decisionDetails.reduce(
      (acc, item) => acc + (Number(item.estimatedValue) || 0),
      0,
    );
    if (decisionValue === 0) {
      decisionValue = sumDetails;
    }
  }

  const netValue = Math.round((decisionValue - totalMeetingCost) * 100) / 100;
  let roiPercentage = 0;
  if (totalMeetingCost > 0) {
    roiPercentage =
      Math.round(
        ((decisionValue - totalMeetingCost) / totalMeetingCost) * 100 * 10,
      ) / 10;
  } else if (decisionValue > 0) {
    roiPercentage = 100;
  }

  return {
    laborCost,
    totalDirectCost,
    totalMeetingCost,
    decisionValue,
    netValue,
    roiPercentage,
  };
};

/**
 * GET /api/meeting-roi/records
 * List meeting ROI records with searching, filtering, sorting, and pagination
 */
export const getROIRecords = async (req, res) => {
  try {
    const organizationId =
      req.user?.organization?._id ||
      req.user?.organization ||
      req.query.organizationId;

    if (!organizationId) {
      return res.status(400).json({
        success: false,
        message: "Organization ID is required",
      });
    }

    const {
      search,
      meetingType,
      minROI,
      maxROI,
      startDate,
      endDate,
      sortBy = "date",
      sortOrder = "desc",
    } = req.query;

    const query = { organization: organizationId };

    if (search && search.trim()) {
      query.title = { $regex: search.trim(), $options: "i" };
    }

    if (meetingType && meetingType !== "all") {
      query.meetingType = meetingType;
    }

    if (minROI !== undefined && minROI !== "") {
      query.roiPercentage = { ...query.roiPercentage, $gte: Number(minROI) };
    }

    if (maxROI !== undefined && maxROI !== "") {
      query.roiPercentage = { ...query.roiPercentage, $lte: Number(maxROI) };
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    // Same shape as getNotes: `Math.max(1, ...)` guarded `skip` but not
    // `.limit()`, so `?limit=0` returned the whole collection (Issue #2573).
    const { page, limit, skip } = parsePagination(req.query, {
      defaultLimit: 20,
      maxLimit: 100,
    });
    const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    const [records, total] = await Promise.all([
      MeetingROI.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate("meeting", "title date meetingType")
        .lean(),
      MeetingROI.countDocuments(query),
    ]);

    const meta = buildPaginationMeta({ total, page, limit });

    return res.status(200).json({
      success: true,
      data: {
        records,
        pagination: {
          ...meta,
          // Retained so existing clients reading `pages` keep working.
          pages: meta.totalPages || 1,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching ROI records:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch ROI records",
      error: error.message,
    });
  }
};

/**
 * GET /api/meeting-roi/records/:id
 */
export const getROIRecordById = async (req, res) => {
  try {
    const { id } = req.params;
    const organizationId =
      req.user?.organization?._id || req.user?.organization;

    const record = await MeetingROI.findById(id)
      .populate("meeting", "title date meetingType duration")
      .lean();

    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Meeting ROI record not found",
      });
    }

    if (
      organizationId &&
      record.organization &&
      record.organization.toString() !== organizationId.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Access denied to this organization's record",
      });
    }

    return res.status(200).json({
      success: true,
      data: record,
    });
  } catch (error) {
    console.error("Error fetching ROI record by id:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch ROI record",
      error: error.message,
    });
  }
};

/**
 * GET /api/meeting-roi/meeting/:meetingId
 */
export const getROIRecordByMeeting = async (req, res) => {
  try {
    const { meetingId } = req.params;
    const record = await MeetingROI.findOne({ meeting: meetingId }).lean();

    return res.status(200).json({
      success: true,
      data: record || null,
    });
  } catch (error) {
    console.error("Error fetching ROI record by meeting:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch ROI record for meeting",
      error: error.message,
    });
  }
};

/**
 * POST /api/meeting-roi/records
 * Create a new meeting ROI record
 */
export const createROIRecord = async (req, res) => {
  try {
    const organizationId =
      req.user?.organization?._id ||
      req.user?.organization ||
      req.body.organization;

    if (!organizationId) {
      return res.status(400).json({
        success: false,
        message: "Organization ID is required",
      });
    }

    const {
      meeting = null,
      title,
      meetingType = "strategy",
      date = new Date(),
      durationMinutes = 60,
      attendeeCount = 4,
      avgHourlyRate = 65,
      directCosts = {},
      decisionValue = 0,
      decisionDetails = [],
      qualityMetrics = {},
      notes = "",
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: "Title is required",
      });
    }

    const calculated = calculateROIFactors({
      durationMinutes,
      attendeeCount,
      avgHourlyRate,
      directCosts,
      decisionValue,
      decisionDetails,
    });

    const newRecord = new MeetingROI({
      organization: organizationId,
      meeting: meeting || null,
      title: title.trim(),
      meetingType,
      date: new Date(date),
      durationMinutes: Number(durationMinutes) || 60,
      attendeeCount: Number(attendeeCount) || 1,
      avgHourlyRate: Number(avgHourlyRate) || 0,
      laborCost: calculated.laborCost,
      directCosts,
      totalDirectCost: calculated.totalDirectCost,
      totalMeetingCost: calculated.totalMeetingCost,
      decisionValue: calculated.decisionValue,
      decisionDetails,
      netValue: calculated.netValue,
      roiPercentage: calculated.roiPercentage,
      qualityMetrics: {
        efficiencyRating: qualityMetrics.efficiencyRating ?? 4,
        goalAchievementRate: qualityMetrics.goalAchievementRate ?? 85,
        attendeeEngagementScore: qualityMetrics.attendeeEngagementScore ?? 80,
        decisionSpeedMinutes: qualityMetrics.decisionSpeedMinutes ?? 20,
        actionItemsCount: qualityMetrics.actionItemsCount ?? 3,
        actionItemsCompletedCount:
          qualityMetrics.actionItemsCompletedCount ?? 2,
      },
      notes,
      createdBy: req.user?.id || req.user?._id || null,
    });

    await newRecord.save();

    return res.status(201).json({
      success: true,
      message: "Meeting ROI record created successfully",
      data: newRecord,
    });
  } catch (error) {
    console.error("Error creating ROI record:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create ROI record",
      error: error.message,
    });
  }
};

/**
 * PUT /api/meeting-roi/records/:id
 */
export const updateROIRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const organizationId =
      req.user?.organization?._id || req.user?.organization;

    const record = await MeetingROI.findById(id);
    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Meeting ROI record not found",
      });
    }

    if (
      organizationId &&
      record.organization &&
      record.organization.toString() !== organizationId.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    const {
      title,
      meetingType,
      date,
      durationMinutes,
      attendeeCount,
      avgHourlyRate,
      directCosts,
      decisionValue,
      decisionDetails,
      qualityMetrics,
      notes,
    } = req.body;

    if (title !== undefined) record.title = title.trim();
    if (meetingType !== undefined) record.meetingType = meetingType;
    if (date !== undefined) record.date = new Date(date);
    if (durationMinutes !== undefined)
      record.durationMinutes = Number(durationMinutes);
    if (attendeeCount !== undefined)
      record.attendeeCount = Number(attendeeCount);
    if (avgHourlyRate !== undefined)
      record.avgHourlyRate = Number(avgHourlyRate);
    if (directCosts !== undefined) record.directCosts = directCosts;
    if (decisionValue !== undefined)
      record.decisionValue = Number(decisionValue);
    if (decisionDetails !== undefined) record.decisionDetails = decisionDetails;
    if (qualityMetrics !== undefined) {
      record.qualityMetrics = {
        ...record.qualityMetrics.toObject(),
        ...qualityMetrics,
      };
    }
    if (notes !== undefined) record.notes = notes;

    const calculated = calculateROIFactors({
      durationMinutes: record.durationMinutes,
      attendeeCount: record.attendeeCount,
      avgHourlyRate: record.avgHourlyRate,
      directCosts: record.directCosts,
      decisionValue: record.decisionValue,
      decisionDetails: record.decisionDetails,
    });

    record.laborCost = calculated.laborCost;
    record.totalDirectCost = calculated.totalDirectCost;
    record.totalMeetingCost = calculated.totalMeetingCost;
    record.decisionValue = calculated.decisionValue;
    record.netValue = calculated.netValue;
    record.roiPercentage = calculated.roiPercentage;

    await record.save();

    return res.status(200).json({
      success: true,
      message: "Meeting ROI record updated successfully",
      data: record,
    });
  } catch (error) {
    console.error("Error updating ROI record:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update ROI record",
      error: error.message,
    });
  }
};

/**
 * DELETE /api/meeting-roi/records/:id
 */
export const deleteROIRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const organizationId =
      req.user?.organization?._id || req.user?.organization;

    const record = await MeetingROI.findById(id);
    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Meeting ROI record not found",
      });
    }

    if (
      organizationId &&
      record.organization &&
      record.organization.toString() !== organizationId.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    await MeetingROI.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Meeting ROI record deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting ROI record:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete ROI record",
      error: error.message,
    });
  }
};

/**
 * GET /api/meeting-roi/analytics/summary
 * Aggregated analytics for the ROI Dashboard
 */
export const getROIDashboardSummary = async (req, res) => {
  try {
    const organizationId =
      req.user?.organization?._id ||
      req.user?.organization ||
      req.query.organizationId;

    if (!organizationId) {
      return res.status(400).json({
        success: false,
        message: "Organization ID is required",
      });
    }

    const { timeframe = "all", startDate, endDate } = req.query;
    const query = { organization: organizationId };

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    } else if (timeframe === "30d") {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      query.date = { $gte: d };
    } else if (timeframe === "90d") {
      const d = new Date();
      d.setDate(d.getDate() - 90);
      query.date = { $gte: d };
    } else if (timeframe === "1y") {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 1);
      query.date = { $gte: d };
    }

    const records = await MeetingROI.find(query).sort({ date: -1 }).lean();

    if (records.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          summary: {
            totalMeetings: 0,
            totalCost: 0,
            totalLaborCost: 0,
            totalDirectCost: 0,
            totalDecisionValue: 0,
            netValue: 0,
            averageROI: 0,
            positiveROICount: 0,
            positiveROIPercentage: 0,
            averageQualityScore: 0,
          },
          roiByType: [],
          monthlyTrends: [],
          costBreakdown: {
            laborCost: 0,
            directCosts: {
              venue: 0,
              softwareLicenses: 0,
              refreshments: 0,
              materialsAndEquipment: 0,
              externalConsultants: 0,
              other: 0,
            },
            totalCost: 0,
            laborPercentage: 0,
            directPercentage: 0,
          },
          qualityMetrics: {
            avgEfficiencyRating: 0,
            avgGoalAchievementRate: 0,
            avgEngagementScore: 0,
            avgDecisionSpeedMinutes: 0,
            totalActionItems: 0,
            completedActionItems: 0,
            completionRate: 0,
          },
          topPerformers: [],
          lowestPerformers: [],
          benchmarks: {
            industryAverageROI: 145,
            industryAvgCostPerAttendeeHour: 68,
            industryDecisionRealizationRate: 74,
            industryQualityScore: 4.1,
          },
          recommendations: [
            {
              id: "rec-init",
              type: "info",
              title: "Start Tracking Meeting ROI",
              description:
                "Log your meeting costs and outcome decision values to unlock automated ROI insights and efficiency optimization.",
              potentialSavings: "$0",
            },
          ],
        },
      });
    }

    let totalCost = 0;
    let totalLaborCost = 0;
    let totalDirectCost = 0;
    let totalDecisionValue = 0;
    let totalROI = 0;
    let positiveROICount = 0;

    let directBreakdown = {
      venue: 0,
      softwareLicenses: 0,
      refreshments: 0,
      materialsAndEquipment: 0,
      externalConsultants: 0,
      other: 0,
    };

    let totalEfficiency = 0;
    let totalGoalAchievement = 0;
    let totalEngagement = 0;
    let totalDecisionSpeed = 0;
    let totalActionItems = 0;
    let totalCompletedActions = 0;

    const byTypeMap = {};
    const monthlyMap = {};

    records.forEach((rec) => {
      totalCost += rec.totalMeetingCost || 0;
      totalLaborCost += rec.laborCost || 0;
      totalDirectCost += rec.totalDirectCost || 0;
      totalDecisionValue += rec.decisionValue || 0;
      totalROI += rec.roiPercentage || 0;
      if ((rec.roiPercentage || 0) > 0) positiveROICount += 1;

      const direct = rec.directCosts || {};
      directBreakdown.venue += direct.venue || 0;
      directBreakdown.softwareLicenses += direct.softwareLicenses || 0;
      directBreakdown.refreshments += direct.refreshments || 0;
      directBreakdown.materialsAndEquipment +=
        direct.materialsAndEquipment || 0;
      directBreakdown.externalConsultants += direct.externalConsultants || 0;
      directBreakdown.other += direct.other || 0;

      const q = rec.qualityMetrics || {};
      totalEfficiency += q.efficiencyRating || 4;
      totalGoalAchievement += q.goalAchievementRate || 80;
      totalEngagement += q.attendeeEngagementScore || 80;
      totalDecisionSpeed += q.decisionSpeedMinutes || 20;
      totalActionItems += q.actionItemsCount || 0;
      totalCompletedActions += q.actionItemsCompletedCount || 0;

      // By type
      const type = rec.meetingType || "other";
      if (!byTypeMap[type]) {
        byTypeMap[type] = {
          type,
          count: 0,
          totalCost: 0,
          decisionValue: 0,
          netValue: 0,
          totalROI: 0,
          totalQuality: 0,
        };
      }
      byTypeMap[type].count += 1;
      byTypeMap[type].totalCost += rec.totalMeetingCost || 0;
      byTypeMap[type].decisionValue += rec.decisionValue || 0;
      byTypeMap[type].netValue += rec.netValue || 0;
      byTypeMap[type].totalROI += rec.roiPercentage || 0;
      byTypeMap[type].totalQuality += q.efficiencyRating || 4;

      // Monthly
      const d = new Date(rec.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[key]) {
        monthlyMap[key] = {
          monthKey: key,
          label: d.toLocaleDateString("en-US", {
            month: "short",
            year: "numeric",
          }),
          meetingCount: 0,
          totalCost: 0,
          decisionValue: 0,
          netValue: 0,
          totalROI: 0,
        };
      }
      monthlyMap[key].meetingCount += 1;
      monthlyMap[key].totalCost += rec.totalMeetingCost || 0;
      monthlyMap[key].decisionValue += rec.decisionValue || 0;
      monthlyMap[key].netValue += rec.netValue || 0;
      monthlyMap[key].totalROI += rec.roiPercentage || 0;
    });

    const count = records.length;
    const netValue = Math.round((totalDecisionValue - totalCost) * 100) / 100;
    const averageROI = Math.round((totalROI / count) * 10) / 10;
    const positiveROIPercentage = Math.round((positiveROICount / count) * 100);
    const averageQualityScore = Math.round((totalEfficiency / count) * 10) / 10;

    const roiByType = Object.values(byTypeMap).map((item) => ({
      type: item.type,
      meetingCount: item.count,
      totalCost: Math.round(item.totalCost * 100) / 100,
      decisionValue: Math.round(item.decisionValue * 100) / 100,
      netValue: Math.round(item.netValue * 100) / 100,
      avgROI: Math.round((item.totalROI / item.count) * 10) / 10,
      avgQuality: Math.round((item.totalQuality / item.count) * 10) / 10,
    }));

    const monthlyTrends = Object.keys(monthlyMap)
      .sort()
      .map((key) => {
        const item = monthlyMap[key];
        return {
          monthKey: item.monthKey,
          label: item.label,
          meetingCount: item.meetingCount,
          totalCost: Math.round(item.totalCost * 100) / 100,
          decisionValue: Math.round(item.decisionValue * 100) / 100,
          netValue: Math.round(item.netValue * 100) / 100,
          avgROI: Math.round((item.totalROI / item.meetingCount) * 10) / 10,
        };
      });

    const laborPercentage =
      totalCost > 0 ? Math.round((totalLaborCost / totalCost) * 100) : 100;
    const directPercentage =
      totalCost > 0 ? Math.round((totalDirectCost / totalCost) * 100) : 0;

    const sortedByROI = [...records].sort(
      (a, b) => (b.roiPercentage || 0) - (a.roiPercentage || 0),
    );
    const topPerformers = sortedByROI.slice(0, 5);
    const lowestPerformers = sortedByROI.slice(-5).reverse();

    // Dynamic Recommendations
    const recommendations = [];

    const negativeROIMeetings = records.filter(
      (r) => (r.roiPercentage || 0) < 0,
    );
    if (negativeROIMeetings.length > 0) {
      const wastedCost = negativeROIMeetings.reduce(
        (sum, r) => sum + Math.abs(r.netValue || 0),
        0,
      );
      recommendations.push({
        id: "rec-neg-roi",
        type: "warning",
        title: "Mitigate Low Decision Value in Recurring Sessions",
        description: `Identified ${negativeROIMeetings.length} meeting(s) with negative ROI. Shift status-updates to asynchronous digests or define concrete decision outcomes prior to the meeting.`,
        potentialSavings: `$${Math.round(wastedCost).toLocaleString()}`,
      });
    }

    const highAttendeeMeetings = records.filter(
      (r) => (r.attendeeCount || 0) > 6 && (r.roiPercentage || 0) < 50,
    );
    if (highAttendeeMeetings.length > 0) {
      recommendations.push({
        id: "rec-attendee-cap",
        type: "tip",
        title: "Trim Attendee Lists for Lower-Yield Meetings",
        description:
          "Meetings with over 6 attendees show lower ROI density. Applying the 'two-pizza team' rule and sharing recordings can trim 20-30% of labor overhead.",
        potentialSavings: `$${Math.round(totalLaborCost * 0.2).toLocaleString()}`,
      });
    }

    const longDurationMeetings = records.filter(
      (r) => (r.durationMinutes || 0) >= 60,
    );
    if (longDurationMeetings.length > 0) {
      recommendations.push({
        id: "rec-duration-trim",
        type: "opportunity",
        title: "Default to 45-Minute Focus Blocks",
        description:
          "Shortening 60-minute calendar blocks to 45 minutes preserves decision efficiency while returning valuable focus hours to engineering and leadership.",
        potentialSavings: `$${Math.round(totalLaborCost * 0.25).toLocaleString()}`,
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        id: "rec-healthy",
        type: "success",
        title: "Strong Meeting Efficiency",
        description:
          "Your organization's meeting ROI metrics outperform standard benchmarks. Continue tracking decision value realization to maintain high leverage.",
        potentialSavings: "$0",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          totalMeetings: count,
          totalCost: Math.round(totalCost * 100) / 100,
          totalLaborCost: Math.round(totalLaborCost * 100) / 100,
          totalDirectCost: Math.round(totalDirectCost * 100) / 100,
          totalDecisionValue: Math.round(totalDecisionValue * 100) / 100,
          netValue,
          averageROI,
          positiveROICount,
          positiveROIPercentage,
          averageQualityScore,
        },
        roiByType,
        monthlyTrends,
        costBreakdown: {
          laborCost: Math.round(totalLaborCost * 100) / 100,
          directCosts: directBreakdown,
          totalCost: Math.round(totalCost * 100) / 100,
          laborPercentage,
          directPercentage,
        },
        qualityMetrics: {
          avgEfficiencyRating: Math.round((totalEfficiency / count) * 10) / 10,
          avgGoalAchievementRate:
            Math.round((totalGoalAchievement / count) * 10) / 10,
          avgEngagementScore: Math.round((totalEngagement / count) * 10) / 10,
          avgDecisionSpeedMinutes:
            Math.round((totalDecisionSpeed / count) * 10) / 10,
          totalActionItems,
          completedActionItems: totalCompletedActions,
          completionRate:
            totalActionItems > 0
              ? Math.round((totalCompletedActions / totalActionItems) * 100)
              : 100,
        },
        topPerformers,
        lowestPerformers,
        benchmarks: {
          industryAverageROI: 145,
          industryAvgCostPerAttendeeHour: 68,
          industryDecisionRealizationRate: 74,
          industryQualityScore: 4.1,
        },
        recommendations,
      },
    });
  } catch (error) {
    console.error("Error generating ROI dashboard summary:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate ROI dashboard summary",
      error: error.message,
    });
  }
};

/**
 * POST /api/meeting-roi/simulate
 * What-If scenario calculation for prospective or optimized meeting parameters
 */
export const simulateWhatIf = async (req, res) => {
  try {
    const {
      attendeeCount = 4,
      durationMinutes = 60,
      avgHourlyRate = 65,
      directCost = 0,
      estimatedDecisionValue = 1000,
      frequencyPerMonth = 4,
    } = req.body;

    const singleCost = calculateROIFactors({
      durationMinutes: Number(durationMinutes) || 60,
      attendeeCount: Number(attendeeCount) || 1,
      avgHourlyRate: Number(avgHourlyRate) || 0,
      directCosts: { other: Number(directCost) || 0 },
      decisionValue: Number(estimatedDecisionValue) || 0,
    });

    const freq = Math.max(1, Number(frequencyPerMonth) || 1);
    const monthlyCost =
      Math.round(singleCost.totalMeetingCost * freq * 100) / 100;
    const monthlyDecisionValue =
      Math.round((Number(estimatedDecisionValue) || 0) * freq * 100) / 100;
    const monthlyNetValue =
      Math.round((monthlyDecisionValue - monthlyCost) * 100) / 100;

    let monthlyROI = 0;
    if (monthlyCost > 0) {
      monthlyROI =
        Math.round(
          ((monthlyDecisionValue - monthlyCost) / monthlyCost) * 100 * 10,
        ) / 10;
    } else if (monthlyDecisionValue > 0) {
      monthlyROI = 100;
    }

    // Compare with baseline 60min, 6 attendees
    const baselineCostSingle =
      (60 / 60) * 6 * (Number(avgHourlyRate) || 65) + (Number(directCost) || 0);
    const baselineMonthlyCost = baselineCostSingle * freq;
    const costSavingsVsBaseline =
      Math.round(Math.max(0, baselineMonthlyCost - monthlyCost) * 100) / 100;

    return res.status(200).json({
      success: true,
      data: {
        singleMeeting: {
          laborCost: singleCost.laborCost,
          directCost: singleCost.totalDirectCost,
          totalCost: singleCost.totalMeetingCost,
          decisionValue: singleCost.decisionValue,
          netValue: singleCost.netValue,
          roiPercentage: singleCost.roiPercentage,
        },
        monthlyProjection: {
          frequencyPerMonth: freq,
          projectedCost: monthlyCost,
          projectedDecisionValue: monthlyDecisionValue,
          projectedNetValue: monthlyNetValue,
          projectedROI: monthlyROI,
          costSavingsVsBaseline,
        },
      },
    });
  } catch (error) {
    console.error("Error running what-if simulation:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to simulate what-if scenario",
      error: error.message,
    });
  }
};
