import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openai", () => ({
  default: class OpenAI {},
}));

vi.mock("../models/FollowUpTask.js", () => ({
  default: { find: vi.fn(), countDocuments: vi.fn() },
}));

vi.mock("../services/followUpWorkflowService.js", () => ({
  getCompletionAnalytics: vi.fn(),
  updateTaskStatus: vi.fn(),
}));

vi.mock("../models/actionItemChangeLogModel.js", () => ({
  default: { find: vi.fn(), countDocuments: vi.fn() },
}));

vi.mock("../models/aiMeetingNoteModel.js", () => ({
  default: { find: vi.fn(), countDocuments: vi.fn() },
}));

vi.mock("../models/meetingROIModel.js", () => ({
  default: { find: vi.fn(), countDocuments: vi.fn() },
}));

import mongoose from "mongoose";
import FollowUpTask from "../models/FollowUpTask.js";
import ActionItemChangeLog from "../models/actionItemChangeLogModel.js";
import AiMeetingNote from "../models/aiMeetingNoteModel.js";
import MeetingROI from "../models/meetingROIModel.js";
import { getTasks } from "../controllers/followUpController.js";
import { getChangeLogs } from "../controllers/actionItemChangeLogController.js";
import { getNotes } from "../controllers/aiMeetingNoteController.js";
import { getROIRecords } from "../controllers/meetingROIController.js";
import {
  parsePagination,
  buildPaginationMeta,
  DEFAULT_MAX_LIMIT,
} from "../utils/pagination.js";

const ORG_A = "507f1f77bcf86cd799439011";
const ACTION_ITEM_ID = "507f1f77bcf86cd799439012";
const OTHER_USER = "507f1f77bcf86cd799439013";

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

const createReq = (query = {}, params = {}) => ({
  query,
  params,
  body: {},
  user: {
    _id: new mongoose.Types.ObjectId(),
    organization: new mongoose.Types.ObjectId(ORG_A),
  },
});

/**
 * A self-referential chainable stand-in for a Mongoose query, recording the
 * arguments each stage received. `skipArg` / `limitArg` are what these tests
 * are actually about — a NaN or absent limit is exactly the bug.
 */
const queryChain = (result = []) => {
  const chain = { calls: {} };
  for (const method of ["sort", "skip", "limit", "populate", "select"]) {
    chain[method] = vi.fn((arg) => {
      chain.calls[method] = arg;
      return chain;
    });
  }
  chain.lean = vi.fn().mockResolvedValue(result);
  chain.then = (resolve, reject) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
};

describe("List endpoint pagination (#2573)", () => {
  let followUpChain;
  let changeLogChain;
  let noteChain;
  let roiChain;

  beforeEach(() => {
    vi.clearAllMocks();

    followUpChain = queryChain();
    changeLogChain = queryChain();
    noteChain = queryChain();
    roiChain = queryChain();

    FollowUpTask.find.mockReturnValue(followUpChain);
    FollowUpTask.countDocuments.mockResolvedValue(0);
    ActionItemChangeLog.find.mockReturnValue(changeLogChain);
    ActionItemChangeLog.countDocuments.mockResolvedValue(0);
    AiMeetingNote.find.mockReturnValue(noteChain);
    AiMeetingNote.countDocuments.mockResolvedValue(0);
    MeetingROI.find.mockReturnValue(roiChain);
    MeetingROI.countDocuments.mockResolvedValue(0);
  });

  describe("parsePagination contract relied on here", () => {
    it("clamps an oversized limit rather than rejecting it", () => {
      expect(parsePagination({ limit: "1000000" }).limit).toBe(
        DEFAULT_MAX_LIMIT,
      );
    });

    it("falls back to the default for a malformed page", () => {
      expect(parsePagination({ page: "abc" }).page).toBe(1);
      expect(parsePagination({ page: "abc" }).skip).toBe(0);
    });

    it("never produces a negative skip", () => {
      expect(parsePagination({ page: "0" }).skip).toBe(0);
      expect(parsePagination({ page: "-5" }).skip).toBe(0);
    });

    it("never produces a limit of zero", () => {
      expect(parsePagination({ limit: "0" }).limit).toBeGreaterThan(0);
    });

    it("does not treat 1e5 as 1", () => {
      // `parseInt("1e5")` is 1 — the caller's request was silently ignored.
      expect(parsePagination({ limit: "1e5", defaultLimit: 20 }).limit).toBe(
        20,
      );
    });

    it("reports finite totalPages for any limit", () => {
      const meta = buildPaginationMeta({ total: 100, page: 1, limit: 20 });
      expect(meta.totalPages).toBe(5);
      expect(Number.isFinite(meta.totalPages)).toBe(true);
      expect(meta.hasMore).toBe(true);
    });
  });

  describe("followUpController.getTasks", () => {
    it("does not 500 on a malformed page", async () => {
      const res = createRes();
      await getTasks(createReq({ page: "abc" }), res);

      // The regression: parseInt("abc") is NaN, skip was NaN, MongoDB rejected
      // it and the catch-all reported a client input problem as a 500.
      expect(res.statusCode).toBe(200);
      expect(followUpChain.calls.skip).toBe(0);
    });

    it("clamps an oversized limit", async () => {
      const res = createRes();
      await getTasks(createReq({ limit: "500000" }), res);

      expect(followUpChain.calls.limit).toBe(100);
      expect(res.body.pagination.limit).toBe(100);
    });

    it("never passes limit 0, which Mongoose reads as no limit", async () => {
      await getTasks(createReq({ limit: "0" }), createRes());

      expect(followUpChain.calls.limit).toBeGreaterThan(0);
    });

    it("reports a finite totalPages instead of Infinity", async () => {
      FollowUpTask.countDocuments.mockResolvedValue(45);
      const res = createRes();

      await getTasks(createReq({ limit: "0" }), res);

      expect(Number.isFinite(res.body.pagination.totalPages)).toBe(true);
    });

    it("does not produce a negative skip for page 0", async () => {
      await getTasks(createReq({ page: "0" }), createRes());

      expect(followUpChain.calls.skip).toBe(0);
    });

    it("computes skip correctly for a real page", async () => {
      await getTasks(createReq({ page: "3", limit: "10" }), createRes());

      expect(followUpChain.calls.skip).toBe(20);
      expect(followUpChain.calls.limit).toBe(10);
    });

    it("rejects a malformed assignee with 400 rather than a 500 CastError", async () => {
      const res = createRes();
      await getTasks(createReq({ assignee: "hello" }), res);

      expect(res.statusCode).toBe(400);
      expect(FollowUpTask.find).not.toHaveBeenCalled();
    });

    it("accepts a valid assignee", async () => {
      const res = createRes();
      await getTasks(createReq({ assignee: OTHER_USER }), res);

      expect(res.statusCode).toBe(200);
      expect(FollowUpTask.find.mock.calls[0][0].assignee).toBe(OTHER_USER);
    });

    it("defaults the assignee to the caller", async () => {
      const req = createReq({});
      await getTasks(req, createRes());

      expect(String(FollowUpTask.find.mock.calls[0][0].assignee)).toBe(
        String(req.user._id),
      );
    });

    it("keeps the query scoped to the caller's organization", async () => {
      await getTasks(createReq({}), createRes());

      expect(String(FollowUpTask.find.mock.calls[0][0].organization)).toBe(
        ORG_A,
      );
    });

    it("returns hasMore alongside the existing keys", async () => {
      FollowUpTask.countDocuments.mockResolvedValue(45);
      const res = createRes();

      await getTasks(createReq({ page: "1", limit: "20" }), res);

      expect(res.body.pagination).toMatchObject({
        total: 45,
        page: 1,
        limit: 20,
        totalPages: 3,
        hasMore: true,
      });
    });
  });

  describe("actionItemChangeLogController.getChangeLogs", () => {
    it("clamps an oversized limit", async () => {
      await getChangeLogs(
        createReq({ limit: "999999" }, { id: ACTION_ITEM_ID }),
        createRes(),
      );

      expect(changeLogChain.calls.limit).toBe(200);
    });

    it("does not 500 on a malformed page", async () => {
      const res = createRes();
      await getChangeLogs(
        createReq({ page: "abc" }, { id: ACTION_ITEM_ID }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(changeLogChain.calls.skip).toBe(0);
    });

    it("rejects a malformed action item id with 400", async () => {
      const res = createRes();
      await getChangeLogs(createReq({}, { id: "nope" }), res);

      expect(res.statusCode).toBe(400);
      expect(ActionItemChangeLog.find).not.toHaveBeenCalled();
    });

    it("rejects a malformed userId filter with 400", async () => {
      const res = createRes();
      await getChangeLogs(
        createReq({ userId: "hello" }, { id: ACTION_ITEM_ID }),
        res,
      );

      expect(res.statusCode).toBe(400);
    });

    it("keeps the legacy pages key", async () => {
      ActionItemChangeLog.countDocuments.mockResolvedValue(120);
      const res = createRes();

      await getChangeLogs(
        createReq({ limit: "50" }, { id: ACTION_ITEM_ID }),
        res,
      );

      expect(res.body.pagination.pages).toBe(3);
      expect(res.body.pagination.totalPages).toBe(3);
    });
  });

  describe("aiMeetingNoteController.getNotes", () => {
    it("does not return the whole collection for limit=0", async () => {
      await getNotes(createReq({ limit: "0" }), createRes());

      expect(noteChain.calls.limit).toBeGreaterThan(0);
    });

    it("never passes NaN to limit", async () => {
      await getNotes(createReq({ limit: "abc" }), createRes());

      expect(Number.isNaN(noteChain.calls.limit)).toBe(false);
      expect(noteChain.calls.limit).toBe(20);
    });

    it("clamps an oversized limit", async () => {
      await getNotes(createReq({ limit: "100000" }), createRes());

      expect(noteChain.calls.limit).toBe(100);
    });

    it("keeps the legacy pages key", async () => {
      AiMeetingNote.countDocuments.mockResolvedValue(50);
      const res = createRes();

      await getNotes(createReq({ limit: "20" }), res);

      expect(res.body.data.pagination.pages).toBe(3);
    });
  });

  describe("meetingROIController.getROIRecords", () => {
    it("does not return the whole collection for limit=0", async () => {
      await getROIRecords(createReq({ limit: "0" }), createRes());

      expect(roiChain.calls.limit).toBeGreaterThan(0);
    });

    it("never passes NaN to limit", async () => {
      await getROIRecords(createReq({ limit: "abc" }), createRes());

      expect(Number.isNaN(roiChain.calls.limit)).toBe(false);
    });

    it("clamps an oversized limit", async () => {
      await getROIRecords(createReq({ limit: "100000" }), createRes());

      expect(roiChain.calls.limit).toBe(100);
    });

    it("computes skip from the clamped limit", async () => {
      await getROIRecords(
        createReq({ page: "2", limit: "100000" }),
        createRes(),
      );

      expect(roiChain.calls.skip).toBe(100);
    });
  });
});
