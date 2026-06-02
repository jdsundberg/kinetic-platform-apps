/**
 * Incident Management — Custom API Handler
 * Dashboard aggregation over the incidents form.
 */
export const appId = "incidents";
export const apiPrefix = "/api/incidents";
export const kapp = "incidents";

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, vf } = helpers;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(kapp, formSlug, kql, auth, maxPages);
  }

  const OPEN_STATES = new Set(["Open", "In Progress", "On Hold"]);
  const CLOSED_STATES = new Set(["Resolved", "Closed"]);

  // GET /api/incidents/dashboard — management overview KPIs
  if (pathname === "/api/incidents/dashboard" && req.method === "GET") {
    try {
      const now = Date.now();
      const [incs, users, slas] = await Promise.all([
        collect("incidents", null, 8),
        collect("users", null, 4),
        collect("sla-policies", null, 2),
      ]);

      const open = incs.filter(s => OPEN_STATES.has(vf(s, "Status")));
      const closed = incs.filter(s => CLOSED_STATES.has(vf(s, "Status")));

      // SLA breach / at-risk on open incidents
      let breached = 0, atRisk = 0;
      for (const s of open) {
        const due = vf(s, "SLA Due");
        if (!due) continue;
        const dueMs = new Date(due).getTime();
        const remainMs = dueMs - now;
        if (remainMs < 0) breached++;
        else if (remainMs < 2 * 3600 * 1000) atRisk++;
      }

      const byStatus = {}, byPriority = {}, byTeam = {}, byAssignee = {};
      for (const s of incs) {
        const st = vf(s, "Status") || "Unknown";
        byStatus[st] = (byStatus[st] || 0) + 1;
      }
      for (const s of open) {
        const pr = vf(s, "Priority") || "Unspecified";
        byPriority[pr] = (byPriority[pr] || 0) + 1;
        const tm = vf(s, "Team") || "Unassigned";
        byTeam[tm] = (byTeam[tm] || 0) + 1;
        const as = vf(s, "Assignee") || "Unassigned";
        byAssignee[as] = (byAssignee[as] || 0) + 1;
      }

      // Average resolution time (hours) for closed/resolved
      let totalH = 0, n = 0;
      for (const s of closed) {
        const o = vf(s, "Opened At"), r = vf(s, "Resolved At");
        if (o && r) {
          const h = (new Date(r) - new Date(o)) / 3600000;
          if (h > 0) { totalH += h; n++; }
        }
      }
      const avgResolutionHours = n > 0 ? Math.round((totalH / n) * 10) / 10 : 0;

      // SLA breach list (top breaches by remaining time, most negative first)
      const breachList = open
        .filter(s => {
          const d = vf(s, "SLA Due");
          return d && new Date(d).getTime() < now;
        })
        .map(s => ({
          id: s.id,
          number: vf(s, "Incident Number"),
          title: vf(s, "Title"),
          priority: vf(s, "Priority"),
          assignee: vf(s, "Assignee"),
          team: vf(s, "Team"),
          status: vf(s, "Status"),
          slaDue: vf(s, "SLA Due"),
          hoursOver: Math.round((now - new Date(vf(s, "SLA Due")).getTime()) / 36e5 * 10) / 10,
        }))
        .sort((a, b) => b.hoursOver - a.hoursOver);

      jsonResp(res, 200, {
        kpis: {
          total: incs.length,
          open: open.length,
          closed: closed.length,
          breached,
          atRisk,
          avgResolutionHours,
          users: users.filter(u => vf(u, "Active") === "Yes").length,
        },
        byStatus,
        byPriority,
        byTeam,
        byAssignee,
        breachList,
        slaPolicies: slas.map(s => ({
          priority: vf(s, "Priority"),
          responseHours: vf(s, "Response Hours"),
          resolutionHours: vf(s, "Resolution Hours"),
        })),
      });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: String(e?.message || e) });
      return true;
    }
  }

  // GET /api/incidents/notifications — notifications for the current user
  // Team-addressed notifications (To Username = "Incident Managers") are surfaced
  // only to users who are members of that team in the platform.
  if (pathname === "/api/incidents/notifications" && req.method === "GET") {
    try {
      // identify caller from Basic auth
      const meRes = await kineticRequest("GET", "/me", null, auth);
      const username = meRes?.data?.username || meRes?.data?.user?.username;
      // platform teams the caller belongs to
      const memRes = await kineticRequest("GET", `/users/${encodeURIComponent(username)}?include=memberships`, null, auth);
      const teamNames = (memRes?.data?.user?.memberships || []).map(m => m.team?.name).filter(Boolean);
      const audiences = [username, ...teamNames];
      // pull notifications addressed to any audience
      const all = [];
      for (const a of audiences) {
        const subs = await collect("notifications", `values[To Username] = "${a}"`, 4);
        for (const s of subs) all.push(s);
      }
      // dedupe by id
      const seen = new Set();
      const merged = all.filter(s => seen.has(s.id) ? false : (seen.add(s.id), true));
      // newest first
      merged.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      jsonResp(res, 200, {
        username,
        teams: teamNames,
        items: merged.map(s => ({
          id: s.id,
          createdAt: s.createdAt,
          incidentId: vf(s, "Incident Id"),
          incidentNumber: vf(s, "Incident Number"),
          title: vf(s, "Title"),
          threshold: vf(s, "Threshold"),
          priority: vf(s, "Priority"),
          message: vf(s, "Message"),
          to: vf(s, "To Username"),
          read: vf(s, "Read") === "Yes",
        })),
      });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: String(e?.message || e) });
      return true;
    }
  }

  // GET /api/incidents/assignment-options — users + SLA policies for dropdowns
  if (pathname === "/api/incidents/assignment-options" && req.method === "GET") {
    try {
      const [users, slas] = await Promise.all([
        collect("users", `values[Active] = "Yes"`, 4),
        collect("sla-policies", null, 2),
      ]);
      jsonResp(res, 200, {
        users: users.map(u => ({
          username: vf(u, "Username"),
          displayName: vf(u, "Display Name"),
          team: vf(u, "Team"),
        })),
        slaPolicies: slas.map(s => ({
          priority: vf(s, "Priority"),
          resolutionHours: parseFloat(vf(s, "Resolution Hours")) || 0,
        })),
      });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: String(e?.message || e) });
      return true;
    }
  }

  return false;
}
