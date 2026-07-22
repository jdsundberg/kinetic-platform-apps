/**
 * St. Olaf Intramurals — custom API handler.
 * Auto-mounted by base/server.mjs when it exports apiPrefix + handleAPI.
 * Server-side aggregation only (may walk pages); the client never loads >25 rows.
 */
export const appId = "intramural";
export const apiPrefix = "/api/intramural";
export const kapp = "intramural";

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, jsonResp } = helpers;
  const KAPP = kapp;
  // ALWAYS wrap collectByQuery so kapp is the first arg (see apps/CLAUDE.md).
  async function collect(formSlug, kql, maxPages = 40) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }
  const vf = (s, f) => (s?.values?.[f] ?? "");
  const num = (x) => { const n = parseFloat(x); return isNaN(n) ? 0 : n; };

  if (pathname === "/api/intramural/dashboard" && req.method === "GET") {
    try {
      const [teams, games, feedback] = await Promise.all([
        collect("teams"), collect("games"), collect("feedback"),
      ]);

      const completed = games.filter(g => vf(g, "Status") === "Final");
      const scheduled = games.filter(g => vf(g, "Status") === "Scheduled");

      // KPIs
      const ratings = feedback.map(f => num(vf(f, "Overall Rating"))).filter(n => n > 0);
      const sportsRatings = feedback.map(f => num(vf(f, "Sportsmanship Rating"))).filter(n => n > 0);
      const avg = (a) => a.length ? (a.reduce((s, n) => s + n, 0) / a.length) : 0;

      const totals = {
        teams: teams.length,
        sports: new Set(teams.map(t => vf(t, "Sport"))).size,
        games: games.length,
        completed: completed.length,
        scheduled: scheduled.length,
        feedbackCount: feedback.length,
        avgRating: +avg(ratings).toFixed(2),
        avgSportsmanship: +avg(sportsRatings).toFixed(2),
      };

      // Per season/sport breakdown
      const groups = {};
      for (const t of teams) {
        const key = `${vf(t, "Season")}|${vf(t, "Sport")}`;
        (groups[key] = groups[key] || { season: vf(t, "Season"), sport: vf(t, "Sport"), teams: 0, games: 0, completed: 0 }).teams++;
      }
      for (const g of games) {
        const key = `${vf(g, "Season")}|${vf(g, "Sport")}`;
        if (!groups[key]) groups[key] = { season: vf(g, "Season"), sport: vf(g, "Sport"), teams: 0, games: 0, completed: 0 };
        groups[key].games++;
        if (vf(g, "Status") === "Final") groups[key].completed++;
      }
      const SEASON_ORDER = { Fall: 0, Winter: 1, Spring: 2 };
      const bySport = Object.values(groups).sort((a, b) =>
        (SEASON_ORDER[a.season] - SEASON_ORDER[b.season]) || a.sport.localeCompare(b.sport));

      const bySeason = ["Fall", "Winter", "Spring"].map(season => {
        const st = teams.filter(t => vf(t, "Season") === season);
        const sg = games.filter(g => vf(g, "Season") === season);
        return {
          season,
          teams: st.length,
          sports: new Set(st.map(t => vf(t, "Sport"))).size,
          games: sg.length,
          completed: sg.filter(g => vf(g, "Status") === "Final").length,
        };
      });

      // Standings leaders — top teams by wins then point differential
      const topTeams = teams
        .map(t => ({
          name: vf(t, "Team Name"), sport: vf(t, "Sport"), season: vf(t, "Season"),
          w: num(vf(t, "Wins")), l: num(vf(t, "Losses")), ti: num(vf(t, "Ties")),
          diff: num(vf(t, "Points For")) - num(vf(t, "Points Against")),
        }))
        .sort((a, b) => (b.w - a.w) || (b.diff - a.diff))
        .slice(0, 10);

      // Recent finals
      const recentGames = completed
        .slice()
        .sort((a, b) => String(vf(b, "Game Date")).localeCompare(String(vf(a, "Game Date"))))
        .slice(0, 8)
        .map(g => ({
          date: vf(g, "Game Date"), sport: vf(g, "Sport"), season: vf(g, "Season"),
          home: vf(g, "Home Team"), away: vf(g, "Away Team"),
          hs: vf(g, "Home Score"), as: vf(g, "Away Score"), winner: vf(g, "Winner"),
        }));

      return jsonResp(res, 200, { totals, bySeason, bySport, topTeams, recentGames });
    } catch (e) {
      return jsonResp(res, 500, { error: String(e && e.message || e) });
    }
  }

  return false;
}
