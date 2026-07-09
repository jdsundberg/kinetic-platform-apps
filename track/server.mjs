/**
 * Junior Track & Field — Custom API Handler
 * K–6 youth track & field across all 50 states. Server-side aggregation for the
 * national dashboard, state-league detail, the records board and feedback.
 */

export const appId = "track";
export const apiPrefix = "/api/track";
export const kapp = "track";

const num = (v) => parseFloat(v) || 0;

// Event catalog — direction: "asc" = lower mark is better (track times),
// "desc" = higher mark is better (field distances).
const EVENTS = {
  "50m Dash": "asc", "100m Dash": "asc", "200m Dash": "asc", "400m Run": "asc",
  "800m Run": "asc", "1600m Run": "asc", "4x100m Relay": "asc",
  "Long Jump": "desc", "Standing Long Jump": "desc", "High Jump": "desc",
  "Softball Throw": "desc", "Turbo Javelin": "desc", "Shot Put": "desc",
};
const isBetter = (event, a, b) => EVENTS[event] === "desc" ? a > b : a < b;

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 24) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }
  // results can be large — walk more pages
  const collectResults = (kql) => collect("results", kql, 60);

  // ── GET /api/track/dashboard ──────────────────────────────────────────
  if (pathname === "/api/track/dashboard" && req.method === "GET") {
    try {
      const [leagues, teams, coaches, athletes, meets, feedback] = await Promise.all([
        collect("leagues"), collect("teams"), collect("coaches"),
        collect("athletes", undefined, 50), collect("meets"), collect("feedback"),
      ]);
      const results = await collectResults();

      const activeAthletes = athletes.filter(a => vf(a, "Status") === "Active");
      const boys = activeAthletes.filter(a => vf(a, "Gender") === "Boys").length;
      const girls = activeAthletes.filter(a => vf(a, "Gender") === "Girls").length;

      const upcoming = meets.filter(m => ["Scheduled", "Registration Open"].includes(vf(m, "Status")))
        .sort((a, b) => (vf(a, "Meet Date") + vf(a, "Start Time")).localeCompare(vf(b, "Meet Date") + vf(b, "Start Time")));

      // region rollup
      const byRegion = {};
      leagues.forEach(lg => {
        const r = vf(lg, "Region") || "Other";
        if (!byRegion[r]) byRegion[r] = { region: r, states: 0, athletes: 0, teams: 0 };
        byRegion[r].states++;
        byRegion[r].athletes += num(vf(lg, "Athlete Count"));
        byRegion[r].teams += num(vf(lg, "Team Count"));
      });

      // grade distribution
      const gradeDist = {};
      activeAthletes.forEach(a => { const g = vf(a, "Grade") || "?"; gradeDist[g] = (gradeDist[g] || 0) + 1; });

      // feedback
      const rated = feedback.filter(f => num(vf(f, "Rating")) > 0);
      const avgRating = rated.length ? Math.round(rated.reduce((s, f) => s + num(vf(f, "Rating")), 0) / rated.length * 10) / 10 : 0;
      const recPct = feedback.length ? Math.round(feedback.filter(f => vf(f, "Would Recommend") === "Yes").length / feedback.length * 100) : 0;

      // recent PRs
      const prs = results.filter(r => vf(r, "Personal Best") === "Yes")
        .sort((a, b) => vf(b, "Date").localeCompare(vf(a, "Date"))).slice(0, 8)
        .map(r => ({ athlete: vf(r, "Athlete"), event: vf(r, "Event"), mark: vf(r, "Mark"),
          unit: vf(r, "Unit"), gender: vf(r, "Gender"), grade: vf(r, "Grade"), state: vf(r, "State"), date: vf(r, "Date") }));

      jsonResp(res, 200, {
        kpis: {
          states: leagues.length,
          teams: teams.filter(t => vf(t, "Status") === "Active").length,
          coaches: coaches.filter(c => vf(c, "Status") === "Active").length,
          athletes: activeAthletes.length, boys, girls,
          meets: meets.length,
          upcomingMeets: upcoming.length,
          results: results.length,
          prs: results.filter(r => vf(r, "Personal Best") === "Yes").length,
          avgRating, recPct,
          openFeedback: feedback.filter(f => vf(f, "Status") === "New" || vf(f, "Status") === "Follow Up Needed").length,
          unpaid: athletes.filter(a => vf(a, "Registration Paid") === "No").length,
        },
        byRegion: Object.values(byRegion).sort((a, b) => b.athletes - a.athletes),
        gradeDist,
        topStates: leagues.map(lg => ({ id: lg.id, state: vf(lg, "State"), name: vf(lg, "League Name"),
          region: vf(lg, "Region"), teams: num(vf(lg, "Team Count")), athletes: num(vf(lg, "Athlete Count")), status: vf(lg, "Status") }))
          .sort((a, b) => b.athletes - a.athletes).slice(0, 10),
        upcoming: upcoming.slice(0, 8).map(m => ({ id: m.id, name: vf(m, "Meet Name"), state: vf(m, "State"),
          date: vf(m, "Meet Date"), time: vf(m, "Start Time"), location: vf(m, "Location"), host: vf(m, "Host Team"), status: vf(m, "Status") })),
        recentPRs: prs,
        recentFeedback: feedback.sort((a, b) => vf(b, "Date").localeCompare(vf(a, "Date"))).slice(0, 5).map(f => ({
          by: vf(f, "Submitted By"), role: vf(f, "Role"), rating: vf(f, "Rating"),
          category: vf(f, "Category"), comment: vf(f, "Comment"), state: vf(f, "State"), date: vf(f, "Date") })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/track/records ────────────────────────────────────────────
  // best mark per Event × Gender × Grade
  if (pathname === "/api/track/records" && req.method === "GET") {
    try {
      const results = await collectResults();
      const best = {}; // key: event|gender|grade
      results.forEach(r => {
        const event = vf(r, "Event"); if (!EVENTS[event]) return;
        const gender = vf(r, "Gender"), grade = vf(r, "Grade");
        const mark = num(vf(r, "Mark")); if (!mark) return;
        const key = `${event}|${gender}|${grade}`;
        const cur = best[key];
        if (!cur || isBetter(event, mark, cur.markN)) {
          best[key] = { event, gender, grade, markN: mark, mark: vf(r, "Mark"), unit: vf(r, "Unit"),
            athlete: vf(r, "Athlete"), team: vf(r, "Team"), state: vf(r, "State"), date: vf(r, "Date") };
        }
      });
      const records = Object.values(best);
      jsonResp(res, 200, {
        events: Object.keys(EVENTS).map(e => ({ name: e, type: EVENTS[e] === "asc" ? "Track" : "Field" })),
        records,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/track/reports/feedback ───────────────────────────────────
  if (pathname === "/api/track/reports/feedback" && req.method === "GET") {
    try {
      const [leagues, feedback] = await Promise.all([collect("leagues"), collect("feedback")]);
      const rated = feedback.filter(f => num(vf(f, "Rating")) > 0);
      const avg = rated.length ? Math.round(rated.reduce((s, f) => s + num(vf(f, "Rating")), 0) / rated.length * 10) / 10 : 0;

      const catAgg = {};
      feedback.forEach(f => {
        const c = vf(f, "Category") || "Other";
        if (!catAgg[c]) catAgg[c] = { category: c, count: 0, sum: 0, rated: 0 };
        catAgg[c].count++;
        const r = num(vf(f, "Rating")); if (r) { catAgg[c].sum += r; catAgg[c].rated++; }
      });
      const byCategory = Object.values(catAgg).map(c => ({ category: c.category, count: c.count,
        avg: c.rated ? Math.round(c.sum / c.rated * 10) / 10 : 0 })).sort((a, b) => b.count - a.count);

      const roleAgg = {};
      feedback.forEach(f => { const r = vf(f, "Role") || "Other"; roleAgg[r] = (roleAgg[r] || 0) + 1; });

      jsonResp(res, 200, {
        total: feedback.length, avg,
        recPct: feedback.length ? Math.round(feedback.filter(f => vf(f, "Would Recommend") === "Yes").length / feedback.length * 100) : 0,
        open: feedback.filter(f => vf(f, "Status") === "New" || vf(f, "Status") === "Follow Up Needed").length,
        byCategory,
        byRole: Object.entries(roleAgg).map(([role, count]) => ({ role, count })).sort((a, b) => b.count - a.count),
        recent: feedback.sort((a, b) => vf(b, "Date").localeCompare(vf(a, "Date"))).slice(0, 15).map(f => ({
          by: vf(f, "Submitted By"), role: vf(f, "Role"), state: vf(f, "State"), category: vf(f, "Category"),
          rating: vf(f, "Rating"), recommend: vf(f, "Would Recommend"), comment: vf(f, "Comment"), status: vf(f, "Status"), date: vf(f, "Date") })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/track/league/:id ─────────────────────────────────────────
  const lMatch = pathname.match(/^\/api\/track\/league\/([^/]+)$/);
  if (lMatch && req.method === "GET") {
    try {
      const id = lMatch[1];
      const lr = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const lg = lr?.data?.submission;
      if (!lg) { jsonResp(res, 404, { error: "League not found" }); return true; }
      const state = vf(lg, "State");

      const [teams, coaches, athletes, meets, feedback] = await Promise.all([
        collect("teams", `values[State]="${state}"`),
        collect("coaches", `values[State]="${state}"`),
        collect("athletes", `values[State]="${state}"`),
        collect("meets", `values[State]="${state}"`),
        collect("feedback", `values[State]="${state}"`),
      ]);
      const results = await collectResults(`values[State]="${state}"`);

      const rated = feedback.filter(f => num(vf(f, "Rating")) > 0);
      const avg = rated.length ? Math.round(rated.reduce((s, f) => s + num(vf(f, "Rating")), 0) / rated.length * 10) / 10 : 0;
      const active = athletes.filter(a => vf(a, "Status") === "Active");

      jsonResp(res, 200, {
        league: lg,
        summary: {
          teams: teams.length, athletes: active.length,
          boys: active.filter(a => vf(a, "Gender") === "Boys").length,
          girls: active.filter(a => vf(a, "Gender") === "Girls").length,
          coaches: coaches.length, meets: meets.length,
          upcoming: meets.filter(m => ["Scheduled", "Registration Open"].includes(vf(m, "Status"))).length,
          results: results.length, prs: results.filter(r => vf(r, "Personal Best") === "Yes").length, avg,
        },
        teams: teams.map(t => ({ id: t.id, name: vf(t, "Team Name"), city: vf(t, "City"),
          coach: vf(t, "Head Coach"), division: vf(t, "Division"), athletes: vf(t, "Athlete Count") })),
        coaches: coaches.map(c => ({ id: c.id, name: vf(c, "Name"), role: vf(c, "Role"),
          team: vf(c, "Team"), cert: vf(c, "Certification"), status: vf(c, "Status") })),
        upcoming: meets.filter(m => ["Scheduled", "Registration Open"].includes(vf(m, "Status")))
          .sort((a, b) => vf(a, "Meet Date").localeCompare(vf(b, "Meet Date"))).slice(0, 10)
          .map(m => ({ name: vf(m, "Meet Name"), date: vf(m, "Meet Date"), time: vf(m, "Start Time"),
            location: vf(m, "Location"), host: vf(m, "Host Team"), status: vf(m, "Status") })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
