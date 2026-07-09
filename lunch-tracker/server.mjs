/**
 * Lunch Tracker — Custom API Handler
 *
 * Dashboard aggregation (allergy-conflict detection across orders × people × menu)
 * and the bulk "send feedback request emails" action for a session.
 * Actual email delivery is done by the Kinetic workflow bound to the
 * email-log form's Submitted event (smtp_email_send_v1).
 */

export const appId = "lunch-tracker";
export const apiPrefix = "/api/lunch-tracker";
export const kapp = "lunch-tracker";

function tokens(csv) {
  return String(csv || "")
    .split(",")
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
}

// Allergens in `personAllergies` that also appear in `optionAllergens` (comma lists).
function conflictAllergens(personAllergies, optionAllergens) {
  const opt = new Set(tokens(optionAllergens));
  return tokens(personAllergies).filter(a => opt.has(a));
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // ── GET /api/lunch-tracker/dashboard ──────────────────────────────────────
  if (pathname === "/api/lunch-tracker/dashboard" && req.method === "GET") {
    try {
      const [people, sessions, options, orders, feedback] = await Promise.all([
        collect("people", null, 8),
        collect("sessions", null, 8),
        collect("lunch-options", null, 8),
        collect("lunch-orders", null, 8),
        collect("feedback", null, 8),
      ]);

      const personByEmail = {};
      for (const p of people) personByEmail[(vf(p, "Email") || "").toLowerCase()] = p;
      const optionByName = {};
      for (const o of options) optionByName[vf(o, "Option Name") || ""] = o;

      // Allergy conflicts: any non-cancelled order where the person's allergies
      // intersect the ordered option's Contains Allergens.
      const conflicts = [];
      for (const ord of orders) {
        if (vf(ord, "Status") === "Cancelled") continue;
        const person = personByEmail[(vf(ord, "Person Email") || "").toLowerCase()];
        const option = optionByName[vf(ord, "Lunch Option") || ""];
        if (!person || !option) continue;
        const hits = conflictAllergens(vf(person, "Allergies"), vf(option, "Contains Allergens"));
        if (hits.length) {
          conflicts.push({
            orderId: ord.id,
            person: vf(ord, "Person Name"),
            email: vf(ord, "Person Email"),
            session: vf(ord, "Session Name"),
            sessionDate: vf(ord, "Session Date"),
            option: vf(ord, "Lunch Option"),
            allergens: hits.map(cap),
            status: vf(ord, "Status"),
          });
        }
      }
      conflicts.sort((a, b) => (b.sessionDate || "").localeCompare(a.sessionDate || ""));

      const byOption = {};
      const bySession = {};
      for (const o of orders) {
        const opt = vf(o, "Lunch Option") || "Unknown";
        byOption[opt] = (byOption[opt] || 0) + 1;
        const sess = vf(o, "Session Name") || "Unknown";
        bySession[sess] = (bySession[sess] || 0) + 1;
      }
      const topOptions = Object.entries(byOption)
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([name, count]) => ({ name, count }));

      const ratings = feedback.map(f => parseInt(vf(f, "Rating") || "0", 10)).filter(n => n > 0);
      const avgRating = ratings.length
        ? (ratings.reduce((s, n) => s + n, 0) / ratings.length).toFixed(1)
        : null;

      const upcoming = sessions
        .filter(s => ["Scheduled", "In Progress"].includes(vf(s, "Status")))
        .sort((a, b) => (vf(a, "Session Date") || "").localeCompare(vf(b, "Session Date") || ""))
        .slice(0, 8)
        .map(s => ({
          id: s.id,
          name: vf(s, "Session Name"),
          date: vf(s, "Session Date"),
          instructor: vf(s, "Instructor"),
          status: vf(s, "Status"),
          orderCount: bySession[vf(s, "Session Name")] || 0,
        }));

      const allergyPeople = people.filter(p => tokens(vf(p, "Allergies")).length).length;

      jsonResp(res, 200, {
        kpis: {
          activePeople: people.filter(p => vf(p, "Status") === "Active").length,
          peopleWithAllergies: allergyPeople,
          upcomingSessions: upcoming.length,
          totalOrders: orders.length,
          openOrders: orders.filter(o => ["Requested", "Confirmed"].includes(vf(o, "Status"))).length,
          avgRating,
          feedbackCount: feedback.length,
          allergyConflicts: conflicts.length,
        },
        conflicts,
        topOptions,
        upcoming,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── POST /api/lunch-tracker/send-feedback ─────────────────────────────────
  // Body: { sessionName }
  // Creates one email-log record per distinct attendee with a non-cancelled
  // order in that session (skipping anyone already emailed for it). The
  // workflow on email-log Submitted does the actual SMTP send.
  if (pathname === "/api/lunch-tracker/send-feedback" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const sessionName = (body.sessionName || "").trim();
      if (!sessionName) { jsonResp(res, 400, { error: "sessionName is required" }); return true; }

      const kqlName = sessionName.replace(/"/g, '\\"');
      const [sessArr, orders, alreadySent] = await Promise.all([
        collect("sessions", null, 8).then(all => all.filter(s => vf(s, "Session Name") === sessionName)),
        collect("lunch-orders", `values[Session Name] = "${kqlName}"`, 8),
        collect("email-log", `values[Session Name] = "${kqlName}"`, 8),
      ]);
      if (sessArr.length === 0) { jsonResp(res, 404, { error: `Session not found: ${sessionName}` }); return true; }
      const sessionDate = vf(sessArr[0], "Session Date") || "";

      const sentEmails = new Set(
        alreadySent
          .filter(e => vf(e, "Email Type") === "Feedback Request")
          .map(e => (vf(e, "To Email") || "").toLowerCase())
      );

      // Distinct attendees (first order wins for the lunch named in the email)
      const attendees = new Map();
      for (const o of orders) {
        if (vf(o, "Status") === "Cancelled") continue;
        const email = (vf(o, "Person Email") || "").toLowerCase();
        if (!email || attendees.has(email) || sentEmails.has(email)) continue;
        attendees.set(email, { name: vf(o, "Person Name") || email, lunch: vf(o, "Lunch Option") || "your lunch" });
      }

      const created = [];
      const failed = [];
      for (const [email, a] of attendees) {
        const firstName = a.name.split(" ")[0];
        const values = {
          "To Name": a.name,
          "To Email": email,
          "Subject": `How was lunch at ${sessionName}?`,
          "Body": `Hi ${firstName},\n\nThanks for attending ${sessionName} on ${sessionDate}. We'd love your feedback on the lunch (${a.lunch}). Reply or use the feedback form in the Lunch Tracker portal.\n\n— The Training Team`,
          "Session Name": sessionName,
          "Email Type": "Feedback Request",
          "Status": "Queued",
          "Sent At": "",
        };
        const r = await kineticRequest("POST", `/kapps/${KAPP}/forms/email-log/submissions`, {
          values, coreState: "Submitted",
        }, auth);
        if (r.status < 300) created.push(email);
        else failed.push({ email, error: r.data });
      }

      jsonResp(res, 200, {
        success: failed.length === 0,
        session: sessionName,
        queued: created.length,
        skippedAlreadySent: sentEmails.size,
        failed,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
