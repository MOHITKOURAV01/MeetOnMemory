import apiClient from "../services/apiClient.js";

/**
 * Participant contribution API.
 *
 * This module used bare `axios` against a relative `/api` base (Issue #2574).
 * That sends the request to whichever origin is serving the frontend, so in the
 * documented split-port dev setup — Vite on `:5173`, server on `:4000` — every
 * call 404'd against the dev server. `apiClient` is configured with
 * `getBackendUrl()` from `config/backendConfig.js`, which resolves
 * `VITE_BACKEND_URL` / `VITE_API_URL`.
 *
 * Going through `apiClient` also restores what a bare `axios` call skips:
 * the 30s request deadline added by #978 (axios defaults `timeout` to `0`, i.e.
 * wait forever, which left spinners hung with neither `.then` nor `.catch` ever
 * running), the retry/backoff in `services/httpRetry.js`, GET de-duplication,
 * and the interceptor that normalizes errors and attaches the request id.
 *
 * `withCredentials` is set on the shared instance, so it is not repeated here.
 */

/**
 * Fetch participant contributions for a given meeting
 * @param {string} meetingId
 */
export const getMeetingContributions = async (meetingId) => {
  const response = await apiClient.get(
    `/api/meetings/${meetingId}/contributions`,
  );
  return response.data;
};

/**
 * Manually trigger calculation of participant contributions for a given meeting
 * @param {string} meetingId
 */
export const calculateMeetingContributions = async (meetingId) => {
  const response = await apiClient.post(
    `/api/meetings/${meetingId}/contributions/calculate`,
    {},
  );
  return response.data;
};
