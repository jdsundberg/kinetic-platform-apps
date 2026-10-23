/**
 * Northwoods Boat Rental — custom API handler.
 * Auto-mounted by base/server.mjs when it exports apiPrefix + handleAPI.
 * Server-side aggregation only (may walk pages); the client never loads >25 rows.
 */
export const appId = "boat-rental";
export const apiPrefix = "/api/boatrental";
export const kapp = "boat-rental";

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
  const r2 = (n) => +n.toFixed(2);
  const uniq = (a) => [...new Set(a.filter(Boolean))].sort((x, y) => x.localeCompare(y));

  // Lookup lists for filter/modal dropdowns — keeps the client from paging
  // through the whole fleet just to fill a <select>.
  if (pathname === "/api/boatrental/lookups" && req.method === "GET") {
    try {
      const [lakes, boats] = await Promise.all([collect("lakes"), collect("boats")]);
      jsonResp(res, 200, {
        lakes: uniq(lakes.map(l => vf(l, "Lake Name"))),
        counties: uniq(lakes.map(l => vf(l, "County"))),
        boats: boats
          .map(b => ({ name: vf(b, "Boat Name"), type: vf(b, "Boat Type"), lake: vf(b, "Lake"),
                       status: vf(b, "Status"), half: vf(b, "Half Day Rate"), full: vf(b, "Full Day Rate"),
                       capacity: vf(b, "Capacity") }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: String((e && e.message) || e) });
      return true;
    }
  }

  if (pathname === "/api/boatrental/dashboard" && req.method === "GET") {
    try {
      const [lakes, boats, reservations, feedback, mailing] = await Promise.all([
        collect("lakes"), collect("boats"), collect("reservations"), collect("feedback"), collect("mailing-list"),
      ]);

      const today = new Date().toISOString().slice(0, 10);
      const BOOKED = ["Requested", "Confirmed", "Out", "Returned"];
      const live = reservations.filter(r => BOOKED.includes(vf(r, "Status")));
      const returned = reservations.filter(r => vf(r, "Status") === "Returned");
      const upcoming = reservations.filter(r => ["Requested", "Confirmed", "Out"].includes(vf(r, "Status")) && String(vf(r, "Reservation Date")) >= today);
      const rentable = boats.filter(b => vf(b, "Status") === "Available");

      // Boat-days sold: a full day counts as one, each half day as a half.
      const boatDays = live.reduce((s, r) => s + (vf(r, "Time Block") === "Full Day" ? 1 : 0.5), 0);

      const overall = feedback.map(f => num(vf(f, "Overall Rating"))).filter(n => n > 0);
      const boatRatings = feedback.map(f => num(vf(f, "Boat Rating"))).filter(n => n > 0);
      const lakeRatings = feedback.map(f => num(vf(f, "Lake Rating"))).filter(n => n > 0);
      const againVotes = feedback.filter(f => vf(f, "Would Rent Again"));
      const subs = mailing.filter(m => vf(m, "Status") === "Subscribed");

      const totals = {
        lakes: lakes.length,
        activeLakes: lakes.filter(l => vf(l, "Status") === "Active").length,
        boats: boats.length,
        rentable: rentable.length,
        maintenance: boats.filter(b => vf(b, "Status") === "Maintenance").length,
        reservations: reservations.length,
        upcoming: upcoming.length,
        returned: returned.length,
        cancelled: reservations.filter(r => vf(r, "Status") === "Cancelled").length,
        boatDays: r2(boatDays),
        revenue: Math.round(returned.reduce((s, r) => s + num(vf(r, "Rate")), 0)),
        pipeline: Math.round(upcoming.reduce((s, r) => s + num(vf(r, "Rate")), 0)),
        feedbackCount: feedback.length,
        avgRating: r2(avg(overall)),
        avgBoatRating: r2(avg(boatRatings)),
        avgLakeRating: r2(avg(lakeRatings)),
        rentAgainPct: againVotes.length
          ? Math.round(100 * againVotes.filter(f => vf(f, "Would Rent Again") === "Yes").length / againVotes.length) : 0,
        subscribers: subs.length,
        unsubscribed: mailing.filter(m => vf(m, "Status") === "Unsubscribed").length,
        bounced: mailing.filter(m => vf(m, "Status") === "Bounced").length,
      };

      // ── by boat type ──
      const typeMap = {};
      const T = (t) => (typeMap[t] = typeMap[t] || { type: t, boats: 0, rentals: 0, revenue: 0, days: 0, ratings: [] });
      for (const b of boats) { const t = vf(b, "Boat Type"); if (t) T(t).boats++; }
      for (const r of live) {
        const t = vf(r, "Boat Type"); if (!t) continue;
        const e = T(t); e.rentals++; e.days += vf(r, "Time Block") === "Full Day" ? 1 : 0.5;
        if (vf(r, "Status") === "Returned") e.revenue += num(vf(r, "Rate"));
      }
      for (const f of feedback) {
        const t = vf(f, "Boat Type"); const n = num(vf(f, "Boat Rating"));
        if (t && n > 0) T(t).ratings.push(n);
      }
      const byBoatType = Object.values(typeMap).map(e => ({
        type: e.type, boats: e.boats, rentals: e.rentals, days: r2(e.days),
        revenue: Math.round(e.revenue), avgRating: r2(avg(e.ratings)),
      })).sort((a, b) => b.rentals - a.rentals);

      // ── by lake ──
      const lakeMap = {};
      const L = (n) => (lakeMap[n] = lakeMap[n] || { lake: n, boats: 0, rentals: 0, revenue: 0, ratings: [] });
      for (const l of lakes) L(vf(l, "Lake Name")).county = vf(l, "County");
      for (const b of boats) { const n = vf(b, "Lake"); if (n) L(n).boats++; }
      for (const r of live) {
        const n = vf(r, "Lake"); if (!n) continue;
        const e = L(n); e.rentals++;
        if (vf(r, "Status") === "Returned") e.revenue += num(vf(r, "Rate"));
      }
      for (const f of feedback) {
        const n = vf(f, "Lake"); const x = num(vf(f, "Lake Rating"));
        if (n && x > 0) L(n).ratings.push(x);
      }
      const byLake = Object.values(lakeMap).map(e => ({
        lake: e.lake, county: e.county || "", boats: e.boats, rentals: e.rentals,
        revenue: Math.round(e.revenue), avgLakeRating: r2(avg(e.ratings)),
        perBoat: e.boats ? r2(e.rentals / e.boats) : 0,
      })).sort((a, b) => b.rentals - a.rentals);

      // ── time block mix ──
      const blockMap = {};
      for (const r of live) { const b = vf(r, "Time Block") || "—"; blockMap[b] = (blockMap[b] || 0) + 1; }
      const byBlock = Object.entries(blockMap).map(([block, count]) => ({
        block, count, pct: live.length ? Math.round(100 * count / live.length) : 0,
      })).sort((a, b) => b.count - a.count);

      // ── busiest boats ──
      const boatMap = {};
      for (const r of live) {
        const n = vf(r, "Boat"); if (!n) continue;
        const e = (boatMap[n] = boatMap[n] || { boat: n, type: vf(r, "Boat Type"), lake: vf(r, "Lake"), rentals: 0, revenue: 0, days: 0 });
        e.rentals++; e.days += vf(r, "Time Block") === "Full Day" ? 1 : 0.5;
        if (vf(r, "Status") === "Returned") e.revenue += num(vf(r, "Rate"));
      }
      const topBoats = Object.values(boatMap)
        .map(e => ({ ...e, days: r2(e.days), revenue: Math.round(e.revenue) }))
        .sort((a, b) => b.rentals - a.rentals || b.revenue - a.revenue).slice(0, 10);

      // ── next departures ──
      const BLOCK_ORDER = { "Half Day AM": 0, "Full Day": 1, "Half Day PM": 2 };
      const upcomingList = upcoming
        .sort((a, b) => String(vf(a, "Reservation Date")).localeCompare(String(vf(b, "Reservation Date")))
          || (BLOCK_ORDER[vf(a, "Time Block")] ?? 9) - (BLOCK_ORDER[vf(b, "Time Block")] ?? 9))
        .slice(0, 10)
        .map(r => ({
          date: vf(r, "Reservation Date"), block: vf(r, "Time Block"), boat: vf(r, "Boat"),
          type: vf(r, "Boat Type"), lake: vf(r, "Lake"), customer: vf(r, "Customer Name"),
          party: vf(r, "Party Size"), rate: vf(r, "Rate"), status: vf(r, "Status"),
        }));

      // ── latest feedback ──
      const recentFeedback = feedback.slice()
        .sort((a, b) => String(vf(b, "Date")).localeCompare(String(vf(a, "Date")))).slice(0, 8)
        .map(f => ({
          date: vf(f, "Date"), type: vf(f, "Feedback Type"), boat: vf(f, "Boat"), lake: vf(f, "Lake"),
          by: vf(f, "Submitted By"), overall: vf(f, "Overall Rating"),
          again: vf(f, "Would Rent Again"), comment: vf(f, "Comment"),
        }));

      // ── mailing list readiness, by quarter ──
      const quarterMap = {};
      for (const m of subs) {
        const q = vf(m, "Last Quarter Mailed") || "Never mailed";
        quarterMap[q] = (quarterMap[q] || 0) + 1;
      }
      const byQuarter = Object.entries(quarterMap)
        .map(([quarter, count]) => ({ quarter, count }))
        .sort((a, b) => a.quarter.localeCompare(b.quarter));
      const interestMap = {};
      for (const m of subs) { const i = vf(m, "Interests") || "—"; interestMap[i] = (interestMap[i] || 0) + 1; }
      const byInterest = Object.entries(interestMap).map(([interest, count]) => ({ interest, count }))
        .sort((a, b) => b.count - a.count);

      jsonResp(res, 200, { totals, byBoatType, byLake, byBlock, topBoats, upcomingList, recentFeedback, byQuarter, byInterest });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: String((e && e.message) || e) });
      return true;
    }
  }

  // Recipients for a quarterly mailing: subscribed, not already mailed this quarter,
  // optionally narrowed by interest or preferred lake.
  if (pathname === "/api/boatrental/mailing-preview" && req.method === "GET") {
    try {
      const url = new URL(req.url, "http://localhost");
      const quarter = url.searchParams.get("quarter") || "";
      const interest = url.searchParams.get("interest") || "";
      const lake = url.searchParams.get("lake") || "";
      const all = await collect("mailing-list");
      const recipients = all.filter(m =>
        vf(m, "Status") === "Subscribed"
        && (!quarter || vf(m, "Last Quarter Mailed") !== quarter)
        && (!interest || vf(m, "Interests") === interest)
        && (!lake || vf(m, "Preferred Lake") === lake));
      jsonResp(res, 200, {
        quarter, interest, lake,
        subscribed: all.filter(m => vf(m, "Status") === "Subscribed").length,
        alreadyMailed: quarter ? all.filter(m => vf(m, "Status") === "Subscribed" && vf(m, "Last Quarter Mailed") === quarter).length : 0,
        count: recipients.length,
        recipients: recipients.map(m => ({
          id: m.id, name: `${vf(m, "First Name")} ${vf(m, "Last Name")}`.trim(), email: vf(m, "Email"),
          interests: vf(m, "Interests"), lake: vf(m, "Preferred Lake"), lastQuarter: vf(m, "Last Quarter Mailed"),
        })),
      });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: String((e && e.message) || e) });
      return true;
    }
  }

  return false;
}
