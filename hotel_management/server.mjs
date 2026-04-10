/**
 * Hotel Management — Custom API Handler
 */

export const appId = "hotel-mgmt";
export const apiPrefix = "/api/hotel";
export const kapp = "hotel-mgmt";

function todayISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // ─── GET /api/hotel/dashboard ──────────────────────────────────────────
  if (pathname === "/api/hotel/dashboard" && req.method === "GET") {
    try {
      const [rooms, reservations, housekeeping] = await Promise.all([
        collect("rooms", null, 4),
        collect("reservations", null, 8),
        collect("housekeeping", null, 4),
      ]);

      const today = todayISO();
      const totalRooms = rooms.length;
      const occupiedRooms = rooms.filter(r => vf(r, "Status") === "Occupied").length;
      const availableRooms = rooms.filter(r => vf(r, "Status") === "Available").length;
      const occupancyRate = totalRooms > 0 ? Math.round(occupiedRooms / totalRooms * 100) : 0;

      const todayArrivals = reservations.filter(r =>
        vf(r, "Check In") === today && vf(r, "Status") === "Confirmed"
      ).length;

      const todayDepartures = reservations.filter(r =>
        vf(r, "Check Out") === today && vf(r, "Status") === "Checked In"
      ).length;

      let activeRevenue = 0;
      for (const r of reservations) {
        if (vf(r, "Status") === "Checked In") {
          activeRevenue += parseInt(vf(r, "Total Amount") || "0");
        }
      }

      const hkPending = housekeeping.filter(h => vf(h, "Status") === "Pending").length;
      const hkInProgress = housekeeping.filter(h => vf(h, "Status") === "In Progress").length;

      // Floor occupancy
      const floorOccupancy = {};
      for (const r of rooms) {
        const fl = vf(r, "Floor") || "?";
        if (!floorOccupancy[fl]) floorOccupancy[fl] = { total: 0, occupied: 0 };
        floorOccupancy[fl].total++;
        if (vf(r, "Status") === "Occupied") floorOccupancy[fl].occupied++;
      }

      // Condition summary
      const conditionSummary = {};
      for (const r of rooms) {
        const c = vf(r, "Condition") || "Unknown";
        conditionSummary[c] = (conditionSummary[c] || 0) + 1;
      }

      // Upcoming arrivals (confirmed, check-in >= today)
      const upcomingArrivals = reservations
        .filter(r => vf(r, "Status") === "Confirmed" && vf(r, "Check In") >= today)
        .sort((a, b) => (vf(a, "Check In") || "").localeCompare(vf(b, "Check In") || ""))
        .slice(0, 10)
        .map(r => ({
          confirmation: vf(r, "Confirmation Number"),
          guest: vf(r, "Guest Name"),
          roomType: vf(r, "Room Type Requested"),
          checkIn: vf(r, "Check In"),
          nights: vf(r, "Nights"),
          status: vf(r, "Status"),
        }));

      jsonResp(res, 200, {
        occupancyRate, occupiedRooms, totalRooms, availableRooms,
        todayArrivals, todayDepartures, activeRevenue,
        hkPending, hkInProgress, floorOccupancy, conditionSummary, upcomingArrivals,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── GET /api/hotel/rooms/grid ─────────────────────────────────────────
  if (pathname === "/api/hotel/rooms/grid" && req.method === "GET") {
    try {
      const rooms = await collect("rooms", null, 4);
      const mapped = rooms.map(r => ({
        id: r.id,
        number: vf(r, "Room Number"),
        floor: vf(r, "Floor"),
        type: vf(r, "Room Type"),
        rate: vf(r, "Base Rate"),
        status: vf(r, "Status"),
        condition: vf(r, "Condition"),
        guest: vf(r, "Current Guest"),
        bedConfig: vf(r, "Bed Config"),
        view: vf(r, "View"),
      }));
      jsonResp(res, 200, { rooms: mapped });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── POST /api/hotel/reservations/:id/checkin ──────────────────────────
  const checkinMatch = pathname.match(/^\/api\/hotel\/reservations\/([^/]+)\/checkin$/);
  if (checkinMatch && req.method === "POST") {
    const resId = decodeURIComponent(checkinMatch[1]);
    try {
      const body = await readBody(req);
      const user = body.user || "System";

      // Get the reservation
      const resData = await kineticRequest("GET", `/kapps/${KAPP}/forms/reservations/submissions/${resId}?include=values`, null, auth);
      const reservation = resData.submission;
      const roomNumber = reservation.values["Room Number"];
      const guestName = reservation.values["Guest Name"];

      // Find the room by room number
      let targetRoom = null;
      if (roomNumber) {
        const rooms = await collect("rooms", `values[Room Number]="${roomNumber}"`, 1);
        if (rooms.length > 0) targetRoom = rooms[0];
      }

      // If no room assigned, find an available room matching requested type
      if (!targetRoom) {
        const requestedType = reservation.values["Room Type Requested"] || "";
        const kql = requestedType
          ? `values[Status]="Available" AND values[Room Type]="${requestedType}"`
          : `values[Status]="Available"`;
        const available = await collect("rooms", kql, 1);
        if (available.length === 0) {
          jsonResp(res, 400, { error: "No available rooms" });
          return true;
        }
        targetRoom = available[0];
      }

      const assignedRoom = vf(targetRoom, "Room Number");
      const now = new Date().toISOString();

      // Update reservation
      await kineticRequest("PUT", `/kapps/${KAPP}/forms/reservations/submissions/${resId}`, {
        values: {
          "Status": "Checked In",
          "Room Number": assignedRoom,
          "Room ID": targetRoom.id,
          "Checked In At": now,
          "Checked In By": user,
        },
      }, auth);

      // Update room
      await kineticRequest("PUT", `/kapps/${KAPP}/forms/rooms/submissions/${targetRoom.id}`, {
        values: {
          "Status": "Occupied",
          "Current Guest": guestName,
          "Current Reservation ID": resId,
        },
      }, auth);

      jsonResp(res, 200, { ok: true, roomNumber: assignedRoom });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── POST /api/hotel/reservations/:id/checkout ─────────────────────────
  const checkoutMatch = pathname.match(/^\/api\/hotel\/reservations\/([^/]+)\/checkout$/);
  if (checkoutMatch && req.method === "POST") {
    const resId = decodeURIComponent(checkoutMatch[1]);
    try {
      const body = await readBody(req);
      const user = body.user || "System";
      const now = new Date().toISOString();

      // Get the reservation
      const resData = await kineticRequest("GET", `/kapps/${KAPP}/forms/reservations/submissions/${resId}?include=values`, null, auth);
      const reservation = resData.submission;
      const roomId = reservation.values["Room ID"];
      const roomNumber = reservation.values["Room Number"];

      // Update reservation
      await kineticRequest("PUT", `/kapps/${KAPP}/forms/reservations/submissions/${resId}`, {
        values: {
          "Status": "Checked Out",
          "Checked Out At": now,
          "Checked Out By": user,
        },
      }, auth);

      // Update room
      if (roomId) {
        await kineticRequest("PUT", `/kapps/${KAPP}/forms/rooms/submissions/${roomId}`, {
          values: {
            "Status": "Maintenance",
            "Condition": "Dirty",
            "Current Guest": "",
            "Current Reservation ID": "",
          },
        }, auth);
      }

      // Create housekeeping task
      const hkTasks = await collect("housekeeping", null, 1);
      const taskId = `HK-${String(hkTasks.length + 1).padStart(4, "0")}`;
      await kineticRequest("POST", `/kapps/${KAPP}/forms/housekeeping/submissions`, {
        values: {
          "Task ID": taskId,
          "Room Number": roomNumber || "",
          "Room ID": roomId || "",
          "Task Type": "Checkout Clean",
          "Priority": "High",
          "Status": "Pending",
          "Requested At": now,
        },
      }, auth);

      jsonResp(res, 200, { ok: true });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── POST /api/hotel/housekeeping/:id/transition ───────────────────────
  const hkMatch = pathname.match(/^\/api\/hotel\/housekeeping\/([^/]+)\/transition$/);
  if (hkMatch && req.method === "POST") {
    const taskSubId = decodeURIComponent(hkMatch[1]);
    try {
      const body = await readBody(req);
      const action = body.action;
      const user = body.user || "System";
      const now = new Date().toISOString();

      let updates = {};
      if (action === "start") {
        updates = { "Status": "In Progress", "Started At": now, "Assigned To": user };
      } else if (action === "complete") {
        updates = { "Status": "Complete", "Completed At": now };
      } else if (action === "verify") {
        updates = { "Status": "Verified", "Verified By": user, "Verified At": now };

        // When verified, update the room back to Available/Clean
        const hkData = await kineticRequest("GET", `/kapps/${KAPP}/forms/housekeeping/submissions/${taskSubId}?include=values`, null, auth);
        const roomId = hkData.submission?.values?.["Room ID"];
        if (roomId) {
          await kineticRequest("PUT", `/kapps/${KAPP}/forms/rooms/submissions/${roomId}`, {
            values: {
              "Status": "Available",
              "Condition": "Clean",
              "Last Cleaned": todayISO(),
              "Last Cleaned By": user,
            },
          }, auth);
        }
      } else {
        jsonResp(res, 400, { error: `Unknown action: ${action}` });
        return true;
      }

      await kineticRequest("PUT", `/kapps/${KAPP}/forms/housekeeping/submissions/${taskSubId}`, {
        values: updates,
      }, auth);

      jsonResp(res, 200, { ok: true, status: updates["Status"] });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
