/**
 * Crux Bouldering — Custom API Handler
 * Server-side aggregation for the dashboard, boulder board, reservation scheduler
 * and the Boulder Training Fund.
 */

export const appId = "bouldering";
export const apiPrefix = "/api/bouldering";
export const kapp = "bouldering";

const num = (v) => parseFloat(v) || 0;
const gradeNum = (g) => { const m = String(g || "").match(/V(\d+)/i); return m ? parseInt(m[1], 10) : -1; };

const FUND_GOAL = 10000; // Boulder Training Fund target ($)

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 20) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // aggregate comment ratings/sends per boulder name
  function boulderStats(comments) {
    const m = {};
    comments.forEach(c => {
      const b = vf(c, "Boulder"); if (!b) return;
      if (!m[b]) m[b] = { ratingSum: 0, ratingCount: 0, sends: 0, comments: 0 };
      const r = num(vf(c, "Rating"));
      if (r > 0) { m[b].ratingSum += r; m[b].ratingCount++; }
      if (vf(c, "Sent") === "Yes") m[b].sends++;
      m[b].comments++;
    });
    Object.values(m).forEach(s => s.avg = s.ratingCount ? Math.round(s.ratingSum / s.ratingCount * 10) / 10 : 0);
    return m;
  }

  // ── GET /api/bouldering/dashboard ─────────────────────────────────────
  if (pathname === "/api/bouldering/dashboard" && req.method === "GET") {
    try {
      const [locations, boulders, reservations, comments, donations] = await Promise.all([
        collect("locations"), collect("boulders"), collect("reservations"),
        collect("comments"), collect("donations"),
      ]);

      const openBoulders = boulders.filter(b => vf(b, "Status") === "Open");
      const stats = boulderStats(comments);

      const upcoming = reservations.filter(r => ["Confirmed", "Pending"].includes(vf(r, "Status")))
        .sort((a, b) => (vf(a, "Reserve Date") + vf(a, "Start Time")).localeCompare(vf(b, "Reserve Date") + vf(b, "Start Time")));

      // donations
      const paid = donations.filter(d => vf(d, "Status") === "Paid" || vf(d, "Status") === "Cleared");
      const fundRaised = paid.reduce((s, d) => s + num(vf(d, "Amount")), 0);
      const tierCount = { "5": 0, "10": 0, "20": 0 };
      paid.forEach(d => { const t = String(Math.round(num(vf(d, "Amount")))); if (tierCount[t] != null) tierCount[t]++; });

      // ratings
      const rated = comments.filter(c => num(vf(c, "Rating")) > 0);
      const avgRating = rated.length ? Math.round(rated.reduce((s, c) => s + num(vf(c, "Rating")), 0) / rated.length * 10) / 10 : 0;
      const totalSends = comments.filter(c => vf(c, "Sent") === "Yes").length;

      // top rated boulders (min 2 ratings)
      const topRated = boulders.map(b => {
        const st = stats[vf(b, "Name")] || { avg: 0, ratingCount: 0, sends: 0 };
        return { id: b.id, name: vf(b, "Name"), grade: vf(b, "Grade"), location: vf(b, "Location"),
          style: vf(b, "Style"), color: vf(b, "Hold Color"), avg: st.avg, ratings: st.ratingCount, sends: st.sends };
      }).filter(b => b.ratings >= 2).sort((a, b) => b.avg - a.avg || b.ratings - a.ratings).slice(0, 6);

      // grade distribution
      const gradeDist = {};
      openBoulders.forEach(b => { const g = vf(b, "Grade") || "?"; gradeDist[g] = (gradeDist[g] || 0) + 1; });

      const kpis = {
        locations: locations.filter(l => vf(l, "Status") === "Open" || vf(l, "Status") === "Active").length,
        totalLocations: locations.length,
        boulders: openBoulders.length,
        totalBoulders: boulders.length,
        upcomingReservations: upcoming.length,
        totalReservations: reservations.length,
        boardPosts: comments.length,
        avgRating, totalSends,
        fundRaised, fundGoal: FUND_GOAL,
        fundPct: Math.min(100, Math.round(fundRaised / FUND_GOAL * 100)),
        donationCount: paid.length,
        tierCount,
      };

      jsonResp(res, 200, {
        kpis,
        locations: locations.map(l => {
          const name = vf(l, "Name");
          const lbs = boulders.filter(b => vf(b, "Location") === name);
          return { id: l.id, name, type: vf(l, "Type"), city: vf(l, "City"), state: vf(l, "State"),
            status: vf(l, "Status"), boulders: lbs.length, open: lbs.filter(b => vf(b, "Status") === "Open").length };
        }),
        topRated, gradeDist,
        upcoming: upcoming.slice(0, 8).map(r => ({
          id: r.id, boulder: vf(r, "Boulder"), location: vf(r, "Location"), by: vf(r, "Reserved By"),
          date: vf(r, "Reserve Date"), start: vf(r, "Start Time"), end: vf(r, "End Time"),
          party: vf(r, "Party Size"), status: vf(r, "Status"),
        })),
        recentPosts: comments.sort((a, b) => vf(b, "Date").localeCompare(vf(a, "Date"))).slice(0, 6).map(c => ({
          author: vf(c, "Author"), boulder: vf(c, "Boulder"), rating: vf(c, "Rating"),
          sent: vf(c, "Sent"), comment: vf(c, "Comment"), date: vf(c, "Date"), attempts: vf(c, "Attempts"),
        })),
        recentDonations: paid.sort((a, b) => vf(b, "Date").localeCompare(vf(a, "Date"))).slice(0, 6).map(d => ({
          name: vf(d, "Anonymous") === "Yes" ? "Anonymous" : vf(d, "Donor Name"),
          amount: vf(d, "Amount"), message: vf(d, "Message"), date: vf(d, "Date"),
        })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/bouldering/boulder/:id ───────────────────────────────────
  const bMatch = pathname.match(/^\/api\/bouldering\/boulder\/([^/]+)$/);
  if (bMatch && req.method === "GET") {
    try {
      const id = bMatch[1];
      const br = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const b = br?.data?.submission;
      if (!b) { jsonResp(res, 404, { error: "Boulder not found" }); return true; }
      const name = vf(b, "Name");

      const [comments, reservations] = await Promise.all([
        collect("comments", `values[Boulder]="${name}"`),
        collect("reservations", `values[Boulder]="${name}"`),
      ]);

      const rated = comments.filter(c => num(vf(c, "Rating")) > 0);
      const avg = rated.length ? Math.round(rated.reduce((s, c) => s + num(vf(c, "Rating")), 0) / rated.length * 10) / 10 : 0;
      const sends = comments.filter(c => vf(c, "Sent") === "Yes").length;
      const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      rated.forEach(c => { const r = Math.round(num(vf(c, "Rating"))); if (dist[r] != null) dist[r]++; });

      jsonResp(res, 200, {
        boulder: b,
        summary: { avg, ratings: rated.length, sends, comments: comments.length, dist,
          upcoming: reservations.filter(r => ["Confirmed", "Pending"].includes(vf(r, "Status"))).length },
        comments: comments.sort((a, b) => vf(b, "Date").localeCompare(vf(a, "Date"))).map(c => ({
          author: vf(c, "Author"), rating: vf(c, "Rating"), comment: vf(c, "Comment"),
          sent: vf(c, "Sent"), attempts: vf(c, "Attempts"), suggested: vf(c, "Suggested Grade"), date: vf(c, "Date"),
        })),
        reservations: reservations.sort((a, b) => vf(a, "Reserve Date").localeCompare(vf(b, "Reserve Date"))).map(r => ({
          by: vf(r, "Reserved By"), date: vf(r, "Reserve Date"), start: vf(r, "Start Time"),
          end: vf(r, "End Time"), party: vf(r, "Party Size"), status: vf(r, "Status"),
        })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/bouldering/reports/leaderboard ───────────────────────────
  if (pathname === "/api/bouldering/reports/leaderboard" && req.method === "GET") {
    try {
      const [boulders, comments] = await Promise.all([collect("boulders"), collect("comments")]);
      const stats = boulderStats(comments);
      const rows = boulders.map(b => {
        const st = stats[vf(b, "Name")] || { avg: 0, ratingCount: 0, sends: 0, comments: 0 };
        return { name: vf(b, "Name"), grade: vf(b, "Grade"), gradeN: gradeNum(vf(b, "Grade")),
          location: vf(b, "Location"), style: vf(b, "Style"), color: vf(b, "Hold Color"),
          setter: vf(b, "Setter"), status: vf(b, "Status"),
          avg: st.avg, ratings: st.ratingCount, sends: st.sends, comments: st.comments };
      });
      const topRated = rows.filter(r => r.ratings >= 2).sort((a, b) => b.avg - a.avg || b.ratings - a.ratings).slice(0, 15);
      const mostSent = rows.filter(r => r.sends > 0).sort((a, b) => b.sends - a.sends).slice(0, 15);
      const hardest = rows.filter(r => r.gradeN >= 0).sort((a, b) => b.gradeN - a.gradeN || b.avg - a.avg).slice(0, 15);
      jsonResp(res, 200, { topRated, mostSent, hardest });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/bouldering/fund ──────────────────────────────────────────
  if (pathname === "/api/bouldering/fund" && req.method === "GET") {
    try {
      const donations = await collect("donations");
      const paid = donations.filter(d => vf(d, "Status") === "Paid" || vf(d, "Status") === "Cleared");
      const pending = donations.filter(d => vf(d, "Status") === "Pending");
      const raised = paid.reduce((s, d) => s + num(vf(d, "Amount")), 0);
      const pendingAmt = pending.reduce((s, d) => s + num(vf(d, "Amount")), 0);
      const tiers = { "5": 0, "10": 0, "20": 0, other: 0 };
      paid.forEach(d => { const t = String(Math.round(num(vf(d, "Amount")))); if (tiers[t] != null) tiers[t]++; else tiers.other++; });
      const byLocation = {};
      paid.forEach(d => { const l = vf(d, "Location") || "General Fund"; byLocation[l] = (byLocation[l] || 0) + num(vf(d, "Amount")); });
      jsonResp(res, 200, {
        goal: FUND_GOAL, raised, pending: pendingAmt, pct: Math.min(100, Math.round(raised / FUND_GOAL * 100)),
        count: paid.length, avgGift: paid.length ? Math.round(raised / paid.length) : 0,
        tiers,
        byLocation: Object.entries(byLocation).map(([location, amount]) => ({ location, amount })).sort((a, b) => b.amount - a.amount),
        recent: paid.sort((a, b) => vf(b, "Date").localeCompare(vf(a, "Date"))).slice(0, 12).map(d => ({
          name: vf(d, "Anonymous") === "Yes" ? "Anonymous" : vf(d, "Donor Name"),
          amount: vf(d, "Amount"), tier: vf(d, "Tier"), message: vf(d, "Message"), date: vf(d, "Date"), location: vf(d, "Location"),
        })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
