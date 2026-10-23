/**
 * Band Scheduler — custom API handler.
 * Auto-mounted by base/server.mjs when it exports apiPrefix + handleAPI.
 * Server-side aggregation only (may walk pages); the client never loads >25 rows.
 */
export const appId = "band-scheduler";
export const apiPrefix = "/api/bandsched";
export const kapp = "band-scheduler";

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, jsonResp } = helpers;
  const KAPP = kapp;
  // ALWAYS wrap collectByQuery so kapp is the first arg (see apps/CLAUDE.md).
  async function collect(formSlug, kql, maxPages = 40) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }
  const vf = (s, f) => (s?.values?.[f] ?? "");
  const num = (x) => { const n = parseFloat(x); return isNaN(n) ? 0 : n; };
  const avg = (a) => (a.length ? a.reduce((s, n) => s + n, 0) / a.length : 0);

  // Lookup lists for filter/modal dropdowns. Server-side aggregation keeps the
  // client from paging through 100 bands just to fill a <select>.
  if (pathname === "/api/bandsched/lookups" && req.method === "GET") {
    try {
      const [venues, bands] = await Promise.all([collect("venues"), collect("bands")]);
      const uniq = (a) => [...new Set(a.filter(Boolean))].sort((x, y) => x.localeCompare(y));
      jsonResp(res, 200, {
        venues: uniq(venues.map(v => vf(v, "Venue Name"))),
        bands: uniq(bands.map(b => vf(b, "Band Name"))),
        genres: uniq(bands.map(b => vf(b, "Genre"))),
        cities: uniq([...venues.map(v => vf(v, "City")), ...bands.map(b => vf(b, "Home City"))]),
        venueTypes: uniq(venues.map(v => vf(v, "Venue Type"))),
      });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: String((e && e.message) || e) });
      return true;
    }
  }

  if (pathname === "/api/bandsched/dashboard" && req.method === "GET") {
    try {
      const [venues, bands, gigs, feedback] = await Promise.all([
        collect("venues"), collect("bands"), collect("gigs"), collect("feedback"),
      ]);

      const played = gigs.filter(g => vf(g, "Status") === "Played");
      const upcoming = gigs.filter(g => ["Scheduled", "Confirmed"].includes(vf(g, "Status")));
      const today = new Date().toISOString().slice(0, 10);

      const overall = feedback.map(f => num(vf(f, "Overall Rating"))).filter(n => n > 0);
      const perf = feedback.map(f => num(vf(f, "Performance Rating"))).filter(n => n > 0);
      const bookAgain = feedback.filter(f => vf(f, "Would Book Again"));

      const totals = {
        venues: venues.length,
        activeVenues: venues.filter(v => vf(v, "Status") === "Active").length,
        bands: bands.length,
        activeBands: bands.filter(b => vf(b, "Status") === "Active").length,
        genres: new Set(bands.map(b => vf(b, "Genre")).filter(Boolean)).size,
        gigs: gigs.length,
        played: played.length,
        upcoming: upcoming.length,
        cancelled: gigs.filter(g => vf(g, "Status") === "Cancelled").length,
        attendance: played.reduce((s, g) => s + num(vf(g, "Attendance")), 0),
        doorRevenue: Math.round(played.reduce((s, g) => s + num(vf(g, "Tickets Sold")) * num(vf(g, "Door Price")), 0)),
        barSales: Math.round(played.reduce((s, g) => s + num(vf(g, "Bar Sales")), 0)),
        guarantees: Math.round(played.reduce((s, g) => s + num(vf(g, "Guarantee")), 0)),
        feedbackCount: feedback.length,
        avgRating: +avg(overall).toFixed(2),
        avgPerformance: +avg(perf).toFixed(2),
        bookAgainPct: bookAgain.length
          ? Math.round(100 * bookAgain.filter(f => vf(f, "Would Book Again") === "Yes").length / bookAgain.length)
          : 0,
      };

      // ── by genre: bands, gigs, attendance, rating ──
      const genreMap = {};
      const G = (g) => (genreMap[g] = genreMap[g] || { genre: g, bands: 0, gigs: 0, played: 0, attendance: 0, ratings: [] });
      for (const b of bands) { const g = vf(b, "Genre"); if (g) G(g).bands++; }
      for (const gig of gigs) {
        const g = vf(gig, "Genre"); if (!g) continue;
        const e = G(g); e.gigs++;
        if (vf(gig, "Status") === "Played") { e.played++; e.attendance += num(vf(gig, "Attendance")); }
      }
      const bandGenre = Object.fromEntries(bands.map(b => [vf(b, "Band Name"), vf(b, "Genre")]));
      for (const f of feedback) {
        const g = bandGenre[vf(f, "Band")]; const r = num(vf(f, "Overall Rating"));
        if (g && r > 0) G(g).ratings.push(r);
      }
      const byGenre = Object.values(genreMap)
        .map(e => ({ genre: e.genre, bands: e.bands, gigs: e.gigs, played: e.played, attendance: e.attendance, avgRating: +avg(e.ratings).toFixed(2) }))
        .sort((a, b) => b.gigs - a.gigs || b.bands - a.bands);

      // ── top bands: rating from feedback, gigs played, draw ──
      const bandStats = {};
      const B = (n) => (bandStats[n] = bandStats[n] || { band: n, genre: bandGenre[n] || "", gigs: 0, attendance: 0, ratings: [], yes: 0, votes: 0 });
      for (const gig of gigs) {
        if (vf(gig, "Status") !== "Played") continue;
        const e = B(vf(gig, "Band")); e.gigs++; e.attendance += num(vf(gig, "Attendance"));
      }
      for (const f of feedback) {
        const e = B(vf(f, "Band")); const r = num(vf(f, "Overall Rating"));
        if (r > 0) e.ratings.push(r);
        if (vf(f, "Would Book Again")) { e.votes++; if (vf(f, "Would Book Again") === "Yes") e.yes++; }
      }
      const topBands = Object.values(bandStats)
        .filter(e => e.ratings.length >= 2)
        .map(e => ({
          band: e.band, genre: e.genre, gigs: e.gigs,
          avgAttendance: e.gigs ? Math.round(e.attendance / e.gigs) : 0,
          avgRating: +avg(e.ratings).toFixed(2), reviews: e.ratings.length,
          bookAgainPct: e.votes ? Math.round(100 * e.yes / e.votes) : 0,
        }))
        .sort((a, b) => b.avgRating - a.avgRating || b.avgAttendance - a.avgAttendance)
        .slice(0, 10);

      // ── top venues: shows hosted, attendance, fill rate ──
      const capByVenue = Object.fromEntries(venues.map(v => [vf(v, "Venue Name"), num(vf(v, "Capacity"))]));
      const venueStats = {};
      for (const gig of gigs) {
        const n = vf(gig, "Venue"); if (!n) continue;
        const e = (venueStats[n] = venueStats[n] || { venue: n, city: vf(gig, "City"), gigs: 0, played: 0, attendance: 0, bar: 0 });
        e.gigs++;
        if (vf(gig, "Status") === "Played") { e.played++; e.attendance += num(vf(gig, "Attendance")); e.bar += num(vf(gig, "Bar Sales")); }
      }
      const topVenues = Object.values(venueStats)
        .map(e => {
          const cap = capByVenue[e.venue] || 0;
          const avgAtt = e.played ? Math.round(e.attendance / e.played) : 0;
          return { venue: e.venue, city: e.city, capacity: cap, gigs: e.gigs, played: e.played, avgAttendance: avgAtt, barSales: Math.round(e.bar), fill: cap ? Math.round(100 * avgAtt / cap) : 0 };
        })
        .sort((a, b) => b.played - a.played || b.avgAttendance - a.avgAttendance)
        .slice(0, 10);

      // ── next shows on the calendar ──
      const upcomingGigs = upcoming
        .filter(g => String(vf(g, "Gig Date")) >= today)
        .sort((a, b) => String(vf(a, "Gig Date")).localeCompare(String(vf(b, "Gig Date"))))
        .slice(0, 10)
        .map(g => ({
          date: vf(g, "Gig Date"), time: vf(g, "Set Time"), band: vf(g, "Band"),
          support: vf(g, "Support Act"), venue: vf(g, "Venue"), city: vf(g, "City"),
          genre: vf(g, "Genre"), door: vf(g, "Door Price"), status: vf(g, "Status"),
        }));

      // ── latest feedback ──
      const recentFeedback = feedback
        .slice()
        .sort((a, b) => String(vf(b, "Date")).localeCompare(String(vf(a, "Date"))))
        .slice(0, 8)
        .map(f => ({
          date: vf(f, "Date"), band: vf(f, "Band"), venue: vf(f, "Venue"),
          by: vf(f, "Submitted By"), role: vf(f, "Role"),
          overall: vf(f, "Overall Rating"), again: vf(f, "Would Book Again"),
          comment: vf(f, "Comment"),
        }));

      jsonResp(res, 200, { totals, byGenre, topBands, topVenues, upcomingGigs, recentFeedback });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: String((e && e.message) || e) });
      return true;
    }
  }

  return false;
}
