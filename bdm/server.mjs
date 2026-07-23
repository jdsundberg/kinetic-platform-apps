// BDM Affiliate Operations — aggregation endpoints.
//
// The client obeys the 25-per-page golden rule, so anything that needs a view
// across ALL transitions (status rollup, integration inventory) is computed
// here server-side instead of paging in the browser.
export const appId = "bdm";
export const apiPrefix = "/api/bdm";
export const kapp = "bdm";

const STATUSES = ["Requested", "Awaiting Approval", "Cutover In Progress",
                  "Cutover Complete", "Closed", "Failed"];

// Small in-memory cache — the overview is polled by the dashboard.
let _cache = { data: null, ts: 0 };
let _inflight = null;
const TTL_MS = 60 * 1000;

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp } = helpers;

  // collect() shorthand — collectByQuery takes kapp as its FIRST arg, and
  // calling it without one silently queries the wrong kapp and returns [].
  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(kapp, formSlug, kql, auth, maxPages);
  }

  if (pathname === `${apiPrefix}/overview`) {
    const fresh = Date.now() - _cache.ts < TTL_MS;
    if (fresh && _cache.data) { jsonResp(res, 200, _cache.data); return true; }
    if (_inflight) { jsonResp(res, 200, await _inflight); return true; }

    _inflight = (async () => {
      const transitions = await collect("affiliate-transition", null);
      const approvals = await collect("cutover-approval", null);

      const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
      let dryRun = 0, live = 0;
      for (const t of transitions) {
        const v = t.values || {};
        const st = v["Status"];
        if (st && byStatus[st] !== undefined) byStatus[st] += 1;
        if (v["Dry Run"] === "No") live += 1; else dryRun += 1;
      }

      // NOTE: the task-engine inventory (installed connector handlers + their
      // routines) is deliberately NOT fetched here. This launcher's
      // kineticRequest() hard-prefixes every path with /app/api/v1, so a Task
      // API path becomes /app/api/v1/app/components/task/... and 404s. The
      // client fetches it instead through the launcher's /app/* proxy, which
      // passes the path through untouched.
      const data = {
        total: transitions.length,
        byStatus,
        dryRun,
        live,
        approvals: approvals.length,
        awaitingApproval: byStatus["Awaiting Approval"] || 0,
      };
      _cache = { data, ts: Date.now() };
      return data;
    })();

    try {
      jsonResp(res, 200, await _inflight);
    } catch (e) {
      jsonResp(res, 500, { error: String(e?.message || e) });
    } finally {
      _inflight = null;
    }
    return true;
  }

  return false;
}
