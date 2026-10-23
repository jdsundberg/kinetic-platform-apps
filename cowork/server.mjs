/**
 * Minnetonka Cowork — custom API handler.
 * Auto-mounted by base/server.mjs when it exports apiPrefix + handleAPI.
 *
 * Server-side work only (may walk pages of 25); the client never loads >25 rows itself.
 * Bookings and rentals are written through here so the double-booking check runs
 * next to the write instead of trusting the browser.
 */
export const appId = "cowork";
export const apiPrefix = "/api/cowork";
export const kapp = "cowork";

// ── state machines ──
// Room booking: Confirmed → Checked In → Completed; Cancelled / No Show are terminal and free the slot.
// Desk rental:  Reserved  → Active     → Completed; Cancelled is terminal and frees the desk.
// Whitelists of states that HOLD a resource — anything not listed never blocks.
export const ROOM_HOLDING = ["Confirmed", "Checked In", "Completed"];
export const DESK_HOLDING = ["Reserved", "Active", "Completed"];
const ROOM_STATUS = ["Confirmed", "Checked In", "Completed", "Cancelled", "No Show"];
const DESK_STATUS = ["Reserved", "Active", "Completed", "Cancelled"];
const RENTAL_TYPES = ["Day Pass", "Weekly", "Monthly"];
const OPEN = "07:00", CLOSE = "19:00";

// 5-min cache + in-flight dedup; booking/rental writes through this file bust it,
// other client writes call /invalidate, and availability checks always pass fresh=1.
const cache = new Map();          // key -> { at, data }
const inflight = new Map();       // key -> Promise
const TTL = 5 * 60 * 1000;

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { kineticRequest, jsonResp, readBody } = helpers;
  const url = new URL(req.url, "http://localhost");
  const qp = (k) => url.searchParams.get(k) || "";
  const fresh = qp("fresh") === "1";
  const vf = (s, f) => (s?.values?.[f] ?? "");
  const num = (x) => { const n = parseFloat(x); return isNaN(n) ? 0 : n; };
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const mins = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };

  // Walk a query with pageToken, 25 at a time (golden rule), server-side only.
  async function collect(form, q, orderBy, maxPages = 40) {
    const out = [];
    let token = null;
    for (let i = 0; i < maxPages; i++) {
      let p = `/kapps/${kapp}/forms/${form}/submissions?include=values&limit=25`;
      if (q) p += `&q=${encodeURIComponent(q)}`;
      if (orderBy) p += `&orderBy=${encodeURIComponent(orderBy)}`;
      if (token) p += `&pageToken=${encodeURIComponent(token)}`;
      const r = await kineticRequest("GET", p, null, auth);
      if (r.status >= 300) throw new Error(`${form} query failed (${r.status}): ${JSON.stringify(r.data).slice(0, 200)}`);
      out.push(...(r.data?.submissions || []));
      token = r.data?.nextPageToken;
      if (!token) break;
    }
    return out;
  }
  // scope cache entries to the target server + login so switching servers never serves stale data
  const scope = `${req.headers["x-kinetic-server"] || "default"}|${auth || ""}|`;
  async function cached(key, fn) {
    key = scope + key;
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < TTL) return hit.data;
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().then(data => { cache.set(key, { at: Date.now(), data }); return data; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  const bust = () => cache.clear();

  // ── shared loaders ──
  const loadRooms = () => cached("rooms", () => collect("rooms"));
  const loadDesks = () => cached("desks", () => collect("desks"));
  const loadMembers = () => cached("members", () => collect("members"));
  const bookingsOn = (date) => collect("room-bookings", `values[Booking Date]="${date}"`);
  // Rentals that end on/after `start` and begin on/before `end` — i.e. overlap [start, end].
  // One query per desk in parallel (compound index [Desk, End Date]) instead of walking
  // every rental serially — each desk only has a page or two ending after `start`.
  async function rentalsOverlapping(start, end) {
    const names = (await loadDesks()).map(d => vf(d, "Desk Name")).filter(Boolean);
    const perDesk = await Promise.all(names.map(n => collect("desk-rentals",
      `values[Desk]="${esc(n)}" AND values[End Date] >= "${start}"`, "values[End Date]")));
    return perDesk.flat().filter(r => vf(r, "Start Date") <= end);
  }
  const bookingRow = (b) => ({
    id: b.id, room: vf(b, "Room"), date: vf(b, "Booking Date"), start: vf(b, "Start Time"), end: vf(b, "End Time"),
    hours: vf(b, "Hours"), by: vf(b, "Booked By"), company: vf(b, "Company"), email: vf(b, "Email"),
    attendees: vf(b, "Attendees"), title: vf(b, "Meeting Title"), needsTv: vf(b, "Needs TV"),
    rate: vf(b, "Rate"), status: vf(b, "Status"), bookingId: vf(b, "Booking ID"),
  });
  const rentalRow = (r) => ({
    id: r.id, desk: vf(r, "Desk"), zone: vf(r, "Zone"), member: vf(r, "Member"), company: vf(r, "Company"),
    type: vf(r, "Rental Type"), start: vf(r, "Start Date"), end: vf(r, "End Date"), rate: vf(r, "Rate"),
    status: vf(r, "Status"), rentalId: vf(r, "Rental ID"),
  });
  const roomRow = (r) => ({
    id: r.id, name: vf(r, "Room Name"), capacity: num(vf(r, "Capacity")) || 6, tv: vf(r, "Has TV"),
    tvSize: vf(r, "TV Size"), vc: vf(r, "Video Conferencing"), whiteboard: vf(r, "Whiteboard"),
    rate: num(vf(r, "Hourly Rate")), location: vf(r, "Location"), status: vf(r, "Status"),
  });
  const deskRow = (d) => ({
    id: d.id, name: vf(d, "Desk Name"), zone: vf(d, "Zone"), features: vf(d, "Features"),
    day: num(vf(d, "Day Rate")), week: num(vf(d, "Week Rate")), month: num(vf(d, "Month Rate")), status: vf(d, "Status"),
  });
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

  try {
    // ════════ lookups for dropdowns ════════
    if (pathname === "/api/cowork/lookups" && req.method === "GET") {
      const [rooms, desks, members] = await Promise.all([loadRooms(), loadDesks(), loadMembers()]);
      jsonResp(res, 200, {
        rooms: rooms.map(roomRow).sort(byName),
        desks: desks.map(deskRow).sort(byName),
        members: members.map(m => ({
          name: vf(m, "Full Name"), company: vf(m, "Company"), email: vf(m, "Email"),
          plan: vf(m, "Plan"), status: vf(m, "Status"),
        })).sort((a, b) => a.name.localeCompare(b.name)),
        companies: [...new Set(members.map(m => vf(m, "Company")).filter(Boolean))].sort(),
      });
      return true;
    }

    // ════════ one day: every room booking + every desk held ════════
    if (pathname === "/api/cowork/day" && req.method === "GET") {
      const date = qp("date"), what = qp("what");     // what = rooms | desks | (both)
      if (!isDate(date)) { jsonResp(res, 400, { error: "date=YYYY-MM-DD required" }); return true; }
      const wantRooms = what !== "desks", wantDesks = what !== "rooms";
      const [rooms, desks, bookings, rentals] = await Promise.all([loadRooms(), loadDesks(),
        wantRooms ? cached(`day-b:${date}`, () => bookingsOn(date)) : [],
        wantDesks ? cached(`day-r:${date}`, () => rentalsOverlapping(date, date)) : []]);
      jsonResp(res, 200, {
        date, open: OPEN, close: CLOSE,
        rooms: rooms.map(roomRow).sort(byName),
        desks: desks.map(deskRow).sort(byName),
        bookings: bookings.map(bookingRow).sort((a, b) => a.start.localeCompare(b.start)),
        deskHolds: rentals.filter(r => DESK_HOLDING.includes(vf(r, "Status"))).map(rentalRow),
      });
      return true;
    }

    // ════════ desk availability across a date range ════════
    if (pathname === "/api/cowork/desk-availability" && req.method === "GET") {
      const start = qp("start"), end = qp("end") || qp("start"), exclude = qp("exclude");
      if (!isDate(start) || !isDate(end) || end < start) { jsonResp(res, 400, { error: "start/end=YYYY-MM-DD required, end >= start" }); return true; }
      const rentals = (await cached(`avail:${start}:${end}`, () => rentalsOverlapping(start, end)))
        .filter(r => r.id !== exclude && DESK_HOLDING.includes(vf(r, "Status")));
      const busy = {};
      for (const r of rentals) (busy[vf(r, "Desk")] = busy[vf(r, "Desk")] || []).push(rentalRow(r));
      jsonResp(res, 200, { start, end, busy });
      return true;
    }

    // ════════ guarded write: room booking ════════
    if (pathname === "/api/cowork/room-bookings" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const id = body.id || "";
      const v = { ...(body.values || {}) };
      const errors = [];
      const rooms = (await loadRooms()).map(roomRow);
      const room = rooms.find(r => r.name === v["Room"]);
      if (!room) errors.push(`Unknown room "${v["Room"] || ""}"`);
      if (!isDate(v["Booking Date"])) errors.push("Booking date is required");
      if (!isTime(v["Start Time"]) || !isTime(v["End Time"])) errors.push("Start and end times are required (HH:MM)");
      else {
        if (v["Start Time"] >= v["End Time"]) errors.push("End time must be after start time");
        if (v["Start Time"] < OPEN || v["End Time"] > CLOSE) errors.push(`Rooms are bookable ${OPEN}–${CLOSE}`);
        if (mins(v["Start Time"]) % 30 || mins(v["End Time"]) % 30) errors.push("Book in 30-minute increments");
      }
      if (!ROOM_STATUS.includes(v["Status"] || "Confirmed")) errors.push(`Unknown status "${v["Status"]}"`);
      v["Status"] = v["Status"] || "Confirmed";
      const people = num(v["Attendees"]);
      if (room) {
        if (people > room.capacity) errors.push(`${room.name} seats ${room.capacity}; ${people} attendees won't fit`);
        if (v["Needs TV"] === "Yes" && room.tv !== "Yes") errors.push(`${room.name} has no TV — pick a TV room or untick "Needs TV"`);
        if (room.status !== "Available" && ROOM_HOLDING.includes(v["Status"]) && !id) errors.push(`${room.name} is ${room.status}`);
      }
      if (!errors.length && ROOM_HOLDING.includes(v["Status"])) {
        const clash = (await bookingsOn(v["Booking Date"])).filter(b =>
          b.id !== id && vf(b, "Room") === v["Room"] && ROOM_HOLDING.includes(vf(b, "Status"))
          && v["Start Time"] < vf(b, "End Time") && vf(b, "Start Time") < v["End Time"]);
        if (clash.length) errors.push(`${v["Room"]} is already booked ` + clash.map(b =>
          `${vf(b, "Start Time")}–${vf(b, "End Time")} (${vf(b, "Booked By") || "—"})`).join(", "));
      }
      if (errors.length) { jsonResp(res, 409, { error: errors.join("; "), errors }); return true; }
      // derived fields always follow the room and the clock, never the client
      const hrs = (mins(v["End Time"]) - mins(v["Start Time"])) / 60;
      v["Hours"] = String(hrs);
      if (!String(v["Rate"] || "").trim()) v["Rate"] = String(Math.round(hrs * room.rate));
      let r;
      if (id) r = await kineticRequest("PUT", `/submissions/${id}?include=values`, { values: v }, auth);
      else {
        v["Booking ID"] = v["Booking ID"] || `RB-${Date.now().toString(36).toUpperCase()}`;
        r = await kineticRequest("POST", `/kapps/${kapp}/forms/room-bookings/submissions?include=values`, { values: v, coreState: "Submitted" }, auth);
      }
      if (r.status >= 300) { jsonResp(res, r.status, { error: JSON.stringify(r.data).slice(0, 300) }); return true; }
      bust();
      jsonResp(res, 200, { ok: true, submission: r.data?.submission || r.data });
      return true;
    }

    // ════════ guarded write: desk rental ════════
    if (pathname === "/api/cowork/desk-rentals" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const id = body.id || "";
      const v = { ...(body.values || {}) };
      const errors = [];
      const desks = (await loadDesks()).map(deskRow);
      const desk = desks.find(d => d.name === v["Desk"]);
      if (!desk) errors.push(`Unknown desk "${v["Desk"] || ""}"`);
      if (!isDate(v["Start Date"]) || !isDate(v["End Date"])) errors.push("Start and end dates are required");
      else if (v["End Date"] < v["Start Date"]) errors.push("End date is before start date");
      if (!RENTAL_TYPES.includes(v["Rental Type"])) errors.push("Rental type must be Day Pass, Weekly or Monthly");
      if (!DESK_STATUS.includes(v["Status"] || "Reserved")) errors.push(`Unknown status "${v["Status"]}"`);
      v["Status"] = v["Status"] || "Reserved";
      if (desk && desk.status !== "Available" && DESK_HOLDING.includes(v["Status"]) && !id) errors.push(`${desk.name} is ${desk.status}`);
      if (!errors.length && DESK_HOLDING.includes(v["Status"])) {
        const clash = (await rentalsOverlapping(v["Start Date"], v["End Date"])).filter(r =>
          r.id !== id && vf(r, "Desk") === v["Desk"] && DESK_HOLDING.includes(vf(r, "Status")));
        if (clash.length) errors.push(`${v["Desk"]} is already rented ` + clash.map(r =>
          `${vf(r, "Start Date")}${vf(r, "End Date") !== vf(r, "Start Date") ? " → " + vf(r, "End Date") : ""} (${vf(r, "Member") || "—"})`).join(", "));
      }
      if (errors.length) { jsonResp(res, 409, { error: errors.join("; "), errors }); return true; }
      v["Zone"] = desk.zone;
      if (!String(v["Rate"] || "").trim()) v["Rate"] = String(v["Rental Type"] === "Monthly" ? desk.month : v["Rental Type"] === "Weekly" ? desk.week : desk.day);
      let r;
      if (id) r = await kineticRequest("PUT", `/submissions/${id}?include=values`, { values: v }, auth);
      else {
        v["Rental ID"] = v["Rental ID"] || `DR-${Date.now().toString(36).toUpperCase()}`;
        r = await kineticRequest("POST", `/kapps/${kapp}/forms/desk-rentals/submissions?include=values`, { values: v, coreState: "Submitted" }, auth);
      }
      if (r.status >= 300) { jsonResp(res, r.status, { error: JSON.stringify(r.data).slice(0, 300) }); return true; }
      bust();
      jsonResp(res, 200, { ok: true, submission: r.data?.submission || r.data });
      return true;
    }

    // any other write from the client (members, rooms, desks) should drop cached lookups
    if (pathname === "/api/cowork/invalidate" && req.method === "POST") { bust(); jsonResp(res, 200, { ok: true }); return true; }

    // ════════ dashboard ════════
    if (pathname === "/api/cowork/dashboard" && req.method === "GET") {
      const today = isDate(qp("date")) ? qp("date") : new Date().toISOString().slice(0, 10);
      const nowT = isTime(qp("now")) ? qp("now") : "12:00";
      const data = await cached(`dash:${today}:${nowT.slice(0, 2)}`, async () => {
        const d0 = new Date(today + "T12:00:00Z");
        const shift = (n) => { const d = new Date(d0); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
        const dow = d0.getUTCDay();                           // 0 Sun … 6 Sat
        const weekStart = shift(dow === 0 ? -6 : 1 - dow);   // Monday
        const weekEnd = shift(dow === 0 ? -1 : 6 - dow);     // Saturday
        const monthStart = today.slice(0, 8) + "01";
        const horizon = shift(14);
        const from = monthStart < weekStart ? monthStart : weekStart;

        const [roomsRaw, desksRaw, members] = await Promise.all([loadRooms(), loadDesks(), loadMembers()]);
        const rooms = roomsRaw.map(roomRow).sort(byName);
        const desks = desksRaw.map(deskRow).sort(byName);
        // one ranged query per room over [from, horizon] — compound index [Room, Booking Date]
        const perRoom = await Promise.all(rooms.map(r => collect("room-bookings",
          `values[Room]="${esc(r.name)}" AND values[Booking Date] >= "${from}" AND values[Booking Date] <= "${horizon}"`,
          "values[Booking Date]")));
        const bookings = perRoom.flat().map(bookingRow);
        const rentals = (await rentalsOverlapping(monthStart, horizon)).map(rentalRow);

        const holdingB = bookings.filter(b => ROOM_HOLDING.includes(b.status));
        const holdingR = rentals.filter(r => DESK_HOLDING.includes(r.status));
        const hoursOf = (b) => (mins(b.end) - mins(b.start)) / 60;

        // today
        const todayB = holdingB.filter(b => b.date === today);
        const todayHolds = holdingR.filter(r => r.start <= today && r.end >= today);
        const rentable = desks.filter(d => d.status === "Available");
        const openDesks = rentable.filter(d => !todayHolds.some(h => h.desk === d.name));
        const inRoomNow = todayB.filter(b => b.start <= nowT && nowT < b.end);

        // this week (Mon–Sat, 12 bookable hours per day)
        const weekB = holdingB.filter(b => b.date >= weekStart && b.date <= weekEnd);
        const weekCap = 12 * 6;                               // hours per room per week
        const roomsWeek = rooms.map(r => {
          const mine = weekB.filter(b => b.room === r.name);
          const hrs = mine.reduce((s, b) => s + hoursOf(b), 0);
          return { room: r.name, tv: r.tv, tvSize: r.tvSize, status: r.status, bookings: mine.length,
            hours: +hrs.toFixed(1), util: Math.round(100 * hrs / weekCap),
            today: todayB.filter(b => b.room === r.name).length };
        });
        const util = (tv) => {
          const rs = roomsWeek.filter(r => r.tv === tv);
          return rs.length ? Math.round(rs.reduce((s, r) => s + r.util, 0) / rs.length) : 0;
        };

        // month-to-date booked revenue: room bookings dated this month + rentals starting this month
        const monthEnd = today.slice(0, 8) + "31";
        const roomRev = holdingB.filter(b => b.date >= monthStart && b.date <= monthEnd).reduce((s, b) => s + num(b.rate), 0);
        const deskRev = holdingR.filter(r => r.start >= monthStart && r.start <= monthEnd).reduce((s, r) => s + num(r.rate), 0);

        // desks by zone today
        const zones = {};
        for (const d of desks) {
          const z = (zones[d.zone] = zones[d.zone] || { zone: d.zone, desks: 0, taken: 0, oos: 0 });
          z.desks++;
          if (d.status !== "Available") z.oos++;
          else if (todayHolds.some(h => h.desk === d.name)) z.taken++;
        }

        // coming up: next room bookings from now, then desks starting soon
        const upcoming = holdingB.filter(b => b.status !== "Completed" && (b.date > today || (b.date === today && b.end > nowT)))
          .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).slice(0, 12);
        const deskStarts = holdingR.filter(r => r.start > today && r.start <= shift(7))
          .sort((a, b) => a.start.localeCompare(b.start) || a.desk.localeCompare(b.desk, undefined, { numeric: true })).slice(0, 12);

        const mStatus = (s) => members.filter(m => vf(m, "Status") === s).length;
        return {
          today, now: nowT, weekStart, weekEnd,
          totals: {
            desks: desks.length, rentableDesks: rentable.length, desksTaken: rentable.length - openDesks.length,
            desksOpen: openDesks.length, outOfService: desks.length - rentable.length,
            rooms: rooms.length, tvRooms: rooms.filter(r => r.tv === "Yes").length,
            meetingsToday: todayB.length, roomHoursToday: +todayB.reduce((s, b) => s + hoursOf(b), 0).toFixed(1),
            inRoomNow: inRoomNow.length,
            weekUtil: Math.round(roomsWeek.reduce((s, r) => s + r.util, 0) / (roomsWeek.length || 1)),
            tvUtil: util("Yes"), noTvUtil: util("No"),
            monthRevenue: Math.round(roomRev + deskRev), roomRevenue: Math.round(roomRev), deskRevenue: Math.round(deskRev),
            activeMembers: mStatus("Active"), prospects: mStatus("Prospect"),
            monthlyDesks: todayHolds.filter(h => h.type === "Monthly").length,
            noShows: bookings.filter(b => b.status === "No Show" && b.date >= monthStart && b.date <= today).length,
          },
          roomsWeek, zones: Object.values(zones), openDesks: openDesks.map(d => d.name),
          todayBookings: todayB.sort((a, b) => a.start.localeCompare(b.start)),
          upcoming, deskStarts,
        };
      });
      jsonResp(res, 200, data);
      return true;
    }
  } catch (e) {
    jsonResp(res, 500, { error: String((e && e.message) || e) });
    return true;
  }
  return false;
}
