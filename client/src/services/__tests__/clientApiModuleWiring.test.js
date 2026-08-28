import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import apiClient from "../apiClient.js";
import * as recurringActionItemApi from "../../api/recurringActionItemApi.js";
import * as participantContributionApi from "../../api/participantContributionApi.js";
import { assertAllCallsUseApiPrefix } from "./helpers/apiPrefixAssertionHelper.js";

vi.mock("../apiClient.js", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "../../api");

/**
 * Modules knowingly still on bare `axios`.
 *
 * `meetingNudgeApi.js` is the subject of #2000, which is already open and
 * assigned. Listing it here rather than widening the assertion keeps the guard
 * meaningful for every other module, and makes the exception something a
 * reviewer has to delete deliberately when #2000 lands.
 */
const KNOWN_BARE_AXIOS = new Set(["meetingNudgeApi.js"]);

const MEETING_ID = "meeting-1";
const ITEM_ID = "item-1";

describe("client API module wiring (#2574)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue({ data: { success: true } });
    apiClient.post.mockResolvedValue({ data: { success: true } });
    apiClient.put.mockResolvedValue({ data: { success: true } });
    apiClient.delete.mockResolvedValue({ data: { success: true } });
  });

  describe("no module under src/api bypasses the shared client", () => {
    const sources = fs
      .readdirSync(apiDir)
      .filter((file) => file.endsWith(".js"))
      .map((file) => ({
        file,
        source: fs.readFileSync(path.join(apiDir, file), "utf8"),
      }));

    it("finds modules to check", () => {
      expect(sources.length).toBeGreaterThan(0);
    });

    it.each(
      sources
        .map(({ file }) => file)
        .filter((file) => !KNOWN_BARE_AXIOS.has(file)),
    )("%s does not import axios directly", (file) => {
      const { source } = sources.find((s) => s.file === file);

      // A bare axios call skips the resolved base URL, the 30s deadline from
      // #978, retries, de-duplication and error normalization. Every module
      // here should reach the network through `services/apiClient`.
      expect(source).not.toMatch(/^import\s+axios\s+from\s+["']axios["']/m);
    });

    it("tracks exactly one remaining bare-axios module", () => {
      const offenders = sources
        .filter(({ source }) =>
          /^import\s+axios\s+from\s+["']axios["']/m.test(source),
        )
        .map(({ file }) => file);

      // If this fails with an empty array, #2000 has landed — delete
      // KNOWN_BARE_AXIOS and this test. If it fails with a new name, a module
      // has regressed.
      expect(offenders).toEqual([...KNOWN_BARE_AXIOS]);
    });

    it.each(sources.map(({ file }) => file))(
      "%s resolves every relative import to a file that exists",
      (file) => {
        const { source } = sources.find((s) => s.file === file);
        const specifiers = [
          ...source.matchAll(/from\s+["'](\.[^"']+)["']/g),
        ].map((m) => m[1]);

        for (const specifier of specifiers) {
          const base = path.resolve(apiDir, specifier);
          const candidates = [
            base,
            `${base}.js`,
            `${base}.jsx`,
            path.join(base, "index.js"),
          ];

          // The regression: `recurringActionItemApi.js` imported
          // "./apiClient", which does not exist. It only escaped the build
          // because nothing rendered the component that reaches it.
          expect(
            candidates.some((candidate) => fs.existsSync(candidate)),
            `${file} imports "${specifier}", which resolves to nothing`,
          ).toBe(true);
        }
      },
    );
  });

  describe("recurringActionItemApi", () => {
    it("imports a module that actually resolves", () => {
      // If the import were still broken this suite would fail to load at all;
      // asserting the exports are callable states the expectation explicitly.
      expect(typeof recurringActionItemApi.getRecurringActionItems).toBe(
        "function",
      );
      expect(typeof recurringActionItemApi.createRecurringActionItem).toBe(
        "function",
      );
    });

    it("routes every call through the shared client under /api", async () => {
      await recurringActionItemApi.getRecurringActionItems();
      await recurringActionItemApi.getRecurringActionItemById(ITEM_ID);
      await recurringActionItemApi.createRecurringActionItem({ title: "x" });
      await recurringActionItemApi.updateRecurringActionItem(ITEM_ID, {
        title: "y",
      });
      await recurringActionItemApi.deleteRecurringActionItem(ITEM_ID);

      expect(apiClient.get).toHaveBeenCalledWith("/api/recurring-action-items");
      expect(apiClient.get).toHaveBeenCalledWith(
        `/api/recurring-action-items/${ITEM_ID}`,
      );
      expect(apiClient.post).toHaveBeenCalledWith(
        "/api/recurring-action-items",
        { title: "x" },
      );
      expect(apiClient.put).toHaveBeenCalledWith(
        `/api/recurring-action-items/${ITEM_ID}`,
        { title: "y" },
      );
      expect(apiClient.delete).toHaveBeenCalledWith(
        `/api/recurring-action-items/${ITEM_ID}`,
      );

      assertAllCallsUseApiPrefix(apiClient);
    });

    it("returns the response payload rather than the axios envelope", async () => {
      apiClient.get.mockResolvedValue({ data: { items: [1, 2] } });

      await expect(
        recurringActionItemApi.getRecurringActionItems(),
      ).resolves.toEqual({ items: [1, 2] });
    });
  });

  describe("participantContributionApi", () => {
    it("fetches contributions through the shared client", async () => {
      await participantContributionApi.getMeetingContributions(MEETING_ID);

      expect(apiClient.get).toHaveBeenCalledWith(
        `/api/meetings/${MEETING_ID}/contributions`,
      );
      assertAllCallsUseApiPrefix(apiClient);
    });

    it("triggers calculation through the shared client", async () => {
      await participantContributionApi.calculateMeetingContributions(
        MEETING_ID,
      );

      expect(apiClient.post).toHaveBeenCalledWith(
        `/api/meetings/${MEETING_ID}/contributions/calculate`,
        {},
      );
      assertAllCallsUseApiPrefix(apiClient);
    });

    it("does not pass withCredentials per request", async () => {
      // It is set once on the shared instance; repeating it per call is how
      // the bare-axios version had to do it, and drifts.
      await participantContributionApi.getMeetingContributions(MEETING_ID);

      const [, config] = apiClient.get.mock.calls[0];
      expect(config).toBeUndefined();
    });

    it("returns the response payload rather than the axios envelope", async () => {
      apiClient.get.mockResolvedValue({ data: { contributions: [] } });

      await expect(
        participantContributionApi.getMeetingContributions(MEETING_ID),
      ).resolves.toEqual({ contributions: [] });
    });

    it("propagates a rejection so react-query can surface it", async () => {
      apiClient.get.mockRejectedValue(new Error("Network Error"));

      await expect(
        participantContributionApi.getMeetingContributions(MEETING_ID),
      ).rejects.toThrow("Network Error");
    });
  });
});
