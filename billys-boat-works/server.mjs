/**
 * BillysBoatWorks — custom API.
 * Three audiences, three sets of endpoints:
 *   /api/bbw/market/*     consumer marketplace (destination search, availability, pricing)
 *   /api/bbw/ops/*        franchise operations console
 *   /api/bbw/corp/*       corporate network management
 * Server-side aggregation only (may walk pages); the client never loads >25 rows.
 */
export const appId = "billys-boat-works";
export const apiPrefix = "/api/bbw";
export const kapp = "billys";

// Aggregations here scan thousands of submissions. Cache briefly and de-dupe
// concurrent callers so a dashboard refresh can't stampede the platform.
const CACHE = new Map();
const INFLIGHT = new Map();
const TTL_MS = 5 * 60 * 1000;
async function cached(key, fn, bypass) {
  if (bypass) CACHE.delete(key);
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  const p = (async () => {
    try { const value = await fn(); CACHE.set(key, { at: Date.now(), value }); return value; }
    finally { INFLIGHT.delete(key); }
  })();
  INFLIGHT.set(key, p);
  return p;
}

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, jsonResp } = helpers;
  const KAPP = kapp;
  // ALWAYS wrap collectByQuery so kapp is the first arg (see apps/CLAUDE.md).
  const collect = (form, kql, maxPages = 400) => collectByQuery(KAPP, form, kql, auth, maxPages);
  const vf = (s, f) => (s?.values?.[f] ?? "");
  const num = (x) => { const n = parseFloat(x); return isNaN(n) ? 0 : n; };
  const avg = (a) => (a.length ? a.reduce((s, n) => s + n, 0) / a.length : 0);
  const r2 = (n) => Math.round(n * 100) / 100;
  const uniq = (a) => [...new Set(a.filter(Boolean))].sort((x, y) => x.localeCompare(y));
  const today = () => new Date().toISOString().slice(0, 10);
  const url = new URL(req.url, "http://localhost");
  const qp = (k, d = "") => url.searchParams.get(k) || d;
  const ok = (data) => { jsonResp(res, 200, data); return true; };
  const err = (e) => { jsonResp(res, 500, { error: String((e && e.message) || e) }); return true; };

  const ACTIVE_RES = ["Confirmed", "Waiver Required", "Ready for Pickup", "Checked In",
    "Safety Briefing Complete", "Equipment Released", "Active Rental", "Returning", "Returned", "Inspection", "Completed"];
  const ON_WATER = ["Equipment Released", "Active Rental", "Returning"];
  const CANCELLED = ["Customer Cancelled", "Operator Cancelled", "Weather Cancelled", "No Show"];

  try {
    /* ══════════════ CONSUMER MARKETPLACE ══════════════ */

    // Destination cards for the home page — what can I rent, and where?
    if (pathname === "/api/bbw/market/destinations") {
      return ok(await cached("market:dest", async () => {
        const [dests, locs, cats, assets, reviews] = await Promise.all([
          collect("destinations"), collect("locations"), collect("equipment-categories"),
          collect("assets"), collect("reviews"),
        ]);
        const byDest = {};
        for (const l of locs) {
          const d = vf(l, "Destination"); if (!d) continue;
          (byDest[d] = byDest[d] || { locations: [], assets: 0 }).locations.push(vf(l, "Location Name"));
        }
        for (const a of assets) {
          const l = locs.find(x => vf(x, "Location Name") === vf(a, "Location"));
          const d = l && vf(l, "Destination");
          if (d && byDest[d]) byDest[d].assets++;
        }
        const ratingByDest = {};
        for (const r of reviews) {
          const d = vf(r, "Destination"); const n = num(vf(r, "Rating"));
          if (d && n) (ratingByDest[d] = ratingByDest[d] || []).push(n);
        }
        const catByDest = {};
        for (const a of assets) {
          const l = locs.find(x => vf(x, "Location Name") === vf(a, "Location"));
          const d = l && vf(l, "Destination");
          if (d) (catByDest[d] = catByDest[d] || new Set()).add(vf(a, "Category"));
        }
        return {
          destinations: dests.map(d => {
            const name = vf(d, "Destination Name");
            const e = byDest[name] || { locations: [], assets: 0 };
            return {
              name, state: vf(d, "State"), region: vf(d, "Region"), type: vf(d, "Destination Type"),
              city: vf(d, "Nearest City"), acres: num(vf(d, "Surface Acres")),
              description: vf(d, "Description"), popularity: num(vf(d, "Popularity Score")),
              locations: e.locations.length, assets: e.assets,
              categories: [...(catByDest[name] || [])].sort(),
              rating: r2(avg(ratingByDest[name] || [])), reviews: (ratingByDest[name] || []).length,
            };
          }).sort((a, b) => b.popularity - a.popularity || b.assets - a.assets),
          categories: uniq(cats.map(c => vf(c, "Category Name"))),
        };
      }));
    }

    // Availability search — the heart of the consumer flow.
    // Honours existing bookings, maintenance blocks, weather holds and operating season.
    if (pathname === "/api/bbw/market/availability") {
      const dest = qp("destination"), date = qp("date") || today(), duration = qp("duration", "Full Day");
      const key = `avail:${dest}:${date}:${duration}`;
      return ok(await cached(key, async () => {
        const [locs, assets, cats, res, wo, wx, reviews] = await Promise.all([
          collect("locations", dest ? `values[Destination]="${dest}"` : ""),
          collect("assets"), collect("equipment-categories"),
          collect("reservations", `values[Start Date]="${date}"`),
          collect("maintenance-orders"), collect("weather-events"), collect("reviews"),
        ]);
        const locNames = new Set(locs.filter(l => vf(l, "Status") === "Active").map(l => vf(l, "Location Name")));
        const closed = locs.filter(l => vf(l, "Status") !== "Active").map(l => vf(l, "Location Name"));
        // assets already spoken for that day
        const taken = new Set(res.filter(r => !CANCELLED.includes(vf(r, "Status"))).map(r => vf(r, "Asset")));
        // assets pulled by an open work order that blocks rentals
        const blocked = new Set(wo.filter(w => vf(w, "Blocks Reservations") === "Yes"
          && !["Complete", "Cancelled"].includes(vf(w, "Status"))).map(w => vf(w, "Asset")));
        const holds = wx.filter(w => vf(w, "Status") === "Active"
          && ["Pause Bookings", "Cancel Rentals", "Close Location"].includes(vf(w, "Recommended Action")))
          .map(w => ({ destination: vf(w, "Destination"), type: vf(w, "Weather Type"), severity: vf(w, "Severity"), action: vf(w, "Recommended Action") }));

        const ratingByCat = {};
        for (const r of reviews) {
          const c = vf(r, "Category"), n = num(vf(r, "Rating"));
          if (c && n) (ratingByCat[c] = ratingByCat[c] || []).push(n);
        }
        const rateField = { "Hourly": "Hourly Rate", "Half Day": "Half Day Rate", "Full Day": "Full Day Rate", "Multi-Day": "Daily Rate", "Weekly": "Weekly Rate" }[duration] || "Full Day Rate";
        const dow = new Date(date + "T00:00:00Z").getUTCDay();
        const mo = +date.slice(5, 7);
        const groups = {};
        for (const a of assets) {
          if (!locNames.has(vf(a, "Location"))) continue;
          const cat = vf(a, "Category");
          const g = (groups[cat] = groups[cat] || { category: cat, total: 0, available: 0, locations: new Set(), sample: null });
          g.total++;
          const free = vf(a, "Status") === "Available" && !taken.has(vf(a, "Asset Name")) && !blocked.has(vf(a, "Asset Name"));
          if (free) { g.available++; g.locations.add(vf(a, "Location")); if (!g.sample) g.sample = a; }
        }
        const results = Object.values(groups).filter(g => g.total).map(g => {
          const c = cats.find(x => vf(x, "Category Name") === g.category);
          const base = num(vf(c, rateField));
          // same adjustment ladder the pricing rules describe, so the quote is explainable
          const lines = [{ label: `${g.category} — ${duration}`, amount: base }];
          let price = base;
          if (dow === 0 || dow === 6) { const a = Math.round(price * 0.15); lines.push({ label: "Weekend premium (15%)", amount: a }); price += a; }
          if (mo === 7 || (mo === 8 && +date.slice(8, 10) <= 20)) { const a = Math.round(price * 0.10); lines.push({ label: "Peak season (10%)", amount: a }); price += a; }
          if (mo === 9 || mo === 10) { const a = -Math.round(price * 0.15); lines.push({ label: "Shoulder season (-15%)", amount: a }); price += a; }
          if (mo === 5) { const a = -Math.round(price * 0.10); lines.push({ label: "Spring launch (-10%)", amount: a }); price += a; }
          return {
            category: g.category, class: vf(c, "Equipment Class"), capacity: num(vf(c, "Capacity")),
            requiresLicense: vf(c, "Requires License") === "Yes", requiresBriefing: vf(c, "Requires Briefing") === "Yes",
            minimumAge: num(vf(c, "Minimum Age")), deposit: num(vf(c, "Security Deposit")),
            description: vf(c, "Description"),
            available: g.available, fleet: g.total, locations: [...g.locations].sort(),
            price: Math.round(price), priceLines: lines,
            rating: r2(avg(ratingByCat[g.category] || [])), reviews: (ratingByCat[g.category] || []).length,
          };
        }).sort((a, b) => (b.available > 0) - (a.available > 0) || b.price - a.price);
        return { destination: dest, date, duration, results, weatherHolds: holds, closedLocations: closed,
          locations: locs.map(l => ({ name: vf(l, "Location Name"), type: vf(l, "Location Type"), city: vf(l, "City"), status: vf(l, "Status"), hours: `${vf(l, "Hours Open")}–${vf(l, "Hours Close")}` })) };
      }));
    }

    // Quote a specific booking — every number explainable before the customer pays.
    if (pathname === "/api/bbw/market/quote") {
      const dest = qp("destination"), date = qp("date") || today();
      const duration = qp("duration", "Full Day"), category = qp("category");
      const accessories = qp("accessories").split(",").filter(Boolean);
      const tier = qp("protection", "None");
      const [cats, plans] = await Promise.all([collect("equipment-categories"), collect("protection-plans")]);
      const c = cats.find(x => vf(x, "Category Name") === category);
      if (!c) return ok({ error: "Unknown category" });
      const rateField = { "Hourly": "Hourly Rate", "Half Day": "Half Day Rate", "Full Day": "Full Day Rate", "Multi-Day": "Daily Rate", "Weekly": "Weekly Rate" }[duration] || "Full Day Rate";
      const dow = new Date(date + "T00:00:00Z").getUTCDay(), mo = +date.slice(5, 7);
      let base = num(vf(c, rateField));
      const lines = [{ label: `${category} — ${duration}`, amount: base, kind: "base" }];
      let price = base;
      if (dow === 0 || dow === 6) { const a = Math.round(price * 0.15); lines.push({ label: "Weekend premium (15%)", amount: a, kind: "adjust" }); price += a; }
      if (mo === 7 || (mo === 8 && +date.slice(8, 10) <= 20)) { const a = Math.round(price * 0.10); lines.push({ label: "Peak season (10%)", amount: a, kind: "adjust" }); price += a; }
      if (mo === 9 || mo === 10) { const a = -Math.round(price * 0.15); lines.push({ label: "Shoulder season discount (-15%)", amount: a, kind: "adjust" }); price += a; }
      if (mo === 5) { const a = -Math.round(price * 0.10); lines.push({ label: "Spring launch discount (-10%)", amount: a, kind: "adjust" }); price += a; }
      let accTotal = 0;
      for (const acc of accessories) {
        const ac = cats.find(x => vf(x, "Category Name") === acc);
        const amt = ac ? num(vf(ac, "Half Day Rate")) : 0;
        accTotal += amt; lines.push({ label: acc, amount: amt, kind: "accessory" });
      }
      const plan = plans.find(p => vf(p, "Tier") === tier) || plans.find(p => vf(p, "Tier") === "None");
      const protFee = tier === "None" ? 0 : Math.round(price * (num(vf(plan, "Percent Premium")) / 100));
      if (protFee) lines.push({ label: `${vf(plan, "Plan Name")} (${vf(plan, "Percent Premium")}%)`, amount: protFee, kind: "protection" });
      const sub = price + accTotal + protFee;
      const fees = Math.round(sub * 0.06); lines.push({ label: "Service & cleaning fee (6%)", amount: fees, kind: "fee" });
      const tax = Math.round((sub + fees) * 0.0775); lines.push({ label: "Sales tax (7.75%)", amount: tax, kind: "fee" });
      return ok({
        category, destination: dest, date, duration, lines,
        subtotal: sub, fees, tax, total: sub + fees + tax,
        deposit: num(vf(c, "Security Deposit")),
        protection: { tier, name: vf(plan, "Plan Name"), deductible: num(vf(plan, "Deductible")),
          coverage: num(vf(plan, "Coverage Limit")), provider: vf(plan, "Provider"), description: vf(plan, "Description") },
        requiresBriefing: vf(c, "Requires Briefing") === "Yes", requiresLicense: vf(c, "Requires License") === "Yes",
      });
    }

    if (pathname === "/api/bbw/market/plans") {
      const [plans, cats] = await Promise.all([collect("protection-plans"), collect("equipment-categories")]);
      return ok({
        plans: plans.map(p => ({ tier: vf(p, "Tier"), name: vf(p, "Plan Name"), provider: vf(p, "Provider"),
          coverage: num(vf(p, "Coverage Limit")), deductible: num(vf(p, "Deductible")),
          percent: num(vf(p, "Percent Premium")), description: vf(p, "Description") })),
        accessories: cats.filter(c => vf(c, "Tracking Mode") === "Quantity" && vf(c, "Category Name") !== "Life Jacket")
          .map(c => ({ name: vf(c, "Category Name"), price: num(vf(c, "Half Day Rate")), class: vf(c, "Equipment Class") })),
      });
    }

    /* ══════════════ FRANCHISE OPERATIONS ══════════════ */

    // "What do I need to deal with right now?" — the operational answer, not a chart wall.
    if (pathname === "/api/bbw/ops/today") {
      const fr = qp("franchise");
      return ok(await cached(`ops:today:${fr}`, async () => {
        const q = fr ? `values[Franchise]="${fr}"` : "";
        const [res, assets, wo, dmg, wx, locs, reviews] = await Promise.all([
          collect("reservations", q), collect("assets", q), collect("maintenance-orders", q),
          collect("damage-reports", q), collect("weather-events"), collect("locations", q), collect("reviews", q),
        ]);
        const t = today();
        const todays = res.filter(r => vf(r, "Start Date") === t);
        const going = todays.filter(r => !CANCELLED.includes(vf(r, "Status")));
        const returning = res.filter(r => vf(r, "End Date") === t && ON_WATER.includes(vf(r, "Status")));
        const overdue = res.filter(r => ON_WATER.includes(vf(r, "Status")) && vf(r, "End Date") < t);
        const onWater = res.filter(r => ON_WATER.includes(vf(r, "Status")));
        const cleaning = assets.filter(a => vf(a, "Status") === "Cleaning");
        const inMaint = assets.filter(a => vf(a, "Status") === "Maintenance" || vf(a, "Status") === "Out of Service");
        const openWO = wo.filter(w => !["Complete", "Cancelled"].includes(vf(w, "Status")));
        const urgentWO = openWO.filter(w => ["Urgent", "High"].includes(vf(w, "Priority")));
        const openDmg = dmg.filter(d => ["New", "Under Review"].includes(vf(d, "Status")));
        const rentable = assets.filter(a => vf(a, "Status") === "Available").length;
        const expected = going.reduce((s, r) => s + num(vf(r, "Total")), 0);
        const utilization = assets.length ? Math.round(100 * going.length / assets.length) : 0;
        const activeWx = wx.filter(w => vf(w, "Status") === "Active"
          && locs.some(l => vf(l, "Destination") === vf(w, "Destination")));
        const needsWaiver = res.filter(r => vf(r, "Start Date") >= t && vf(r, "Waiver Signed") === "No"
          && !CANCELLED.includes(vf(r, "Status")));
        const unpaid = res.filter(r => num(vf(r, "Balance Due")) > 0 && !CANCELLED.includes(vf(r, "Status")));
        const badReviews = reviews.filter(r => num(vf(r, "Rating")) <= 2 && vf(r, "Status") !== "Responded");

        // the action queue — ordered by what actually hurts if ignored
        const queue = [];
        overdue.forEach(r => queue.push({ severity: "critical", kind: "Overdue return",
          title: `${vf(r, "Asset")} is overdue`, detail: `${vf(r, "Customer Name")} · due ${vf(r, "End Date")} ${vf(r, "End Time")}`,
          ref: vf(r, "Confirmation Code"), link: "reservation" }));
        activeWx.forEach(w => queue.push({ severity: "critical", kind: "Weather",
          title: `${vf(w, "Weather Type")} ${vf(w, "Severity")} — ${vf(w, "Destination")}`,
          detail: `Recommended: ${vf(w, "Recommended Action")} · ${vf(w, "Reservations Affected")} reservations affected — awaiting your decision`,
          ref: vf(w, "Event ID"), link: "weather" }));
        urgentWO.forEach(w => queue.push({ severity: "high", kind: "Maintenance",
          title: `${vf(w, "Asset")} — ${vf(w, "Maintenance Type")}`,
          detail: `${vf(w, "Priority")} priority · ${vf(w, "Status")}${vf(w, "Blocks Reservations") === "Yes" ? " · blocks rentals" : ""}`,
          ref: vf(w, "Work Order ID"), link: "maintenance" }));
        openDmg.forEach(d => queue.push({ severity: vf(d, "Severity") === "Unsafe" ? "critical" : "high", kind: "Damage",
          title: `${vf(d, "Asset")} — ${vf(d, "Severity")} damage`,
          detail: `${vf(d, "Damage Area")} · est. $${vf(d, "Estimated Cost")} · ${vf(d, "Status")}`,
          ref: vf(d, "Damage ID"), link: "damage" }));
        needsWaiver.slice(0, 10).forEach(r => queue.push({ severity: "normal", kind: "Waiver",
          title: `${vf(r, "Customer Name")} has not signed`, detail: `${vf(r, "Category")} · ${vf(r, "Start Date")} ${vf(r, "Start Time")}`,
          ref: vf(r, "Confirmation Code"), link: "reservation" }));
        unpaid.slice(0, 10).forEach(r => queue.push({ severity: "normal", kind: "Payment",
          title: `${vf(r, "Customer Name")} owes $${vf(r, "Balance Due")}`, detail: `${vf(r, "Category")} · ${vf(r, "Start Date")}`,
          ref: vf(r, "Confirmation Code"), link: "reservation" }));
        badReviews.slice(0, 5).forEach(r => queue.push({ severity: "normal", kind: "Review",
          title: `${vf(r, "Rating")}★ from ${vf(r, "Customer Name")}`, detail: vf(r, "Comment").slice(0, 90),
          ref: vf(r, "Review ID"), link: "review" }));
        const rank = { critical: 0, high: 1, normal: 2 };
        queue.sort((a, b) => rank[a.severity] - rank[b.severity]);

        const line = (r) => ({ code: vf(r, "Confirmation Code"), customer: vf(r, "Customer Name"),
          phone: vf(r, "Customer Phone"), category: vf(r, "Category"), asset: vf(r, "Asset"),
          location: vf(r, "Location"), start: vf(r, "Start Time"), end: vf(r, "End Time"),
          party: vf(r, "Party Size"), total: num(vf(r, "Total")), status: vf(r, "Status"),
          waiver: vf(r, "Waiver Signed"), balance: num(vf(r, "Balance Due")), protection: vf(r, "Protection Plan") });

        return {
          date: t,
          counts: { goingOut: going.length, returning: returning.length, onWater: onWater.length,
            overdue: overdue.length, unavailable: inMaint.length, cleaning: cleaning.length,
            openWorkOrders: openWO.length, openDamage: openDmg.length, rentable, fleet: assets.length,
            expectedRevenue: Math.round(expected), utilization, needsWaiver: needsWaiver.length, unpaid: unpaid.length },
          queue: queue.slice(0, 40),
          pickups: going.sort((a, b) => vf(a, "Start Time").localeCompare(vf(b, "Start Time"))).map(line),
          returns: returning.sort((a, b) => vf(a, "End Time").localeCompare(vf(b, "End Time"))).map(line),
          overdue: overdue.map(line),
          // A boat is returnable the moment it is released — customers come back early,
          // and a multi-day rental is out for days before its due date. Keying the return
          // queue off "due exactly today" hid every one of them from the dock.
          onWater: onWater
            .sort((a, b) => (vf(a, "End Date") + vf(a, "End Time")).localeCompare(vf(b, "End Date") + vf(b, "End Time")))
            .map(r => ({ ...line(r), start: vf(r, "Start Date"), due: vf(r, "End Date"),
              dueState: vf(r, "End Date") < t ? "overdue" : vf(r, "End Date") === t ? "today" : "later" })),
          weather: activeWx.map(w => ({ id: vf(w, "Event ID"), destination: vf(w, "Destination"),
            type: vf(w, "Weather Type"), severity: vf(w, "Severity"), action: vf(w, "Recommended Action"),
            affected: num(vf(w, "Reservations Affected")), atRisk: num(vf(w, "Revenue At Risk")),
            starts: vf(w, "Starts At"), ends: vf(w, "Ends At") })),
        };
      }, qp("fresh") === "1"));
    }

    // Fleet board — asset rows against hour columns for one day.
    if (pathname === "/api/bbw/ops/fleetboard") {
      const fr = qp("franchise"), loc = qp("location"), date = qp("date") || today();
      const key = `ops:board:${fr}:${loc}:${date}`;
      return ok(await cached(key, async () => {
        const filt = [fr && `values[Franchise]="${fr}"`, loc && `values[Location]="${loc}"`].filter(Boolean).join(" AND ");
        const [assets, res, wo] = await Promise.all([
          collect("assets", filt),
          collect("reservations", [filt, `values[Start Date]="${date}"`].filter(Boolean).join(" AND ")),
          collect("maintenance-orders", filt),
        ]);
        const HOURS = [8, 10, 12, 14, 16, 18];
        const blocking = wo.filter(w => vf(w, "Blocks Reservations") === "Yes" && !["Complete", "Cancelled"].includes(vf(w, "Status")));
        const rows = assets.map(a => {
          const name = vf(a, "Asset Name");
          const mine = res.filter(r => vf(r, "Asset") === name && !CANCELLED.includes(vf(r, "Status")));
          const svc = blocking.find(w => vf(w, "Asset") === name);
          const cells = HOURS.map(h => {
            if (svc) return { state: "service", label: vf(svc, "Maintenance Type") };
            const hit = mine.find(r => {
              const s = +vf(r, "Start Time").slice(0, 2), e = +vf(r, "End Time").slice(0, 2);
              return h >= s && h < e;
            });
            if (hit) return { state: ON_WATER.includes(vf(hit, "Status")) ? "out" : "booked",
              label: vf(hit, "Customer Name").split(" ").slice(-1)[0], code: vf(hit, "Confirmation Code") };
            if (vf(a, "Status") === "Cleaning") return { state: "cleaning", label: "Clean" };
            return { state: "open", label: "" };
          });
          return { asset: name, tag: vf(a, "Asset Tag"), category: vf(a, "Category"),
            location: vf(a, "Location"), status: vf(a, "Status"), cells,
            booked: mine.length, revenue: mine.reduce((s, r) => s + num(vf(r, "Total")), 0) };
        }).sort((a, b) => a.category.localeCompare(b.category) || a.asset.localeCompare(b.asset));
        const slots = rows.length * HOURS.length;
        const used = rows.reduce((s, r) => s + r.cells.filter(c => c.state === "booked" || c.state === "out").length, 0);
        return { date, hours: HOURS, rows, utilization: slots ? Math.round(100 * used / slots) : 0 };
      }));
    }

    // One reservation with everything hanging off it — the ops detail view.
    if (pathname === "/api/bbw/ops/reservation") {
      const code = qp("code");
      if (!code) return ok({ error: "code required" });
      const [res] = await Promise.all([collect("reservations", `values[Confirmation Code]="${code}"`)]);
      const r = res[0];
      if (!r) return ok({ error: "not found" });
      const id = vf(r, "Reservation ID");
      const [items, pays, wv, insp, dmg, revs, notes] = await Promise.all([
        collect("reservation-items", `values[Reservation]="${id}"`),
        collect("payments", `values[Reservation]="${id}"`),
        collect("waivers", `values[Reservation]="${id}"`),
        collect("inspections", `values[Reservation]="${id}"`),
        collect("damage-reports", `values[Reservation]="${id}"`),
        collect("reviews", `values[Reservation]="${id}"`),
        collect("notifications", `values[Reservation]="${id}"`),
      ]);
      const flat = (s, fields) => Object.fromEntries(fields.map(f => [f, vf(s, f)]));
      return ok({
        reservation: r.values, submissionId: r.id,
        items: items.map(i => flat(i, ["Item Type", "Description", "Quantity", "Unit Price", "Line Total"])),
        payments: pays.map(p => flat(p, ["Payment ID", "Payment Type", "Method", "Amount", "Status", "Processed At", "Royalty Amount", "Franchise Net", "Provider Reference"])),
        waivers: wv.map(w => flat(w, ["Document Type", "Document Version", "Signature Name", "Signed At", "IP Address", "Status"])),
        inspections: insp.map(i => flat(i, ["Inspection Type", "Inspector", "Inspected At", "Fuel Level", "Condition", "Photos Count", "Passed", "Issues Found"])),
        damage: dmg.map(d => flat(d, ["Damage ID", "Severity", "Damage Area", "Estimated Cost", "Customer Responsible", "Status"])),
        reviews: revs.map(v2 => flat(v2, ["Rating", "Equipment Rating", "Staff Rating", "Value Rating", "Comment", "Submitted At"])),
        notifications: notes.map(n => flat(n, ["Channel", "Template", "Subject", "Status", "Sent At"])),
      });
    }

    // Candidate hulls for a category-level booking. A marketplace reservation names a
    // category, not a hull — the dock assigns the exact asset at check-in.
    if (pathname === "/api/bbw/ops/assign" && req.method === "GET") {
      const code = qp("code");
      const found = await collect("reservations", `values[Confirmation Code]="${code}"`);
      const r = found[0];
      if (!r) return ok({ error: "not found" });
      const loc = vf(r, "Location"), cat = vf(r, "Category"), date = vf(r, "Start Date");
      const [assets, sameDay, wo] = await Promise.all([
        collect("assets", `values[Location]="${loc}" AND values[Category]="${cat}"`),
        collect("reservations", `values[Location]="${loc}" AND values[Start Date]="${date}"`),
        collect("maintenance-orders", `values[Location]="${loc}"`),
      ]);
      const taken = new Set(sameDay
        .filter(x => vf(x, "Confirmation Code") !== code && !CANCELLED.includes(vf(x, "Status")))
        .map(x => vf(x, "Asset")).filter(Boolean));
      const blocked = new Set(wo.filter(w => vf(w, "Blocks Reservations") === "Yes"
        && !["Complete", "Cancelled"].includes(vf(w, "Status"))).map(w => vf(w, "Asset")));
      const candidates = assets.map(a => {
        const name = vf(a, "Asset Name");
        const reasons = [];
        if (vf(a, "Status") !== "Available") reasons.push(vf(a, "Status").toLowerCase());
        if (taken.has(name)) reasons.push("booked today");
        if (blocked.has(name)) reasons.push("work order");
        return { asset: name, tag: vf(a, "Asset Tag"), condition: vf(a, "Condition"),
          fuel: vf(a, "Fuel Level"), engineHours: num(vf(a, "Engine Hours")),
          year: vf(a, "Model Year"), make: `${vf(a, "Manufacturer")} ${vf(a, "Model")}`,
          submissionId: a.id, eligible: reasons.length === 0, reasons };
      }).sort((a, b) => (b.eligible - a.eligible) || a.engineHours - b.engineHours);
      return ok({ code, category: cat, location: loc, date,
        assigned: vf(r, "Asset"), candidates });
    }

    // Asset economics — "should I buy another one?"
    if (pathname === "/api/bbw/ops/assets") {
      const fr = qp("franchise");
      return ok(await cached(`ops:assets:${fr}`, async () => {
        const q = fr ? `values[Franchise]="${fr}"` : "";
        const [assets, res, wo, dmg] = await Promise.all([
          collect("assets", q), collect("reservations", q), collect("maintenance-orders", q), collect("damage-reports", q),
        ]);
        const byAsset = {};
        for (const r of res) {
          if (CANCELLED.includes(vf(r, "Status"))) continue;
          const a = vf(r, "Asset"); if (!a) continue;
          const e = (byAsset[a] = byAsset[a] || { rentals: 0, revenue: 0, days: 0 });
          e.rentals++; e.revenue += num(vf(r, "Total"));
          e.days += vf(r, "Duration Type") === "Weekly" ? 7 : vf(r, "Duration Type") === "Multi-Day" ? 3 : 1;
        }
        const maintByAsset = {}, dmgByAsset = {};
        for (const w of wo) maintByAsset[vf(w, "Asset")] = (maintByAsset[vf(w, "Asset")] || 0) + num(vf(w, "Total Cost"));
        for (const d of dmg) dmgByAsset[vf(d, "Asset")] = (dmgByAsset[vf(d, "Asset")] || 0) + 1;
        const rows = assets.map(a => {
          const name = vf(a, "Asset Name");
          const e = byAsset[name] || { rentals: 0, revenue: 0, days: 0 };
          const availDays = num(vf(a, "Days Available")) || 150;
          const cost = num(vf(a, "Purchase Price"));
          const maint = maintByAsset[name] || 0;
          const net = e.revenue - maint;
          return { asset: name, tag: vf(a, "Asset Tag"), category: vf(a, "Category"), class: vf(a, "Equipment Class"),
            location: vf(a, "Location"), franchise: vf(a, "Franchise"), year: vf(a, "Model Year"),
            make: `${vf(a, "Manufacturer")} ${vf(a, "Model")}`, status: vf(a, "Status"), condition: vf(a, "Condition"),
            engineHours: num(vf(a, "Engine Hours")), purchase: cost, value: num(vf(a, "Current Value")),
            rentals: e.rentals, revenue: Math.round(e.revenue), maintenance: Math.round(maint),
            damageCount: dmgByAsset[name] || 0, daysRented: e.days, daysAvailable: availDays,
            utilization: availDays ? Math.round(100 * e.days / availDays) : 0,
            revPerDay: availDays ? r2(e.revenue / availDays) : 0,
            roi: cost ? Math.round(100 * net / cost) : 0,
            paybackSeasons: cost && net > 0 ? r2(cost / net) : null };
        }).sort((a, b) => b.revPerDay - a.revPerDay);
        const byCategory = {};
        for (const r of rows) {
          const e = (byCategory[r.category] = byCategory[r.category] || { category: r.category, count: 0, revenue: 0, util: [], revPerDay: [] });
          e.count++; e.revenue += r.revenue; e.util.push(r.utilization); e.revPerDay.push(r.revPerDay);
        }
        return { rows,
          byCategory: Object.values(byCategory).map(e => ({ category: e.category, count: e.count,
            revenue: e.revenue, utilization: Math.round(avg(e.util)), revPerDay: r2(avg(e.revPerDay)) }))
            .sort((a, b) => b.revenue - a.revenue) };
      }));
    }

    // Fleet advice: where demand is outrunning supply.
    if (pathname === "/api/bbw/ops/advice") {
      const fr = qp("franchise");
      return ok(await cached(`ops:advice:${fr}`, async () => {
        const q = fr ? `values[Franchise]="${fr}"` : "";
        const [assets, res, wo, reviews] = await Promise.all([
          collect("assets", q), collect("reservations", q), collect("maintenance-orders", q), collect("reviews", q),
        ]);
        const t = today();
        const future = res.filter(r => vf(r, "Start Date") >= t && !CANCELLED.includes(vf(r, "Status")));
        const advice = [];
        // saturation by category on peak days
        const catFleet = {}, catBooked = {};
        for (const a of assets) catFleet[vf(a, "Category")] = (catFleet[vf(a, "Category")] || 0) + 1;
        const byDate = {};
        for (const r of future) {
          const d = vf(r, "Start Date"), c = vf(r, "Category");
          ((byDate[d] = byDate[d] || {})[c] = (byDate[d][c] || 0) + 1);
        }
        const peaks = [];
        for (const [d, cats] of Object.entries(byDate)) {
          const dow = new Date(d + "T00:00:00Z").getUTCDay();
          if (dow !== 0 && dow !== 6) continue;
          for (const [c, n] of Object.entries(cats)) {
            const fleet = catFleet[c] || 0;
            if (fleet && n / fleet >= 0.8) peaks.push({ date: d, category: c, booked: n, fleet, pct: Math.round(100 * n / fleet) });
          }
        }
        peaks.sort((a, b) => b.pct - a.pct || a.date.localeCompare(b.date));
        peaks.slice(0, 6).forEach(p => advice.push({ kind: "Capacity", severity: p.pct >= 100 ? "high" : "normal",
          title: `${p.category} is ${p.pct}% booked on ${p.date}`,
          detail: `${p.booked} of ${p.fleet} units already committed on a weekend. Every further request that day is turned away.`,
          action: p.pct >= 100 ? `Consider adding a ${p.category} to the fleet` : "Consider raising the weekend rate" }));
        // service due before the next booking
        const openWO = wo.filter(w => !["Complete", "Cancelled"].includes(vf(w, "Status")) && vf(w, "Blocks Reservations") === "Yes");
        for (const w of openWO.slice(0, 8)) {
          const next = future.filter(r => vf(r, "Asset") === vf(w, "Asset")).sort((a, b) => vf(a, "Start Date").localeCompare(vf(b, "Start Date")))[0];
          if (next) advice.push({ kind: "Maintenance", severity: "high",
            title: `${vf(w, "Asset")} needs service before ${vf(next, "Start Date")}`,
            detail: `${vf(w, "Maintenance Type")} (${vf(w, "Priority")}) is still ${vf(w, "Status")} and blocks rentals. Next booking is ${vf(next, "Confirmation Code")}.`,
            action: "Schedule the work order or reassign the reservation" });
        }
        // idle capital
        const idle = assets.filter(a => vf(a, "Status") === "Available")
          .map(a => ({ a, n: res.filter(r => vf(r, "Asset") === vf(a, "Asset Name") && !CANCELLED.includes(vf(r, "Status"))).length }))
          .filter(x => x.n <= 2).sort((a, b) => a.n - b.n).slice(0, 5);
        idle.forEach(x => advice.push({ kind: "Utilization", severity: "normal",
          title: `${vf(x.a, "Asset Name")} has only ${x.n} booking${x.n === 1 ? "" : "s"} this season`,
          detail: `${vf(x.a, "Category")} at ${vf(x.a, "Location")} · $${vf(x.a, "Current Value")} of capital sitting idle.`,
          action: "Move to a busier location, discount midweek, or consider selling" }));
        const bad = reviews.filter(r => num(vf(r, "Rating")) <= 2);
        if (bad.length >= 3) advice.push({ kind: "Service", severity: "high",
          title: `${bad.length} reviews at 2★ or below`,
          detail: bad.slice(0, 3).map(r => `"${vf(r, "Comment").slice(0, 70)}"`).join(" · "),
          action: "Review check-in timing and pre-rental cleaning" });
        const rank = { high: 0, normal: 1 };
        advice.sort((a, b) => rank[a.severity] - rank[b.severity]);
        return { advice, peaks: peaks.slice(0, 12) };
      }));
    }

    if (pathname === "/api/bbw/ops/lookups") {
      return ok(await cached("ops:lookups", async () => {
        const [frs, locs, cats, assets] = await Promise.all([
          collect("franchises"), collect("locations"), collect("equipment-categories"), collect("assets"),
        ]);
        return {
          franchises: frs.map(f => ({ name: vf(f, "Franchise Name"), state: vf(f, "State"), status: vf(f, "Status") })),
          locations: locs.map(l => ({ name: vf(l, "Location Name"), franchise: vf(l, "Franchise"),
            destination: vf(l, "Destination"), type: vf(l, "Location Type"), status: vf(l, "Status") })),
          categories: uniq(cats.map(c => vf(c, "Category Name"))),
          assets: assets.map(a => ({ name: vf(a, "Asset Name"), tag: vf(a, "Asset Tag"), category: vf(a, "Category"),
            franchise: vf(a, "Franchise"), location: vf(a, "Location"), status: vf(a, "Status") })),
        };
      }));
    }

    // QR scan — everything about one asset, instantly.
    if (pathname === "/api/bbw/ops/asset") {
      const tag = qp("tag");
      const found = await collect("assets", `values[Asset Tag]="${tag}"`);
      const a = found[0];
      if (!a) return ok({ error: "Unknown asset tag" });
      const name = vf(a, "Asset Name");
      const [res, wo, insp, dmg] = await Promise.all([
        collect("reservations", `values[Asset]="${name}"`),
        collect("maintenance-orders", `values[Asset]="${name}"`),
        collect("inspections", `values[Asset]="${name}"`),
        collect("damage-reports", `values[Asset]="${name}"`),
      ]);
      const t = today();
      const current = res.find(r => ON_WATER.includes(vf(r, "Status")));
      const next = res.filter(r => vf(r, "Start Date") >= t && ["Confirmed", "Ready for Pickup", "Waiver Required"].includes(vf(r, "Status")))
        .sort((a2, b) => vf(a2, "Start Date").localeCompare(vf(b, "Start Date")))[0];
      const revenue = res.filter(r => vf(r, "Status") === "Completed").reduce((s, r) => s + num(vf(r, "Total")), 0);
      const maintCost = wo.reduce((s, w) => s + num(vf(w, "Total Cost")), 0);
      return ok({
        asset: a.values, submissionId: a.id,
        current: current ? { code: vf(current, "Confirmation Code"), customer: vf(current, "Customer Name"),
          phone: vf(current, "Customer Phone"), due: `${vf(current, "End Date")} ${vf(current, "End Time")}`, status: vf(current, "Status") } : null,
        next: next ? { code: vf(next, "Confirmation Code"), customer: vf(next, "Customer Name"),
          start: `${vf(next, "Start Date")} ${vf(next, "Start Time")}`, category: vf(next, "Category") } : null,
        economics: { rentals: res.filter(r => vf(r, "Status") === "Completed").length, revenue: Math.round(revenue),
          maintenance: Math.round(maintCost), net: Math.round(revenue - maintCost),
          purchase: num(vf(a, "Purchase Price")),
          roi: num(vf(a, "Purchase Price")) ? Math.round(100 * (revenue - maintCost) / num(vf(a, "Purchase Price"))) : 0 },
        openWorkOrders: wo.filter(w => !["Complete", "Cancelled"].includes(vf(w, "Status")))
          .map(w => ({ id: vf(w, "Work Order ID"), type: vf(w, "Maintenance Type"), priority: vf(w, "Priority"), status: vf(w, "Status") })),
        lastInspection: insp.sort((x, y) => vf(y, "Inspected At").localeCompare(vf(x, "Inspected At")))[0]?.values || null,
        damage: dmg.map(d => ({ id: vf(d, "Damage ID"), severity: vf(d, "Severity"), area: vf(d, "Damage Area"),
          cost: num(vf(d, "Estimated Cost")), status: vf(d, "Status"), at: vf(d, "Reported At") })),
      });
    }

    /* ══════════════ CORPORATE ══════════════ */

    if (pathname === "/api/bbw/corp/network") {
      return ok(await cached("corp:network", async () => {
        const [frs, locs, assets, res, revs, inc, wo, terr, pros, train, stmts, claims] = await Promise.all([
          collect("franchises"), collect("locations"), collect("assets"), collect("reservations"),
          collect("reviews"), collect("incidents"), collect("maintenance-orders"), collect("territories"),
          collect("franchise-prospects"), collect("training-records"), collect("royalty-statements"), collect("claims"),
        ]);
        const t = today();
        const live = res.filter(r => !CANCELLED.includes(vf(r, "Status")));
        const perF = {};
        for (const f of frs) {
          const name = vf(f, "Franchise Name");
          perF[name] = { franchise: name, id: vf(f, "Franchise ID"), owner: vf(f, "Owner Name"),
            state: vf(f, "State"), region: vf(f, "Region"), tier: vf(f, "Tier"), status: vf(f, "Status"),
            opened: vf(f, "Opened Date"), compliance: num(vf(f, "Compliance Score")),
            royaltyRate: num(vf(f, "Royalty Rate")),
            locations: 0, fleet: 0, reservations: 0, revenue: 0, upcoming: 0, ratings: [],
            incidents: 0, seriousIncidents: 0, openWO: 0, trainingDue: 0, claims: 0, refunds: 0 };
        }
        for (const l of locs) if (perF[vf(l, "Franchise")]) perF[vf(l, "Franchise")].locations++;
        for (const a of assets) if (perF[vf(a, "Franchise")]) perF[vf(a, "Franchise")].fleet++;
        for (const r of live) {
          const e = perF[vf(r, "Franchise")]; if (!e) continue;
          e.reservations++;
          if (vf(r, "Status") === "Completed") e.revenue += num(vf(r, "Total"));
          if (vf(r, "Start Date") >= t) e.upcoming++;
        }
        for (const r of res) if (CANCELLED.includes(vf(r, "Status")) && perF[vf(r, "Franchise")]) perF[vf(r, "Franchise")].refunds++;
        for (const r of revs) { const e = perF[vf(r, "Franchise")]; if (e && num(vf(r, "Rating"))) e.ratings.push(num(vf(r, "Rating"))); }
        for (const i of inc) { const e = perF[vf(i, "Franchise")]; if (!e) continue; e.incidents++; if (["Serious", "Critical"].includes(vf(i, "Severity"))) e.seriousIncidents++; }
        for (const w of wo) { const e = perF[vf(w, "Franchise")]; if (e && !["Complete", "Cancelled"].includes(vf(w, "Status"))) e.openWO++; }
        for (const r of train) { const e = perF[vf(r, "Franchise")]; if (e && ["Overdue", "Expired"].includes(vf(r, "Status"))) e.trainingDue++; }
        for (const c of claims) { const e = perF[vf(c, "Franchise")]; if (e) e.claims++; }

        const rows = Object.values(perF).map(e => ({
          ...e, revenue: Math.round(e.revenue),
          rating: r2(avg(e.ratings)), reviewCount: e.ratings.length,
          revenuePerAsset: e.fleet ? Math.round(e.revenue / e.fleet) : 0,
          royaltyDue: Math.round(e.revenue * (e.royaltyRate / 100)),
          ratings: undefined,
        })).sort((a, b) => b.revenue - a.revenue);
        rows.forEach((r, i) => r.rank = i + 1);

        // who needs attention, and why
        const attention = [];
        for (const r of rows) {
          const flags = [];
          if (r.seriousIncidents > 0) flags.push({ f: `${r.seriousIncidents} serious safety incident${r.seriousIncidents > 1 ? "s" : ""}`, w: 4 });
          if (r.compliance < 80) flags.push({ f: `compliance score ${r.compliance}`, w: 3 });
          if (r.trainingDue >= 4) flags.push({ f: `${r.trainingDue} training records overdue or expired`, w: 2 });
          if (r.rating && r.rating < 4) flags.push({ f: `customer rating ${r.rating.toFixed(1)}`, w: 3 });
          if (r.openWO >= 8) flags.push({ f: `${r.openWO} open work orders`, w: 2 });
          if (r.fleet && r.revenuePerAsset < 900) flags.push({ f: `$${r.revenuePerAsset} revenue per asset`, w: 2 });
          if (flags.length) attention.push({ franchise: r.franchise, owner: r.owner, state: r.state,
            score: flags.reduce((s, x) => s + x.w, 0), flags: flags.map(x => x.f) });
        }
        attention.sort((a, b) => b.score - a.score);

        const totals = {
          franchises: frs.length, operating: frs.filter(f => vf(f, "Status") === "Operating").length,
          onboarding: frs.filter(f => vf(f, "Status") === "Onboarding").length,
          locations: locs.length, fleet: assets.length, reservations: live.length,
          revenue: Math.round(rows.reduce((s, r) => s + r.revenue, 0)),
          royalties: Math.round(rows.reduce((s, r) => s + r.royaltyDue, 0)),
          platformFees: frs.filter(f => vf(f, "Status") === "Operating").length * 499 * 3,
          rating: r2(avg(revs.map(r => num(vf(r, "Rating"))).filter(Boolean))),
          incidents: inc.length, seriousIncidents: inc.filter(i => ["Serious", "Critical"].includes(vf(i, "Severity"))).length,
          claims: claims.length, claimsOpen: claims.filter(c => !["Paid", "Denied", "Closed"].includes(vf(c, "Status"))).length,
          territoriesAvailable: terr.filter(t2 => vf(t2, "Status") === "Available").length,
          territoriesSold: terr.filter(t2 => vf(t2, "Status") === "Sold").length,
          pipeline: pros.filter(p => vf(p, "Status") === "Active").length,
        };
        const byRegion = {};
        for (const r of rows) {
          const e = (byRegion[r.region] = byRegion[r.region] || { region: r.region, franchises: 0, fleet: 0, revenue: 0, ratings: [] });
          e.franchises++; e.fleet += r.fleet; e.revenue += r.revenue; if (r.rating) e.ratings.push(r.rating);
        }
        return { totals, rows, attention: attention.slice(0, 10),
          byRegion: Object.values(byRegion).map(e => ({ region: e.region, franchises: e.franchises,
            fleet: e.fleet, revenue: e.revenue, rating: r2(avg(e.ratings)) })).sort((a, b) => b.revenue - a.revenue),
          statements: stmts.map(s => ({ franchise: vf(s, "Franchise"), period: vf(s, "Period"),
            gross: num(vf(s, "Gross Revenue")), refunds: num(vf(s, "Refunds")), net: num(vf(s, "Net Revenue")),
            royalty: num(vf(s, "Royalty Amount")), marketing: num(vf(s, "Marketing Fee")),
            platform: num(vf(s, "Platform Fee")), insurance: num(vf(s, "Insurance Commission")),
            totalDue: num(vf(s, "Total Due")), franchiseNet: num(vf(s, "Franchise Net")),
            reservations: num(vf(s, "Reservation Count")), status: vf(s, "Status") }))
            .sort((a, b) => b.period.localeCompare(a.period) || b.gross - a.gross) };
      }));
    }

    // Franchise development: pipeline + territory opportunity.
    if (pathname === "/api/bbw/corp/development") {
      return ok(await cached("corp:dev", async () => {
        const [pros, terr, frs] = await Promise.all([
          collect("franchise-prospects"), collect("territories"), collect("franchises"),
        ]);
        const STAGES = ["Inquiry", "Qualification", "Application", "Territory Review", "Financial Review",
          "FDD Sent", "Agreement", "Deposit", "Equipment Selection", "Insurance", "Training",
          "Location Setup", "Launch Checklist", "Awarded", "Declined"];
        const byStage = STAGES.map(s => ({
          stage: s,
          prospects: pros.filter(p => vf(p, "Stage") === s).map(p => ({
            id: vf(p, "Prospect ID"), name: vf(p, "Prospect Name"), state: vf(p, "State"),
            territory: vf(p, "Desired Territory"), score: num(vf(p, "Qualification Score")),
            capital: num(vf(p, "Liquid Capital")), source: vf(p, "Source"),
            assigned: vf(p, "Assigned To"), lastActivity: vf(p, "Last Activity"), next: vf(p, "Next Step"),
          })).sort((a, b) => b.score - a.score),
        }));
        const openTerr = terr.filter(t => ["Available", "Expansion", "Reserved"].includes(vf(t, "Status")))
          .map(t => ({ name: vf(t, "Territory Name"), state: vf(t, "State"), county: vf(t, "County"),
            type: vf(t, "Territory Type"), population: num(vf(t, "Population")),
            boats: num(vf(t, "Boat Registrations")), tourism: num(vf(t, "Tourism Index")),
            score: num(vf(t, "Opportunity Score")), status: vf(t, "Status"), reservedFor: vf(t, "Reserved For") }))
          .sort((a, b) => b.score - a.score);
        const funnel = { inquiries: pros.length, active: pros.filter(p => vf(p, "Status") === "Active").length,
          awarded: pros.filter(p => vf(p, "Stage") === "Awarded").length,
          declined: pros.filter(p => vf(p, "Stage") === "Declined").length,
          avgScore: Math.round(avg(pros.filter(p => vf(p, "Status") === "Active").map(p => num(vf(p, "Qualification Score"))))),
          committedFees: pros.filter(p => vf(p, "Deposit Paid")).length * 25000 };
        const bySource = {};
        for (const p of pros) { const s = vf(p, "Source") || "—"; bySource[s] = (bySource[s] || 0) + 1; }
        return { byStage, territories: openTerr, funnel,
          bySource: Object.entries(bySource).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
          sold: terr.filter(t => vf(t, "Status") === "Sold").length, total: terr.length };
      }));
    }

    // Safety, claims and compliance across the network.
    if (pathname === "/api/bbw/corp/risk") {
      return ok(await cached("corp:risk", async () => {
        const [inc, claims, dmg, train, wo] = await Promise.all([
          collect("incidents"), collect("claims"), collect("damage-reports"),
          collect("training-records"), collect("maintenance-orders"),
        ]);
        const claimRows = claims.map(c => ({ id: vf(c, "Claim ID"), franchise: vf(c, "Franchise"),
          asset: vf(c, "Asset"), customer: vf(c, "Customer"), plan: vf(c, "Protection Plan"),
          provider: vf(c, "Provider"), number: vf(c, "Claim Number"), filed: vf(c, "Filed Date"),
          claimed: num(vf(c, "Amount Claimed")), deductible: num(vf(c, "Deductible")),
          approved: num(vf(c, "Amount Approved")), adjuster: vf(c, "Adjuster"), status: vf(c, "Status") }))
          .sort((a, b) => b.filed.localeCompare(a.filed));
        const incRows = inc.map(i => ({ id: vf(i, "Incident ID"), type: vf(i, "Incident Type"),
          severity: vf(i, "Severity"), franchise: vf(i, "Franchise"), location: vf(i, "Location"),
          occurred: vf(i, "Occurred At"), injuries: vf(i, "Injuries"),
          authorities: vf(i, "Authorities Notified"), regulatory: vf(i, "Regulatory Report"),
          reviewed: vf(i, "Corporate Reviewed"), status: vf(i, "Status") }))
          .sort((a, b) => { const rank = { Critical: 0, Serious: 1, Moderate: 2, Low: 3 };
            return rank[a.severity] - rank[b.severity] || b.occurred.localeCompare(a.occurred); });
        const trainByFr = {};
        for (const r of train) {
          const e = (trainByFr[vf(r, "Franchise")] = trainByFr[vf(r, "Franchise")] || { franchise: vf(r, "Franchise"), total: 0, complete: 0, overdue: 0, expired: 0 });
          e.total++;
          if (vf(r, "Status") === "Complete") e.complete++;
          if (vf(r, "Status") === "Overdue") e.overdue++;
          if (vf(r, "Status") === "Expired") e.expired++;
        }
        const dmgByFr = {};
        for (const d of dmg) {
          const e = (dmgByFr[vf(d, "Franchise")] = dmgByFr[vf(d, "Franchise")] || { franchise: vf(d, "Franchise"), count: 0, cost: 0, unsafe: 0 });
          e.count++; e.cost += num(vf(d, "Estimated Cost"));
          if (vf(d, "Severity") === "Unsafe") e.unsafe++;
        }
        return {
          totals: { incidents: inc.length, open: inc.filter(i => vf(i, "Status") !== "Closed").length,
            serious: inc.filter(i => ["Serious", "Critical"].includes(vf(i, "Severity"))).length,
            unreviewed: inc.filter(i => ["Serious", "Critical"].includes(vf(i, "Severity")) && vf(i, "Corporate Reviewed") !== "Yes").length,
            claims: claims.length, claimsOpen: claims.filter(c => !["Paid", "Denied", "Closed"].includes(vf(c, "Status"))).length,
            claimed: Math.round(claims.reduce((s, c) => s + num(vf(c, "Amount Claimed")), 0)),
            approved: Math.round(claims.reduce((s, c) => s + num(vf(c, "Amount Approved")), 0)),
            damage: dmg.length, damageCost: Math.round(dmg.reduce((s, d) => s + num(vf(d, "Estimated Cost")), 0)),
            trainingOverdue: train.filter(r => ["Overdue", "Expired"].includes(vf(r, "Status"))).length,
            maintenanceOpen: wo.filter(w => !["Complete", "Cancelled"].includes(vf(w, "Status"))).length },
          claims: claimRows, incidents: incRows,
          training: Object.values(trainByFr).map(e => ({ ...e, pct: e.total ? Math.round(100 * e.complete / e.total) : 0 }))
            .sort((a, b) => a.pct - b.pct),
          damage: Object.values(dmgByFr).map(e => ({ ...e, cost: Math.round(e.cost) })).sort((a, b) => b.cost - a.cost),
        };
      }));
    }

    // Global operational search — one box across the whole domain.
    if (pathname === "/api/bbw/search") {
      const term = qp("q", "").trim();
      if (term.length < 2) return ok({ results: [] });
      const esc2 = (s) => s.replace(/"/g, '\\"');
      const [cust, res, assets, frs, claims] = await Promise.all([
        collect("customers", `values[Last Name]="${esc2(term)}"`, 4).catch(() => []),
        collect("reservations", `values[Confirmation Code]="${esc2(term.toUpperCase())}"`, 4).catch(() => []),
        collect("assets", `values[Asset Tag]="${esc2(term.toUpperCase())}"`, 4).catch(() => []),
        collect("franchises", "", 4).catch(() => []),
        collect("claims", `values[Claim ID]="${esc2(term.toUpperCase())}"`, 4).catch(() => []),
      ]);
      const lower = term.toLowerCase();
      const results = [];
      cust.forEach(c => results.push({ kind: "Customer", title: `${vf(c, "First Name")} ${vf(c, "Last Name")}`,
        detail: `${vf(c, "Email")} · ${vf(c, "City")}, ${vf(c, "State")} · ${vf(c, "Rentals Count")} rentals`, ref: vf(c, "Customer ID") }));
      res.forEach(r => results.push({ kind: "Reservation", title: vf(r, "Confirmation Code"),
        detail: `${vf(r, "Customer Name")} · ${vf(r, "Category")} · ${vf(r, "Start Date")} · ${vf(r, "Status")}`, ref: vf(r, "Confirmation Code") }));
      assets.forEach(a => results.push({ kind: "Asset", title: `${vf(a, "Asset Name")} (${vf(a, "Asset Tag")})`,
        detail: `${vf(a, "Category")} · ${vf(a, "Location")} · ${vf(a, "Status")}`, ref: vf(a, "Asset Tag") }));
      claims.forEach(c => results.push({ kind: "Claim", title: vf(c, "Claim ID"),
        detail: `${vf(c, "Franchise")} · $${vf(c, "Amount Claimed")} · ${vf(c, "Status")}`, ref: vf(c, "Claim ID") }));
      frs.filter(f => vf(f, "Franchise Name").toLowerCase().includes(lower) || vf(f, "Owner Name").toLowerCase().includes(lower))
        .forEach(f => results.push({ kind: "Franchise", title: vf(f, "Franchise Name"),
          detail: `${vf(f, "Owner Name")} · ${vf(f, "State")} · ${vf(f, "Status")}`, ref: vf(f, "Franchise ID") }));
      return ok({ term, results: results.slice(0, 25) });
    }

    return false;
  } catch (e) {
    return err(e);
  }
}
