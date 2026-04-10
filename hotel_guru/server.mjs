export const appId = "hotel-guru";
export const apiPrefix = "/api/ghc";
export const kapp = "hotel-guru";

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(kapp, formSlug, kql, auth, maxPages);
  }

  /* ── Dashboard ─────────────────────────────────────────── */
  if (pathname === "/api/ghc/dashboard") {
    const [properties, rooms, reservations, hkTasks, mxTasks, auditLog] = await Promise.all([
      collect("properties", null, 4),
      collect("rooms", null, 8),
      collect("reservations", 'values[Status] IN ("Confirmed","Checked In")', 8),
      collect("housekeeping", 'values[Status] IN ("Pending","In Progress")', 4),
      collect("maintenance", 'values[Status] IN ("Open","In Progress")', 4),
      collect("audit-log", null, 2),
    ]);

    const totalRooms = rooms.length;
    const occupiedRooms = rooms.filter(r => vf(r, "Status") === "Occupied").length;
    const occupancyRate = totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 100) : 0;

    const today = new Date().toISOString().slice(0, 10);
    const todayArrivals = reservations.filter(r => (vf(r, "Check In") || "").slice(0, 10) === today && vf(r, "Status") === "Confirmed").length;
    const todayDepartures = reservations.filter(r => (vf(r, "Check Out") || "").slice(0, 10) === today && vf(r, "Status") === "Checked In").length;

    let activeRevenue = 0;
    reservations.filter(r => vf(r, "Status") === "Checked In").forEach(r => {
      activeRevenue += parseFloat(vf(r, "Total Amount") || "0");
    });

    const propSummary = properties.map(p => {
      const pid = vf(p, "Property ID");
      const propRooms = rooms.filter(r => vf(r, "Property ID") === pid);
      const propOccupied = propRooms.filter(r => vf(r, "Status") === "Occupied").length;
      return {
        code: vf(p, "Property Code"),
        name: vf(p, "Property Name"),
        region: vf(p, "Region"),
        totalRooms: propRooms.length,
        occupiedRooms: propOccupied,
        stars: vf(p, "Star Rating"),
      };
    });

    // Reservation pipeline by status
    const resPipeline = {};
    reservations.forEach(r => {
      const st = vf(r, "Status") || "Unknown";
      resPipeline[st] = (resPipeline[st] || 0) + 1;
    });

    // Ops queue
    const opsQueue = {
      housekeeping: hkTasks.map(t => ({
        taskId: vf(t, "Task ID"),
        property: vf(t, "Property Code"),
        room: vf(t, "Room Number"),
        type: vf(t, "Task Type"),
        priority: vf(t, "Priority"),
        status: vf(t, "Status"),
        assignedTo: vf(t, "Assigned To"),
      })),
      maintenance: mxTasks.map(t => ({
        ticketId: vf(t, "Ticket ID"),
        property: vf(t, "Property Code"),
        room: vf(t, "Room Number"),
        category: vf(t, "Category"),
        severity: vf(t, "Severity"),
        status: vf(t, "Status"),
        assignedTo: vf(t, "Assigned Engineer"),
      })),
    };

    // Recent audit
    const recentAudit = auditLog.slice(0, 20).map(a => ({
      action: vf(a, "Action"),
      entityType: vf(a, "Entity Type"),
      entityId: vf(a, "Entity ID"),
      changedBy: vf(a, "Changed By"),
      timestamp: vf(a, "Timestamp"),
      property: vf(a, "Property Code"),
      details: vf(a, "Details"),
    }));

    return jsonResp(res, 200, {
      totalProperties: properties.length,
      totalRooms,
      occupiedRooms,
      occupancyRate,
      activeReservations: reservations.length,
      todayArrivals,
      todayDepartures,
      activeRevenue: Math.round(activeRevenue),
      pendingHK: hkTasks.length,
      pendingMX: mxTasks.length,
      properties: propSummary,
      resPipeline,
      opsQueue,
      recentAudit,
    });
  }

  /* ── Rooms by property ─────────────────────────────────── */
  if (pathname === "/api/ghc/rooms") {
    const url = new URL(req.url, "http://localhost");
    const propId = url.searchParams.get("propertyId");
    const kql = propId ? `values[Property ID] = "${propId}"` : null;
    const rooms = await collect("rooms", kql, 8);
    return jsonResp(res, 200, {
      rooms: rooms.map(r => ({
        id: r.id,
        roomId: vf(r, "Room ID"),
        propertyId: vf(r, "Property ID"),
        propertyCode: vf(r, "Property Code"),
        roomNumber: vf(r, "Room Number"),
        floor: vf(r, "Floor"),
        roomType: vf(r, "Room Type"),
        status: vf(r, "Status"),
        condition: vf(r, "Condition"),
        hkStatus: vf(r, "HK Status"),
        currentGuest: vf(r, "Current Guest"),
        currentReservation: vf(r, "Current Reservation"),
        lastCleaned: vf(r, "Last Cleaned"),
        notes: vf(r, "Notes"),
      })),
    });
  }

  /* ── Reservations ──────────────────────────────────────── */
  if (pathname === "/api/ghc/reservations") {
    const url = new URL(req.url, "http://localhost");
    const status = url.searchParams.get("status");
    const propId = url.searchParams.get("propertyId");
    let kql = null;
    const parts = [];
    if (status) parts.push(`values[Status] = "${status}"`);
    if (propId) parts.push(`values[Property ID] = "${propId}"`);
    if (parts.length) kql = parts.join(" AND ");
    const reservations = await collect("reservations", kql, 4);
    return jsonResp(res, 200, {
      reservations: reservations.map(r => ({
        id: r.id,
        reservationId: vf(r, "Reservation ID"),
        confirmationNumber: vf(r, "Confirmation Number"),
        guestId: vf(r, "Guest ID"),
        guestName: vf(r, "Guest Name"),
        propertyId: vf(r, "Property ID"),
        propertyCode: vf(r, "Property Code"),
        propertyName: vf(r, "Property Name"),
        roomType: vf(r, "Room Type"),
        roomNumber: vf(r, "Room Number"),
        checkIn: vf(r, "Check In"),
        checkOut: vf(r, "Check Out"),
        nights: vf(r, "Nights"),
        status: vf(r, "Status"),
        rate: vf(r, "Rate"),
        totalAmount: vf(r, "Total Amount"),
        paymentStatus: vf(r, "Payment Status"),
        channelSource: vf(r, "Channel Source"),
        specialRequests: vf(r, "Special Requests"),
      })),
    });
  }

  /* ── Guests ────────────────────────────────────────────── */
  if (pathname === "/api/ghc/guests") {
    const guests = await collect("guests", null, 4);
    return jsonResp(res, 200, {
      guests: guests.map(g => ({
        id: g.id,
        guestId: vf(g, "Guest ID"),
        firstName: vf(g, "First Name"),
        lastName: vf(g, "Last Name"),
        email: vf(g, "Email"),
        phone: vf(g, "Phone"),
        country: vf(g, "Country"),
        loyaltyId: vf(g, "Loyalty ID"),
        loyaltyTier: vf(g, "Loyalty Tier"),
        loyaltyPoints: vf(g, "Loyalty Points"),
        totalStays: vf(g, "Total Stays"),
        lifetimeValue: vf(g, "Lifetime Value"),
        riskScore: vf(g, "Risk Score"),
        vipStatus: vf(g, "VIP Status"),
        company: vf(g, "Company"),
        preferences: vf(g, "Preferences"),
      })),
    });
  }

  /* ── Operations (housekeeping + maintenance) ───────────── */
  if (pathname === "/api/ghc/operations") {
    const [hk, mx] = await Promise.all([
      collect("housekeeping", null, 4),
      collect("maintenance", null, 4),
    ]);
    return jsonResp(res, 200, {
      housekeeping: hk.map(t => ({
        id: t.id,
        taskId: vf(t, "Task ID"),
        propertyId: vf(t, "Property ID"),
        propertyCode: vf(t, "Property Code"),
        roomNumber: vf(t, "Room Number"),
        taskType: vf(t, "Task Type"),
        priority: vf(t, "Priority"),
        status: vf(t, "Status"),
        assignedTo: vf(t, "Assigned To"),
        slaDeadline: vf(t, "SLA Deadline"),
        requestedAt: vf(t, "Requested At"),
        completedAt: vf(t, "Completed At"),
      })),
      maintenance: mx.map(t => ({
        id: t.id,
        ticketId: vf(t, "Ticket ID"),
        propertyId: vf(t, "Property ID"),
        propertyCode: vf(t, "Property Code"),
        roomNumber: vf(t, "Room Number"),
        category: vf(t, "Category"),
        severity: vf(t, "Severity"),
        status: vf(t, "Status"),
        assignedTo: vf(t, "Assigned Engineer"),
        costEstimate: vf(t, "Cost Estimate"),
        actualCost: vf(t, "Actual Cost"),
      })),
    });
  }

  /* ── Revenue ───────────────────────────────────────────── */
  if (pathname === "/api/ghc/revenue") {
    const [payments, reservations, properties] = await Promise.all([
      collect("payments", null, 8),
      collect("reservations", null, 8),
      collect("properties", null, 4),
    ]);

    let totalRevenue = 0, totalRefunds = 0;
    const byType = {}, byProperty = {};
    payments.forEach(p => {
      const amt = parseFloat(vf(p, "Amount") || "0");
      const type = vf(p, "Payment Type") || "Other";
      const status = vf(p, "Status");
      const propId = vf(p, "Property ID");
      if (status === "Refunded") { totalRefunds += amt; }
      else { totalRevenue += amt; }
      byType[type] = (byType[type] || 0) + amt;
      byProperty[propId] = (byProperty[propId] || 0) + amt;
    });

    const propMap = {};
    properties.forEach(p => { propMap[vf(p, "Property ID")] = vf(p, "Property Name"); });

    return jsonResp(res, 200, {
      totalRevenue: Math.round(totalRevenue),
      totalRefunds: Math.round(totalRefunds),
      netRevenue: Math.round(totalRevenue - totalRefunds),
      totalPayments: payments.length,
      byType,
      byProperty: Object.entries(byProperty).map(([pid, amt]) => ({
        propertyId: pid,
        propertyName: propMap[pid] || pid,
        amount: Math.round(amt),
      })),
      recentPayments: payments.slice(0, 20).map(p => ({
        paymentId: vf(p, "Payment ID"),
        confirmationNumber: vf(p, "Confirmation Number"),
        propertyName: vf(p, "Property Name"),
        guestName: vf(p, "Guest Name"),
        type: vf(p, "Payment Type"),
        amount: vf(p, "Amount"),
        status: vf(p, "Status"),
        processedAt: vf(p, "Processed At"),
      })),
    });
  }

  /* ── Audit ─────────────────────────────────────────────── */
  if (pathname === "/api/ghc/audit") {
    const logs = await collect("audit-log", null, 4);
    return jsonResp(res, 200, {
      entries: logs.map(a => ({
        logId: vf(a, "Log ID"),
        timestamp: vf(a, "Timestamp"),
        entityType: vf(a, "Entity Type"),
        entityId: vf(a, "Entity ID"),
        action: vf(a, "Action"),
        fieldChanged: vf(a, "Field Changed"),
        oldValue: vf(a, "Old Value"),
        newValue: vf(a, "New Value"),
        changedBy: vf(a, "Changed By"),
        propertyId: vf(a, "Property ID"),
        propertyCode: vf(a, "Property Code"),
        details: vf(a, "Details"),
      })),
    });
  }

  /* ── Properties list ───────────────────────────────────── */
  if (pathname === "/api/ghc/properties") {
    const properties = await collect("properties", null, 4);
    return jsonResp(res, 200, {
      properties: properties.map(p => ({
        id: p.id,
        propertyId: vf(p, "Property ID"),
        propertyCode: vf(p, "Property Code"),
        propertyName: vf(p, "Property Name"),
        region: vf(p, "Region"),
        city: vf(p, "City"),
        country: vf(p, "Country"),
        totalRooms: vf(p, "Total Rooms"),
        starRating: vf(p, "Star Rating"),
        gmName: vf(p, "GM Name"),
        status: vf(p, "Status"),
      })),
    });
  }

  /* ── 404 ───────────────────────────────────────────────── */
  return jsonResp(res, 404, { error: "Not found: " + pathname });
}
