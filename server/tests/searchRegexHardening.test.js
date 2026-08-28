import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openai", () => ({
  default: class OpenAI {},
}));

vi.mock("../services/GenerativeAIService.js", () => ({
  generateSessionCardAI: vi.fn(),
}));

vi.mock("../models/sessionCardModel.js", () => ({
  default: { find: vi.fn(), countDocuments: vi.fn() },
}));

vi.mock("../models/aiMeetingNoteModel.js", () => ({
  default: { find: vi.fn(), countDocuments: vi.fn() },
}));

vi.mock("../models/bookmarkModel.js", () => ({
  default: { find: vi.fn(), populate: vi.fn() },
}));

vi.mock("../models/meetingModel.js", () => ({
  default: { findById: vi.fn(), find: vi.fn() },
}));

import mongoose from "mongoose";
import SessionCard from "../models/sessionCardModel.js";
import AiMeetingNote from "../models/aiMeetingNoteModel.js";
import Bookmark from "../models/bookmarkModel.js";
import { getSessions } from "../controllers/sessionController.js";
import { getNotes } from "../controllers/aiMeetingNoteController.js";
import { getBookmarks } from "../controllers/bookmarkController.js";
import {
  escapeRegExp,
  literalRegExp,
  literalContainsFilter,
  normalizeSearchTerm,
  MAX_SEARCH_TERM_LENGTH,
} from "../utils/regexUtils.js";

const ORG_A = "507f1f77bcf86cd799439011";

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

const createReq = (query = {}) => ({
  query,
  params: {},
  body: {},
  user: {
    _id: new mongoose.Types.ObjectId(),
    organization: new mongoose.Types.ObjectId(ORG_A),
  },
});

/**
 * A chainable stand-in for a Mongoose query.
 *
 * `getNotes` chains three `.populate()` calls, `getSessions` one. Returning
 * the same self-referential object from every method means the mock does not
 * have to mirror the exact chain length of each controller.
 */
const queryChain = (result = []) => {
  const chain = {};
  for (const method of ["sort", "skip", "limit", "populate", "select"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.lean = vi.fn().mockResolvedValue(result);
  chain.then = (resolve, reject) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
};

/** The filter the controller handed to the model. */
const filterPassedTo = (mockFn) => mockFn.mock.calls[0][0];

describe("Search regex hardening (#2572)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    SessionCard.find.mockReturnValue(queryChain());
    SessionCard.countDocuments.mockResolvedValue(0);
    AiMeetingNote.find.mockReturnValue(queryChain());
    AiMeetingNote.countDocuments.mockResolvedValue(0);
    Bookmark.find.mockReturnValue({ sort: vi.fn().mockResolvedValue([]) });
    Bookmark.populate.mockResolvedValue(undefined);
  });

  describe("regexUtils contract relied on here", () => {
    it("escapes every metacharacter that could change the match", () => {
      expect(escapeRegExp("C++")).toBe("C\\+\\+");
      expect(escapeRegExp(".*")).toBe("\\.\\*");
      expect(escapeRegExp("(a+)+$")).toBe("\\(a\\+\\)\\+\\$");
    });

    it("builds an anchored literal regex that survives a metacharacter", () => {
      const re = literalRegExp("C++");
      expect(re.test("C++")).toBe(true);
      expect(re.test("C")).toBe(false);
      expect(re.test("CXX")).toBe(false);
    });

    it("caps a term at MAX_SEARCH_TERM_LENGTH", () => {
      const long = "a".repeat(MAX_SEARCH_TERM_LENGTH + 500);
      expect(normalizeSearchTerm(long)).toHaveLength(MAX_SEARCH_TERM_LENGTH);
    });

    it("treats a whitespace-only term as absent so it cannot widen a query", () => {
      expect(normalizeSearchTerm("   ")).toBe("");
      expect(literalContainsFilter("   ")).toBeNull();
      expect(literalContainsFilter(undefined)).toBeNull();
    });
  });

  describe("getSessions", () => {
    it("does not throw on an event filter containing regex metacharacters", async () => {
      const res = createRes();
      await getSessions(createReq({ event: "C++" }), res);

      // The regression: `new RegExp("^C++$")` threw SyntaxError: Nothing to
      // repeat, which the catch-all reported as a 500.
      expect(res.statusCode).not.toBe(500);
      expect(SessionCard.find).toHaveBeenCalled();
    });

    it("treats an event filter of .* as literal text, not a wildcard", async () => {
      await getSessions(createReq({ event: ".*" }), createRes());

      const filter = filterPassedTo(SessionCard.find);
      const branch = filter.$and.find((c) => c.eventName);
      expect(branch.eventName.source).toBe("^\\.\\*$");
      expect(branch.eventName.test("anything at all")).toBe(false);
      expect(branch.eventName.test(".*")).toBe(true);
    });

    it("treats a tag filter of .* as literal text", async () => {
      await getSessions(createReq({ tag: ".*" }), createRes());

      const filter = filterPassedTo(SessionCard.find);
      const branch = filter.$and.find((c) => c.$or?.[0]?.keywords);
      expect(branch.$or[0].keywords.test("q3-planning")).toBe(false);
    });

    it("combines search and tag with AND, not OR", async () => {
      await getSessions(
        createReq({ search: "budget", tag: "q3" }),
        createRes(),
      );

      const filter = filterPassedTo(SessionCard.find);

      // The regression: the tag conditions were pushed onto the same `$or`
      // array the search had populated, so a session matching only one of the
      // two criteria came back.
      expect(Array.isArray(filter.$and)).toBe(true);
      expect(filter.$and).toHaveLength(2);
      expect(filter.$or).toBeUndefined();

      const searchBranch = filter.$and.find((c) =>
        c.$or?.some((o) => o.sessionTitle),
      );
      const tagBranch = filter.$and.find((c) => c.$or?.some((o) => o.keywords));
      expect(searchBranch).toBeDefined();
      expect(tagBranch).toBeDefined();
    });

    it("keeps all three criteria as separate AND branches", async () => {
      await getSessions(
        createReq({ search: "budget", tag: "q3", event: "Summit" }),
        createRes(),
      );

      expect(filterPassedTo(SessionCard.find).$and).toHaveLength(3);
    });

    it("escapes the free-text search term", async () => {
      await getSessions(createReq({ search: "(a+)+$" }), createRes());

      const filter = filterPassedTo(SessionCard.find);
      const branch = filter.$and[0].$or[0].sessionTitle;
      expect(branch.$regex).toBe("\\(a\\+\\)\\+\\$");
      expect(branch.$options).toBe("i");
    });

    it("caps an over-long search term", async () => {
      await getSessions(
        createReq({ search: "a".repeat(MAX_SEARCH_TERM_LENGTH + 1000) }),
        createRes(),
      );

      const filter = filterPassedTo(SessionCard.find);
      expect(filter.$and[0].$or[0].sessionTitle.$regex).toHaveLength(
        MAX_SEARCH_TERM_LENGTH,
      );
    });

    it("adds no $and at all when nothing is filtered", async () => {
      await getSessions(createReq({}), createRes());

      const filter = filterPassedTo(SessionCard.find);
      expect(filter.$and).toBeUndefined();
      expect(String(filter.organization)).toBe(ORG_A);
    });

    it("ignores a whitespace-only tag rather than matching empty strings", async () => {
      await getSessions(createReq({ tag: "   " }), createRes());

      expect(filterPassedTo(SessionCard.find).$and).toBeUndefined();
    });

    it("still supports the q alias for search", async () => {
      await getSessions(createReq({ q: "budget" }), createRes());

      const filter = filterPassedTo(SessionCard.find);
      expect(filter.$and[0].$or[0].sessionTitle.$regex).toBe("budget");
    });

    it("keeps the query scoped to the caller's organization", async () => {
      await getSessions(createReq({ search: "budget" }), createRes());

      expect(String(filterPassedTo(SessionCard.find).organization)).toBe(ORG_A);
    });
  });

  describe("getNotes", () => {
    it("does not throw on an unbalanced parenthesis", async () => {
      const res = createRes();
      await getNotes(createReq({ search: "(" }), res);

      expect(res.statusCode).not.toBe(500);
      expect(AiMeetingNote.find).toHaveBeenCalled();
    });

    it("treats .* as literal text", async () => {
      await getNotes(createReq({ search: ".*" }), createRes());

      const filter = filterPassedTo(AiMeetingNote.find);
      expect(filter.$or[0].title.$regex).toBe("\\.\\*");
    });

    it("escapes a catastrophically backtracking pattern", async () => {
      await getNotes(createReq({ search: "(a+)+$" }), createRes());

      const filter = filterPassedTo(AiMeetingNote.find);
      expect(filter.$or[0].title.$regex).toBe("\\(a\\+\\)\\+\\$");
    });

    it("searches title, summary and tags", async () => {
      await getNotes(createReq({ search: "budget" }), createRes());

      const filter = filterPassedTo(AiMeetingNote.find);
      expect(filter.$or.map((c) => Object.keys(c)[0])).toEqual([
        "title",
        "summary",
        "tags",
      ]);
    });

    it("adds no $or for a whitespace-only search", async () => {
      await getNotes(createReq({ search: "  " }), createRes());

      expect(filterPassedTo(AiMeetingNote.find).$or).toBeUndefined();
    });

    it("caps an over-long search term", async () => {
      await getNotes(
        createReq({ search: "b".repeat(MAX_SEARCH_TERM_LENGTH + 50) }),
        createRes(),
      );

      expect(
        filterPassedTo(AiMeetingNote.find).$or[0].title.$regex,
      ).toHaveLength(MAX_SEARCH_TERM_LENGTH);
    });
  });

  describe("getBookmarks", () => {
    const bookmarkDoc = (overrides = {}) => ({
      _id: new mongoose.Types.ObjectId(),
      notes: "",
      collectionName: "",
      meeting: null,
      toObject() {
        return { ...this };
      },
      ...overrides,
    });

    it("does not throw on a metacharacter-only search", async () => {
      Bookmark.find.mockReturnValue({ sort: vi.fn().mockResolvedValue([]) });
      const res = createRes();

      await getBookmarks(createReq({ search: "(" }), res);

      // The regression: `new RegExp("(")` threw before any filtering happened.
      expect(res.statusCode).not.toBe(500);
    });

    it("matches a term containing metacharacters literally", async () => {
      const match = bookmarkDoc({ notes: "review of C++ migration" });
      const miss = bookmarkDoc({ notes: "review of Rust migration" });
      Bookmark.find.mockReturnValue({
        sort: vi.fn().mockResolvedValue([match, miss]),
      });

      const res = createRes();
      await getBookmarks(createReq({ search: "C++" }), res);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].notes).toBe("review of C++ migration");
    });

    it("does not treat .* as a wildcard that matches everything", async () => {
      const a = bookmarkDoc({ notes: "alpha" });
      const b = bookmarkDoc({ notes: "beta" });
      Bookmark.find.mockReturnValue({
        sort: vi.fn().mockResolvedValue([a, b]),
      });

      const res = createRes();
      await getBookmarks(createReq({ search: ".*" }), res);

      expect(res.body).toHaveLength(0);
    });

    it("still matches on collection name and meeting title", async () => {
      const byCollection = bookmarkDoc({ collectionName: "Q3 planning" });
      const byMeeting = bookmarkDoc({
        meeting: { title: "Q3 kickoff", toString: () => "m1" },
      });
      const neither = bookmarkDoc({ notes: "unrelated" });
      Bookmark.find.mockReturnValue({
        sort: vi.fn().mockResolvedValue([byCollection, byMeeting, neither]),
      });

      const res = createRes();
      await getBookmarks(createReq({ search: "Q3" }), res);

      expect(res.body).toHaveLength(2);
    });

    it("returns everything when the search is whitespace only", async () => {
      const a = bookmarkDoc({ notes: "alpha" });
      const b = bookmarkDoc({ notes: "beta" });
      Bookmark.find.mockReturnValue({
        sort: vi.fn().mockResolvedValue([a, b]),
      });

      const res = createRes();
      await getBookmarks(createReq({ search: "   " }), res);

      expect(res.body).toHaveLength(2);
    });

    it("caps the term so pattern length cannot scale with input", async () => {
      const long = "a".repeat(MAX_SEARCH_TERM_LENGTH + 500);
      const doc = bookmarkDoc({ notes: long });
      Bookmark.find.mockReturnValue({
        sort: vi.fn().mockResolvedValue([doc]),
      });

      const res = createRes();
      await getBookmarks(createReq({ search: long }), res);

      // Truncated, not rejected — the first 200 characters still match.
      expect(res.body).toHaveLength(1);
    });
  });
});
