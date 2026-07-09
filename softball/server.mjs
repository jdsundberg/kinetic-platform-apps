/**
 * Grand Slam Softball — Custom API Handler
 * Server-side aggregation for the league dashboard, standings, league 360 and finances.
 * National softball association with four divisions.
 */

export const appId = "softball";
export const apiPrefix = "/api/softball";
export const kapp = "softball";

const num = (v) => parseFloat(v) || 0;

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, jsonResp, vf } = helpers;
  const KAPP = kapp;

  // collectByQuery needs kapp as first arg — always go through this shorthand
  async function collect(formSlug, kql, maxPages = 20) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  const FINAL = ["Final"];
  const UPCOMING = ["Scheduled", "In Progress"];

  // team-standings helper — reused by dashboard + standings endpoint
  function computeStandings(teams, games) {
    const rec = {};
    teams.forEach(t => {
      const name = vf(t, "Team Name");
      rec[name] = {
        team: name, league: vf(t, "League"), city: vf(t, "City"),
        w: num(vf(t, "Wins")), l: num(vf(t, "Losses")), tie: num(vf(t, "Ties")),
        rf: 0, ra: 0, played: 0,
      };
    });
    games.filter(g => FINAL.includes(vf(g, "Status"))).forEach(g => {
      const home = vf(g, "Home Team"), away = vf(g, "Away Team");
      const hs = num(vf(g, "Home Score")), as = num(vf(g, "Away Score"));
      if (rec[home]) { rec[home].rf += hs; rec[home].ra += as; rec[home].played++; }
      if (rec[away]) { rec[away].rf += as; rec[away].ra += hs; rec[away].played++; }
    });
    return Object.values(rec).map(r => {
      const decisions = r.w + r.l;
      return {
        ...r, diff: r.rf - r.ra,
        pct: decisions ? Math.round(r.w / decisions * 1000) / 1000 : 0,
      };
    }).sort((a, b) => b.pct - a.pct || b.diff - a.diff);
  }

  // ── GET /api/softball/dashboard ───────────────────────────────────────
  if (pathname === "/api/softball/dashboard" && req.method === "GET") {
    try {
      const [leagues, teams, coaches, players, games, feedback, finances] = await Promise.all([
        collect("leagues"), collect("teams"), collect("coaches"), collect("players"),
        collect("schedules"), collect("feedback"), collect("finances"),
      ]);

      const activeTeams = teams.filter(t => vf(t, "Status") === "Active");
      const activePlayers = players.filter(p => vf(p, "Status") === "Active");
      const activeCoaches = coaches.filter(c => vf(c, "Status") === "Active");

      const finalGames = games.filter(g => FINAL.includes(vf(g, "Status")));
      const upcoming = games.filter(g => UPCOMING.includes(vf(g, "Status")))
        .sort((a, b) => (vf(a, "Game Date") + vf(a, "Game Time")).localeCompare(vf(b, "Game Date") + vf(b, "Game Time")));
      const postponed = games.filter(g => vf(g, "Status") === "Postponed");

      // finances
      const income = finances.filter(f => vf(f, "Type") === "Income");
      const expense = finances.filter(f => vf(f, "Type") === "Expense");
      const totalIncome = income.reduce((s, f) => s + num(vf(f, "Amount")), 0);
      const totalExpense = expense.reduce((s, f) => s + num(vf(f, "Amount")), 0);
      const outstanding = finances.filter(f => vf(f, "Status") === "Pending" || vf(f, "Status") === "Overdue")
        .reduce((s, f) => s + num(vf(f, "Amount")), 0);

      // feedback
      const rated = feedback.filter(f => num(vf(f, "Rating")) > 0);
      const avgRating = rated.length ? Math.round(rated.reduce((s, f) => s + num(vf(f, "Rating")), 0) / rated.length * 10) / 10 : 0;
      const recommend = feedback.filter(f => vf(f, "Would Recommend") === "Yes").length;
      const recPct = feedback.length ? Math.round(recommend / feedback.length * 100) : 0;
      const openFeedback = feedback.filter(f => vf(f, "Status") === "New" || vf(f, "Status") === "Follow Up Needed").length;

      // per-league rollup
      const byLeague = leagues.map(lg => {
        const name = vf(lg, "League Name");
        const lgTeams = teams.filter(t => vf(t, "League") === name);
        const lgPlayers = players.filter(p => vf(p, "League") === name);
        const lgGames = games.filter(g => vf(g, "League") === name);
        const lgFin = finances.filter(f => vf(f, "League") === name);
        const inc = lgFin.filter(f => vf(f, "Type") === "Income").reduce((s, f) => s + num(vf(f, "Amount")), 0);
        const exp = lgFin.filter(f => vf(f, "Type") === "Expense").reduce((s, f) => s + num(vf(f, "Amount")), 0);
        return {
          id: lg.id, name, division: vf(lg, "Division"), region: vf(lg, "Region"),
          commissioner: vf(lg, "Commissioner"), status: vf(lg, "Status"),
          teams: lgTeams.length, players: lgPlayers.length,
          games: lgGames.length, played: lgGames.filter(g => FINAL.includes(vf(g, "Status"))).length,
          net: inc - exp,
        };
      });

      // standings — top 5 overall
      const standings = computeStandings(teams, games).slice(0, 5);

      const kpis = {
        leagues: leagues.length,
        teams: activeTeams.length,
        players: activePlayers.length,
        coaches: activeCoaches.length,
        gamesPlayed: finalGames.length,
        gamesUpcoming: upcoming.length,
        postponed: postponed.length,
        totalIncome, totalExpense, netIncome: totalIncome - totalExpense, outstanding,
        avgRating, recPct, openFeedback,
        unpaidPlayers: players.filter(p => vf(p, "Registration Paid") === "No").length,
      };

      jsonResp(res, 200, {
        kpis, byLeague, standings,
        upcoming: upcoming.slice(0, 8).map(g => ({
          id: g.id, date: vf(g, "Game Date"), time: vf(g, "Game Time"),
          home: vf(g, "Home Team"), away: vf(g, "Away Team"),
          field: vf(g, "Field"), league: vf(g, "League"), status: vf(g, "Status"),
        })),
        recentResults: finalGames.sort((a, b) => vf(b, "Game Date").localeCompare(vf(a, "Game Date"))).slice(0, 6).map(g => ({
          date: vf(g, "Game Date"), home: vf(g, "Home Team"), away: vf(g, "Away Team"),
          hs: vf(g, "Home Score"), as: vf(g, "Away Score"), league: vf(g, "League"),
        })),
        recentFeedback: feedback.sort((a, b) => vf(b, "Date").localeCompare(vf(a, "Date"))).slice(0, 5).map(f => ({
          by: vf(f, "Submitted By"), role: vf(f, "Role"), rating: vf(f, "Rating"),
          category: vf(f, "Category"), comments: vf(f, "Comments"), date: vf(f, "Date"), league: vf(f, "League"),
        })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/softball/standings ───────────────────────────────────────
  if (pathname === "/api/softball/standings" && req.method === "GET") {
    try {
      const [leagues, teams, games] = await Promise.all([
        collect("leagues"), collect("teams"), collect("schedules"),
      ]);
      const all = computeStandings(teams, games);
      const byLeague = leagues.map(lg => {
        const name = vf(lg, "League Name");
        return { league: name, division: vf(lg, "Division"), teams: all.filter(t => t.league === name) };
      }).filter(g => g.teams.length);
      jsonResp(res, 200, { byLeague });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/softball/reports/finances ────────────────────────────────
  if (pathname === "/api/softball/reports/finances" && req.method === "GET") {
    try {
      const [leagues, finances] = await Promise.all([collect("leagues"), collect("finances")]);

      const income = finances.filter(f => vf(f, "Type") === "Income");
      const expense = finances.filter(f => vf(f, "Type") === "Expense");
      const totalIncome = income.reduce((s, f) => s + num(vf(f, "Amount")), 0);
      const totalExpense = expense.reduce((s, f) => s + num(vf(f, "Amount")), 0);

      // by category
      const catAgg = (rows) => {
        const m = {};
        rows.forEach(f => {
          const c = vf(f, "Category") || "Other";
          m[c] = (m[c] || 0) + num(vf(f, "Amount"));
        });
        return Object.entries(m).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
      };
      const incomeByCat = catAgg(income);
      const expenseByCat = catAgg(expense);

      // by league P&L
      const byLeague = leagues.map(lg => {
        const name = vf(lg, "League Name");
        const lgFin = finances.filter(f => vf(f, "League") === name);
        const inc = lgFin.filter(f => vf(f, "Type") === "Income").reduce((s, f) => s + num(vf(f, "Amount")), 0);
        const exp = lgFin.filter(f => vf(f, "Type") === "Expense").reduce((s, f) => s + num(vf(f, "Amount")), 0);
        return { league: name, division: vf(lg, "Division"), income: inc, expense: exp, net: inc - exp };
      }).sort((a, b) => b.net - a.net);

      // outstanding receivables/payables
      const outstanding = finances.filter(f => vf(f, "Status") === "Pending" || vf(f, "Status") === "Overdue")
        .map(f => ({
          id: f.id, date: vf(f, "Date"), league: vf(f, "League"), type: vf(f, "Type"),
          category: vf(f, "Category"), amount: num(vf(f, "Amount")), status: vf(f, "Status"),
          desc: vf(f, "Description"), vendor: vf(f, "Vendor"),
        })).sort((a, b) => b.amount - a.amount);

      jsonResp(res, 200, {
        totals: { income: totalIncome, expense: totalExpense, net: totalIncome - totalExpense },
        incomeByCat, expenseByCat, byLeague, outstanding,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/softball/league/:id ──────────────────────────────────────
  const leagueMatch = pathname.match(/^\/api\/softball\/league\/([^/]+)$/);
  if (leagueMatch && req.method === "GET") {
    try {
      const id = leagueMatch[1];
      const { kineticRequest } = helpers;
      const lr = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const lg = lr?.data?.submission;
      if (!lg) { jsonResp(res, 404, { error: "League not found" }); return true; }
      const name = vf(lg, "League Name");

      const [teams, coaches, players, games, finances, feedback] = await Promise.all([
        collect("teams", `values[League]="${name}"`),
        collect("coaches", `values[League]="${name}"`),
        collect("players", `values[League]="${name}"`),
        collect("schedules", `values[League]="${name}"`),
        collect("finances", `values[League]="${name}"`),
        collect("feedback", `values[League]="${name}"`),
      ]);

      const inc = finances.filter(f => vf(f, "Type") === "Income").reduce((s, f) => s + num(vf(f, "Amount")), 0);
      const exp = finances.filter(f => vf(f, "Type") === "Expense").reduce((s, f) => s + num(vf(f, "Amount")), 0);
      const rated = feedback.filter(f => num(vf(f, "Rating")) > 0);
      const avgRating = rated.length ? Math.round(rated.reduce((s, f) => s + num(vf(f, "Rating")), 0) / rated.length * 10) / 10 : 0;

      jsonResp(res, 200, {
        league: lg,
        summary: {
          teams: teams.length, players: players.length, coaches: coaches.length,
          gamesPlayed: games.filter(g => FINAL.includes(vf(g, "Status"))).length,
          gamesUpcoming: games.filter(g => UPCOMING.includes(vf(g, "Status"))).length,
          income: inc, expense: exp, net: inc - exp, avgRating,
        },
        standings: computeStandings(teams, games),
        teams: teams.map(t => ({
          id: t.id, name: vf(t, "Team Name"), city: vf(t, "City"), coach: vf(t, "Head Coach"),
          field: vf(t, "Home Field"), w: vf(t, "Wins"), l: vf(t, "Losses"), roster: vf(t, "Roster Size"),
        })),
        coaches: coaches.map(c => ({
          id: c.id, name: vf(c, "Name"), role: vf(c, "Role"), team: vf(c, "Team"),
          cert: vf(c, "Certification"), status: vf(c, "Status"),
        })),
        upcoming: games.filter(g => UPCOMING.includes(vf(g, "Status")))
          .sort((a, b) => vf(a, "Game Date").localeCompare(vf(b, "Game Date"))).slice(0, 10)
          .map(g => ({
            date: vf(g, "Game Date"), time: vf(g, "Game Time"), home: vf(g, "Home Team"),
            away: vf(g, "Away Team"), field: vf(g, "Field"), status: vf(g, "Status"),
          })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
