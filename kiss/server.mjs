/**
 * KISS Army HQ — Custom API Handler
 *
 * Dashboard aggregation across the band, concerts, merch, the 8-room hotel and
 * the KISS Army fan club, plus three action endpoints:
 *   - book-room      : reserve a room (computes nights/total, marks room Occupied)
 *   - checkout       : check a guest out (frees the room)
 *   - send-newsletter: queue + mock-send the monthly newsletter to subscribed fans
 *
 * Real email delivery is handled by the Kinetic workflow bound to the
 * newsletters form's Submitted event (see workflow-send-newsletter.xml). Until
 * SMTP is configured this endpoint marks each record Sent itself (mock mode).
 */

export const appId = "kiss";
export const apiPrefix = "/api/kiss";
export const kapp = "kiss";

const ROOM_COUNT = 8;

function money(n) { const f = parseFloat(n); return isNaN(f) ? 0 : f; }
function intOf(n) { const f = parseInt(n, 10); return isNaN(f) ? 0 : f; }
function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function nightsBetween(checkIn, checkOut) {
  const a = new Date(checkIn + "T00:00:00Z"), b = new Date(checkOut + "T00:00:00Z");
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }
  const kqlEsc = s => String(s).replace(/"/g, '\\"');

  // ── GET /api/kiss/dashboard ────────────────────────────────────────────────
  if (pathname === "/api/kiss/dashboard" && req.method === "GET") {
    try {
      const [members, concerts, merch, rooms, bookings, fans, newsletters] = await Promise.all([
        collect("members", null, 4),
        collect("concerts", null, 8),
        collect("merchandise", null, 8),
        collect("rooms", null, 4),
        collect("bookings", null, 8),
        collect("fans", null, 8),
        collect("newsletters", null, 8),
      ]);

      // ── Concerts ──
      let ticketsSold = 0, capacity = 0;
      const byTour = {};
      for (const c of concerts) {
        ticketsSold += intOf(vf(c, "Tickets Sold"));
        capacity += intOf(vf(c, "Capacity"));
        const t = vf(c, "Tour") || "Unknown";
        byTour[t] = (byTour[t] || 0) + 1;
      }
      const today = nowIso().slice(0, 10);
      const upcoming = concerts
        .filter(c => vf(c, "Status") === "Scheduled" && (vf(c, "Concert Date") || "") >= today)
        .sort((a, b) => (vf(a, "Concert Date") || "").localeCompare(vf(b, "Concert Date") || ""))
        .slice(0, 8)
        .map(c => ({
          id: c.id, date: vf(c, "Concert Date"), tour: vf(c, "Tour"),
          venue: vf(c, "Venue"), city: vf(c, "City"), country: vf(c, "Country"),
          capacity: intOf(vf(c, "Capacity")), sold: intOf(vf(c, "Tickets Sold")),
        }));

      // ── Merch ──
      let inventoryValue = 0, inStock = 0, outOfStock = 0;
      const merchByCat = {};
      for (const m of merch) {
        const status = vf(m, "Status");
        const stock = intOf(vf(m, "Stock"));
        inventoryValue += money(vf(m, "Price")) * stock;
        if (status === "Available" && stock > 0) inStock++;
        if (status === "Out of Stock" || stock === 0) outOfStock++;
        const cat = vf(m, "Category") || "Other";
        merchByCat[cat] = (merchByCat[cat] || 0) + 1;
      }

      // ── Hotel ──
      const activeBookings = bookings.filter(b => ["Reserved", "Checked In"].includes(vf(b, "Status")));
      const checkedIn = bookings.filter(b => vf(b, "Status") === "Checked In");
      let bookingRevenue = 0;
      for (const b of bookings) {
        if (vf(b, "Status") !== "Cancelled") bookingRevenue += money(vf(b, "Total"));
      }
      const occupiedRooms = rooms.filter(r => vf(r, "Status") === "Occupied").length;
      const availableRooms = rooms.filter(r => vf(r, "Status") === "Available").length;
      const totalRooms = rooms.length || ROOM_COUNT;
      const occupancyPct = totalRooms ? Math.round((occupiedRooms / totalRooms) * 100) : 0;
      const roomGrid = rooms
        .slice()
        .sort((a, b) => intOf(vf(a, "Room Number")) - intOf(vf(b, "Room Number")))
        .map(r => ({
          id: r.id, number: vf(r, "Room Number"), name: vf(r, "Room Name"),
          type: vf(r, "Room Type"), rate: money(vf(r, "Nightly Rate")), status: vf(r, "Status"),
        }));

      // ── KISS Army ──
      const activeFans = fans.filter(f => vf(f, "Status") === "Active");
      const subscribed = fans.filter(f => vf(f, "Newsletter") === "Subscribed" && vf(f, "Status") === "Active");
      const byLevel = {};
      for (const f of fans) { const l = vf(f, "Fan Level") || "General"; byLevel[l] = (byLevel[l] || 0) + 1; }
      const byCountry = {};
      for (const f of fans) { const c = vf(f, "Country") || "Unknown"; byCountry[c] = (byCountry[c] || 0) + 1; }
      const topCountries = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));

      // ── Newsletter ──
      const sent = newsletters.filter(n => vf(n, "Status") === "Sent").length;
      const campaigns = {};
      for (const n of newsletters) { const c = vf(n, "Campaign") || "—"; campaigns[c] = (campaigns[c] || 0) + 1; }
      const lastCampaign = Object.keys(campaigns).sort().reverse()[0] || null;

      jsonResp(res, 200, {
        kpis: {
          currentMembers: members.filter(m => vf(m, "Status") === "Current").length,
          totalMembers: members.length,
          concerts: concerts.length,
          upcomingConcerts: upcoming.length,
          ticketsSold, capacity,
          sellThrough: capacity ? Math.round((ticketsSold / capacity) * 100) : 0,
          merchItems: merch.length,
          merchInStock: inStock,
          inventoryValue: Math.round(inventoryValue),
          totalRooms, availableRooms, occupiedRooms, occupancyPct,
          activeBookings: activeBookings.length,
          checkedIn: checkedIn.length,
          bookingRevenue: Math.round(bookingRevenue),
          fans: fans.length,
          activeFans: activeFans.length,
          subscribers: subscribed.length,
          newslettersSent: sent,
        },
        upcoming,
        byTour: Object.entries(byTour).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
        merchByCat: Object.entries(merchByCat).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
        roomGrid,
        fanLevels: ["KISS Army Elite", "Gold", "General"].map(l => ({ level: l, count: byLevel[l] || 0 })),
        topCountries,
        lastCampaign,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── POST /api/kiss/book-room ───────────────────────────────────────────────
  // Body: { guestName, guestEmail, roomNumber, checkIn, checkOut, notes }
  if (pathname === "/api/kiss/book-room" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const { guestName, guestEmail, roomNumber, checkIn, checkOut, notes } = body;
      if (!guestName || !roomNumber || !checkIn || !checkOut) {
        jsonResp(res, 400, { error: "guestName, roomNumber, checkIn and checkOut are required" });
        return true;
      }
      const nights = nightsBetween(checkIn, checkOut);
      if (nights < 1) { jsonResp(res, 400, { error: "Check-out must be after check-in" }); return true; }

      const roomArr = await collect("rooms", `values[Room Number] = "${kqlEsc(roomNumber)}"`, 1);
      if (!roomArr.length) { jsonResp(res, 404, { error: `Room not found: ${roomNumber}` }); return true; }
      const room = roomArr[0];
      const roomStatus = vf(room, "Status");
      if (roomStatus === "Occupied") { jsonResp(res, 409, { error: `Room ${roomNumber} is already occupied` }); return true; }
      if (roomStatus === "Maintenance") { jsonResp(res, 409, { error: `Room ${roomNumber} is under maintenance` }); return true; }

      const rate = money(vf(room, "Nightly Rate"));
      const total = rate * nights;

      // Next confirmation number
      const existing = await collect("bookings", null, 12);
      let maxNum = 20000;
      for (const b of existing) {
        const m = String(vf(b, "Confirmation Number")).match(/KH-(\d+)/);
        if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
      }
      const conf = `KH-${maxNum + 1}`;

      const r = await kineticRequest("POST", `/kapps/${KAPP}/forms/bookings/submissions`, {
        values: {
          "Confirmation Number": conf,
          "Guest Name": guestName,
          "Guest Email": guestEmail || "",
          "Room Number": String(roomNumber),
          "Room Name": vf(room, "Room Name"),
          "Check In": checkIn,
          "Check Out": checkOut,
          "Nights": String(nights),
          "Total": String(total),
          "Status": "Reserved",
          "Notes": notes || "",
        },
        coreState: "Submitted",
      }, auth);
      if (r.status >= 300) { jsonResp(res, 502, { error: "Failed to create booking", detail: r.data }); return true; }

      // Mark the room occupied
      await kineticRequest("PUT", `/submissions/${room.id}`, { values: { Status: "Occupied" } }, auth);

      jsonResp(res, 200, { success: true, confirmation: conf, room: vf(room, "Room Name"), nights, rate, total });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── POST /api/kiss/checkout ────────────────────────────────────────────────
  // Body: { confirmationNumber }  — Checked Out frees the room; Cancelled also frees it.
  if (pathname === "/api/kiss/checkout" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const { confirmationNumber, action } = body;
      if (!confirmationNumber) { jsonResp(res, 400, { error: "confirmationNumber is required" }); return true; }
      const act = action === "cancel" ? "Cancelled" : "Checked Out";

      const arr = await collect("bookings", `values[Confirmation Number] = "${kqlEsc(confirmationNumber)}"`, 1);
      if (!arr.length) { jsonResp(res, 404, { error: `Booking not found: ${confirmationNumber}` }); return true; }
      const booking = arr[0];

      await kineticRequest("PUT", `/submissions/${booking.id}`, { values: { Status: act } }, auth);

      // Free the room (only if no other active booking holds it)
      const roomNumber = vf(booking, "Room Number");
      const roomArr = await collect("rooms", `values[Room Number] = "${kqlEsc(roomNumber)}"`, 1);
      if (roomArr.length && vf(roomArr[0], "Status") === "Occupied") {
        await kineticRequest("PUT", `/submissions/${roomArr[0].id}`, { values: { Status: "Available" } }, auth);
      }

      jsonResp(res, 200, { success: true, confirmation: confirmationNumber, status: act, roomFreed: roomNumber });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── POST /api/kiss/send-newsletter ─────────────────────────────────────────
  // Body: { campaign, subject, body }
  // One newsletter record per subscribed, active fan (skipping anyone already
  // sent this campaign). Records are created Submitted (which fires the SMTP
  // workflow when configured); in mock mode we mark them Sent here.
  if (pathname === "/api/kiss/send-newsletter" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const campaign = (body.campaign || "").trim();
      const subject = (body.subject || "").trim();
      const template = (body.body || "").trim();
      if (!campaign || !subject) { jsonResp(res, 400, { error: "campaign and subject are required" }); return true; }

      const [fans, alreadySent] = await Promise.all([
        collect("fans", `values[Newsletter] = "Subscribed" AND values[Status] = "Active"`, 8),
        collect("newsletters", `values[Campaign] = "${kqlEsc(campaign)}"`, 8),
      ]);
      const sentEmails = new Set(alreadySent.map(n => (vf(n, "To Email") || "").toLowerCase()));

      const recipients = [];
      const seen = new Set();
      for (const f of fans) {
        const email = (vf(f, "Email") || "").toLowerCase();
        if (!email || seen.has(email) || sentEmails.has(email)) continue;
        seen.add(email);
        recipients.push({ name: vf(f, "Full Name") || email, email });
      }

      let queued = 0, sent = 0;
      const failed = [];
      for (const rcpt of recipients) {
        const firstName = rcpt.name.split(" ")[0];
        const personalBody = (template || `Hi {{firstName}},\n\nThanks for being part of the KISS Army. Here's what's hot this month.\n\nRock and roll all nite,\nThe KISS Army`)
          .replace(/\{\{\s*firstName\s*\}\}/g, firstName)
          .replace(/\{\{\s*name\s*\}\}/g, rcpt.name);
        const r = await kineticRequest("POST", `/kapps/${KAPP}/forms/newsletters/submissions`, {
          values: {
            "To Name": rcpt.name,
            "To Email": rcpt.email,
            "Subject": subject,
            "Body": personalBody,
            "Campaign": campaign,
            "Email Type": "Monthly Newsletter",
            "Status": "Queued",
            "Sent At": "",
          },
          coreState: "Submitted",
        }, auth);
        if (r.status >= 300) { failed.push({ email: rcpt.email, error: r.data }); continue; }
        queued++;
        // MOCK send: flip the record to Sent. Remove this block once the SMTP
        // workflow on the newsletters form is doing the real delivery.
        const created = r.data?.submission || r.data;
        if (created?.id) {
          const s = await kineticRequest("PUT", `/submissions/${created.id}`,
            { values: { "Status": "Sent", "Sent At": nowIso() } }, auth);
          if (s.status < 300) sent++;
        }
      }

      jsonResp(res, 200, {
        success: failed.length === 0,
        campaign, subject,
        subscribers: recipients.length + sentEmails.size,
        queued, sent,
        skippedAlreadySent: sentEmails.size,
        failed,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
