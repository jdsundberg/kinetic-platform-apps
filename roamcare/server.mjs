/**
 * RoamCare Workforce Hub — Custom API Handler
 * Server-side aggregation for the staffing command center, executive dashboard,
 * personalized opportunity marketplace, opportunity 360, employee roaming
 * history, and live explainable match scoring.
 *
 * Auto-discovered by apps/base/server.mjs (exports apiPrefix + handleAPI).
 */
import { scoreMatch, explain, splitList } from "./match-engine.mjs";

export const appId = "roamcare";
export const apiPrefix = "/api/roamcare";
export const kapp = "roamcare";

const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};
const TODAY = new Date("2026-06-10T00:00:00Z").getTime();
const DAY = 86400000;
const daysFromToday = (s) => {
  const t = new Date(s).getTime();
  return isNaN(t) ? null : Math.round((t - TODAY) / DAY);
};

const OPEN_STATES = ["Open", "Matched", "Offered", "Pending Approval", "Partially Filled"];
const URGENT = ["Critical", "Emergency"];

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, vf } = helpers;
  const KAPP = kapp;
  const collect = (formSlug, kql, maxPages = 10) =>
    collectByQuery(KAPP, formSlug, kql, auth, maxPages);

  // ── GET /api/roamcare/dashboard — Staffing Command Center ────────────
  if (pathname === "/api/roamcare/dashboard" && req.method === "GET") {
    try {
      const [opps, apps, matches, assigns, employees, creds, depts] = await Promise.all([
        collect("opportunities"),
        collect("applications"),
        collect("matches"),
        collect("assignments"),
        collect("employees"),
        collect("credentials"),
        collect("departments"),
      ]);

      const open = opps.filter((o) => OPEN_STATES.includes(vf(o, "Status")));
      const critical = open.filter((o) => URGENT.includes(vf(o, "Urgency")));
      const filled = opps.filter((o) => ["Filled", "Completed"].includes(vf(o, "Status")));
      const decided = opps.filter((o) =>
        ["Filled", "Completed", "Cancelled", "Expired"].includes(vf(o, "Status"))
      );
      const fillRate = decided.length
        ? Math.round(
            (decided.filter((o) => ["Filled", "Completed"].includes(vf(o, "Status"))).length /
              decided.length) *
              100
          )
        : 0;

      // time-to-fill (created -> filled) on filled opps
      const ttfVals = filled
        .map((o) => {
          const c = daysFromToday(vf(o, "Created Date"));
          const f = daysFromToday(vf(o, "Filled Date"));
          return c != null && f != null ? f - c : null;
        })
        .filter((x) => x != null && x >= 0);
      const avgTTF = ttfVals.length
        ? +(ttfVals.reduce((a, b) => a + b, 0) / ttfVals.length).toFixed(1)
        : 0;

      // deadline pressure
      const nearDeadline = open
        .map((o) => ({ o, d: daysFromToday(vf(o, "Application Deadline")) }))
        .filter((x) => x.d != null && x.d >= 0 && x.d <= 3);

      // available qualified employees (eligible, willing to float, active)
      const availableQualified = employees.filter(
        (e) =>
          vf(e, "Roaming Eligibility Status") === "Eligible" &&
          vf(e, "Status") === "Active" &&
          /^yes$/i.test(vf(e, "Willing to Float"))
      ).length;

      // compliance blocks (matches blocked + applications awaiting/rejected by compliance)
      const blockedMatches = matches.filter((m) => vf(m, "Recommendation Status") === "Blocked").length;
      const complianceQueue = apps.filter((a) =>
        ["Awaiting Compliance Review", "Rejected"].includes(vf(a, "Application Status"))
      ).length;
      const expiringCreds = creds.filter((c) => {
        const d = daysFromToday(vf(c, "Expiration Date"));
        return vf(c, "Verification Status") === "Expired" || (d != null && d >= 0 && d <= 30);
      }).length;

      // overtime exposure (assignments w/ OT hours)
      const otHours = assigns.reduce((s, a) => s + num(vf(a, "Overtime Hours")), 0);

      // agency-cost avoidance: completed/active assignment hours * blended agency premium ($95/hr)
      const coveredHours = assigns
        .filter((a) => ["Completed", "In Progress", "Checked In", "Confirmed"].includes(vf(a, "Assignment Status")))
        .reduce((s, a) => s + (num(vf(a, "Hours Worked")) || 12), 0);
      const agencyAvoided = Math.round(coveredHours * 95);

      // departments releasing / receiving most
      const releasing = {};
      const receiving = {};
      assigns.forEach((a) => {
        const h = vf(a, "Home Department");
        const r = vf(a, "Receiving Department");
        if (h) releasing[h] = (releasing[h] || 0) + 1;
        if (r) receiving[r] = (receiving[r] || 0) + 1;
      });
      const topN = (obj, n = 6) =>
        Object.entries(obj)
          .map(([k, v]) => ({ name: k, count: v }))
          .sort((a, b) => b.count - a.count)
          .slice(0, n);

      // shortage roles (open need by role)
      const byRole = {};
      open.forEach((o) => {
        const r = vf(o, "Needed Role") || "Other";
        byRole[r] = (byRole[r] || 0) + (num(vf(o, "Number of People Needed")) || 1);
      });
      // open need by facility
      const byFacility = {};
      open.forEach((o) => {
        const f = vf(o, "Requesting Location") || "Other";
        byFacility[f] = (byFacility[f] || 0) + 1;
      });

      // departments at risk (current < minimum staffing)
      const atRiskDepts = depts
        .filter((d) => num(vf(d, "Current Staffing")) < num(vf(d, "Staffing Minimum")))
        .map((d) => ({
          name: vf(d, "Department Name"),
          location: vf(d, "Location"),
          current: num(vf(d, "Current Staffing")),
          min: num(vf(d, "Staffing Minimum")),
        }));

      jsonResp(res, 200, {
        kpis: {
          openNeeds: open.length,
          criticalNeeds: critical.length,
          peopleNeeded: open.reduce((s, o) => s + (num(vf(o, "Number of People Needed")) || 1), 0),
          fillRate,
          avgTimeToFill: avgTTF,
          availableQualified,
          nearDeadline: nearDeadline.length,
          complianceBlocks: blockedMatches + complianceQueue,
          expiringCreds,
          overtimeHours: otHours,
          agencyAvoided,
          activeAssignments: assigns.filter((a) =>
            ["Confirmed", "Checked In", "In Progress", "Scheduled"].includes(vf(a, "Assignment Status"))
          ).length,
        },
        criticalList: critical
          .sort((a, b) => (daysFromToday(vf(a, "Start Date")) ?? 99) - (daysFromToday(vf(b, "Start Date")) ?? 99))
          .slice(0, 12)
          .map((o) => ({
            id: o.id,
            oid: vf(o, "Opportunity ID"),
            title: vf(o, "Opportunity Title"),
            role: vf(o, "Needed Role"),
            dept: vf(o, "Requesting Department"),
            location: vf(o, "Requesting Location"),
            urgency: vf(o, "Urgency"),
            impact: vf(o, "Patient Care Impact"),
            need: vf(o, "Number of People Needed"),
            filled: vf(o, "Filled Count"),
            shift: vf(o, "Shift Type"),
            start: vf(o, "Start Date"),
            premium: vf(o, "Premium Pay Offered"),
          })),
        nearDeadline: nearDeadline
          .sort((a, b) => a.d - b.d)
          .slice(0, 8)
          .map((x) => ({
            oid: vf(x.o, "Opportunity ID"),
            title: vf(x.o, "Opportunity Title"),
            location: vf(x.o, "Requesting Location"),
            deadline: vf(x.o, "Application Deadline"),
            daysLeft: x.d,
          })),
        shortageRoles: Object.entries(byRole)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
        byFacility: Object.entries(byFacility)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
        releasing: topN(releasing),
        receiving: topN(receiving),
        atRiskDepts,
      });
    } catch (e) {
      jsonResp(res, 500, { error: e.message });
    }
    return true;
  }

  // ── GET /api/roamcare/executive — Executive Dashboard ────────────────
  if (pathname === "/api/roamcare/executive" && req.method === "GET") {
    try {
      const [opps, assigns, employees, apps, creds] = await Promise.all([
        collect("opportunities"),
        collect("assignments"),
        collect("employees"),
        collect("applications"),
        collect("credentials"),
      ]);

      const decided = opps.filter((o) =>
        ["Filled", "Completed", "Cancelled", "Expired"].includes(vf(o, "Status"))
      );
      const filledCount = decided.filter((o) => ["Filled", "Completed"].includes(vf(o, "Status"))).length;
      const fillRate = decided.length ? Math.round((filledCount / decided.length) * 100) : 0;
      const critical = opps.filter((o) => URGENT.includes(vf(o, "Urgency")));
      const criticalDecided = critical.filter((o) =>
        ["Filled", "Completed", "Cancelled", "Expired"].includes(vf(o, "Status"))
      );
      const criticalFill = criticalDecided.length
        ? Math.round(
            (criticalDecided.filter((o) => ["Filled", "Completed"].includes(vf(o, "Status"))).length /
              criticalDecided.length) *
              100
          )
        : 0;

      const coveredHours = assigns
        .filter((a) => ["Completed", "In Progress", "Checked In"].includes(vf(a, "Assignment Status")))
        .reduce((s, a) => s + (num(vf(a, "Hours Worked")) || 12), 0);
      const agencyAvoided = Math.round(coveredHours * 95);
      const internalCost = Math.round(coveredHours * 52); // blended internal rate
      const savings = agencyAvoided - internalCost;
      const otHours = assigns.reduce((s, a) => s + num(vf(a, "Overtime Hours")), 0);

      // participation rate (employees with >=1 application)
      const participants = new Set(apps.map((a) => vf(a, "Employee")).filter(Boolean));
      const participationRate = employees.length
        ? Math.round((participants.size / employees.length) * 100)
        : 0;

      // fatigue/burnout risk
      const highFatigue = employees.filter((e) => num(vf(e, "Fatigue Risk Score")) >= 70).length;

      // participation by employment type
      const byType = {};
      employees.forEach((e) => {
        const t = vf(e, "Employment Type") || "Other";
        if (!byType[t]) byType[t] = { type: t, total: 0, participating: 0 };
        byType[t].total++;
        if (participants.has(vf(e, "Employee ID"))) byType[t].participating++;
      });

      // demand by facility & role
      const demandByFacility = {};
      const demandByRole = {};
      opps.forEach((o) => {
        const f = vf(o, "Requesting Location") || "Other";
        const r = vf(o, "Needed Role") || "Other";
        demandByFacility[f] = (demandByFacility[f] || 0) + 1;
        demandByRole[r] = (demandByRole[r] || 0) + 1;
      });

      // fill rate over time (by created week, last ~8 weeks)
      const weekly = {};
      decided.forEach((o) => {
        const d = daysFromToday(vf(o, "Created Date"));
        if (d == null) return;
        const wk = Math.floor((-d) / 7); // weeks ago
        if (wk < 0 || wk > 9) return;
        if (!weekly[wk]) weekly[wk] = { filled: 0, total: 0 };
        weekly[wk].total++;
        if (["Filled", "Completed"].includes(vf(o, "Status"))) weekly[wk].filled++;
      });
      const fillTrend = Object.entries(weekly)
        .map(([wk, v]) => ({
          label: `${wk}w ago`,
          week: +wk,
          rate: v.total ? Math.round((v.filled / v.total) * 100) : 0,
        }))
        .sort((a, b) => b.week - a.week);

      // compliance block reasons
      const blockReasons = {};
      apps
        .filter((a) => vf(a, "Application Status") === "Rejected")
        .forEach(() => (blockReasons["Credential not current"] = (blockReasons["Credential not current"] || 0) + 1));
      const expiredCreds = creds.filter((c) => vf(c, "Verification Status") === "Expired").length;
      if (expiredCreds) blockReasons["Expired credential"] = expiredCreds;

      // cross-training impact (distinct receiving depts per employee, >1)
      const deptsPerEmp = {};
      assigns.forEach((a) => {
        const e = vf(a, "Employee");
        const d = vf(a, "Receiving Department");
        if (!e || !d) return;
        (deptsPerEmp[e] = deptsPerEmp[e] || new Set()).add(d);
      });
      const crossTrained = Object.values(deptsPerEmp).filter((s) => s.size > 1).length;

      jsonResp(res, 200, {
        kpis: {
          totalOpportunities: opps.length,
          filled: filledCount,
          fillRate,
          criticalFillRate: criticalFill,
          agencyAvoided,
          estimatedSavings: savings,
          overtimeHours: otHours,
          participationRate,
          highFatigue,
          crossTrained,
          totalEmployees: employees.length,
          coveredHours,
        },
        fillTrend,
        demandByFacility: Object.entries(demandByFacility)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
        demandByRole: Object.entries(demandByRole)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10),
        participationByType: Object.values(byType).map((t) => ({
          ...t,
          rate: t.total ? Math.round((t.participating / t.total) * 100) : 0,
        })),
        blockReasons: Object.entries(blockReasons).map(([name, count]) => ({ name, count })),
      });
    } catch (e) {
      jsonResp(res, 500, { error: e.message });
    }
    return true;
  }

  // ── GET /api/roamcare/marketplace?employee=E-XXXX — personalized ─────
  if (pathname === "/api/roamcare/marketplace" && req.method === "GET") {
    try {
      const url = new URL(req.url, "http://x");
      const empId = url.searchParams.get("employee");
      const [opps, employees] = await Promise.all([
        collect("opportunities", `values[Status]="Open"`),
        collect("employees"),
      ]);
      const empSub = empId
        ? employees.find((e) => vf(e, "Employee ID") === empId)
        : employees.find((e) => vf(e, "Roaming Eligibility Status") === "Eligible");
      if (!empSub) {
        jsonResp(res, 200, { employee: null, employees: employees.map(shortEmp(vf)), opportunities: [] });
        return true;
      }
      const emp = empSub.values;
      const scored = opps
        .map((o) => {
          const r = scoreMatch(emp, o.values, {});
          return {
            oid: vf(o, "Opportunity ID"),
            id: o.id,
            title: vf(o, "Opportunity Title"),
            type: vf(o, "Opportunity Type"),
            role: vf(o, "Needed Role"),
            dept: vf(o, "Requesting Department"),
            location: vf(o, "Requesting Location"),
            shift: vf(o, "Shift Type"),
            urgency: vf(o, "Urgency"),
            duration: vf(o, "Duration"),
            start: vf(o, "Start Date"),
            premium: vf(o, "Premium Pay Offered"),
            need: vf(o, "Number of People Needed"),
            description: vf(o, "Description"),
            score: r.score,
            status: r.status,
            headline: explain(r, emp, o.values),
            reasons: r.reasons,
            missing: r.missing,
            risks: r.risks,
            certMatch: r.certMatch,
            skillMatch: r.skillMatch,
            locationMatch: r.locationMatch,
          };
        })
        .sort((a, b) => b.score - a.score);
      jsonResp(res, 200, {
        employee: {
          id: vf(empSub, "Employee ID"),
          name: `${vf(empSub, "First Name")} ${vf(empSub, "Last Name")}`,
          role: vf(empSub, "Job Title"),
          location: vf(empSub, "Home Location"),
          eligibility: vf(empSub, "Roaming Eligibility Status"),
        },
        employees: employees.map(shortEmp(vf)),
        opportunities: scored,
      });
    } catch (e) {
      jsonResp(res, 500, { error: e.message });
    }
    return true;
  }

  // ── GET /api/roamcare/matches/:oppId — live scored candidate list ────
  const mm = pathname.match(/^\/api\/roamcare\/matches\/(.+)$/);
  if (mm && req.method === "GET") {
    const oid = decodeURIComponent(mm[1]);
    try {
      const oppList = await collect("opportunities", `values[Opportunity ID]="${oid.replace(/"/g, '\\"')}"`);
      const oppSub = oppList[0];
      if (!oppSub) {
        jsonResp(res, 404, { error: "Opportunity not found" });
        return true;
      }
      const opp = oppSub.values;
      const role = vf(oppSub, "Needed Role");
      const family = vf(oppSub, "Job Family");
      // candidate pool by role then family
      let pool = await collect("employees", `values[Job Title]="${role.replace(/"/g, '\\"')}"`);
      if (pool.length < 5 && family) {
        const fam = await collect("employees", `values[Job Family]="${family.replace(/"/g, '\\"')}"`);
        const seen = new Set(pool.map((e) => e.id));
        pool = pool.concat(fam.filter((e) => !seen.has(e.id)));
      }
      const scored = pool
        .map((e) => {
          const r = scoreMatch(e.values, opp, {});
          return {
            empId: vf(e, "Employee ID"),
            name: `${vf(e, "First Name")} ${vf(e, "Last Name")}`,
            role: vf(e, "Job Title"),
            home: vf(e, "Home Location"),
            homeDept: vf(e, "Home Department"),
            fatigue: vf(e, "Fatigue Risk Score"),
            eligibility: vf(e, "Roaming Eligibility Status"),
            score: r.score,
            status: r.status,
            headline: explain(r, e.values, opp),
            reasons: r.reasons,
            missing: r.missing,
            risks: r.risks,
            certMatch: r.certMatch,
            skillMatch: r.skillMatch,
            locationMatch: r.locationMatch,
            overtimeRisk: r.overtimeRisk,
            fatigueRisk: r.fatigueRisk,
          };
        })
        .sort((a, b) => b.score - a.score);
      jsonResp(res, 200, {
        opportunity: {
          oid,
          title: vf(oppSub, "Opportunity Title"),
          role,
          location: vf(oppSub, "Requesting Location"),
          dept: vf(oppSub, "Requesting Department"),
          shift: vf(oppSub, "Shift Type"),
          requiredCerts: splitList(vf(oppSub, "Required Certifications")),
          requiredSkills: splitList(vf(oppSub, "Required Skills")),
        },
        candidates: scored,
      });
    } catch (e) {
      jsonResp(res, 500, { error: e.message });
    }
    return true;
  }

  // ── GET /api/roamcare/opportunity/:id — Opportunity 360 ──────────────
  const op = pathname.match(/^\/api\/roamcare\/opportunity\/(.+)$/);
  if (op && req.method === "GET") {
    const id = decodeURIComponent(op[1]);
    try {
      const r = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const oppSub = r.data?.submission;
      if (!oppSub) {
        jsonResp(res, 404, { error: "Opportunity not found" });
        return true;
      }
      const oid = vf(oppSub, "Opportunity ID");
      const q = `values[Opportunity]="${oid.replace(/"/g, '\\"')}"`;
      const [apps, matches, assigns] = await Promise.all([
        collect("applications", q),
        collect("matches", q),
        collect("assignments", q),
      ]);
      jsonResp(res, 200, {
        opportunity: oppSub,
        applications: apps.map((a) => ({
          id: a.id,
          appId: vf(a, "Application ID"),
          employee: vf(a, "Employee Name"),
          status: vf(a, "Application Status"),
          score: vf(a, "Match Score"),
          applied: vf(a, "Applied Date"),
        })),
        matches: matches
          .sort((a, b) => num(vf(b, "Match Score")) - num(vf(a, "Match Score")))
          .map((m) => ({
            employee: vf(m, "Employee Name"),
            score: vf(m, "Match Score"),
            status: vf(m, "Recommendation Status"),
            reason: vf(m, "Match Reason"),
            missing: vf(m, "Missing Requirements"),
            risks: vf(m, "Risk Flags"),
          })),
        assignments: assigns.map((a) => ({
          id: a.id,
          asgId: vf(a, "Assignment ID"),
          employee: vf(a, "Employee Name"),
          status: vf(a, "Assignment Status"),
          start: vf(a, "Start Date"),
          rating: vf(a, "Performance Rating"),
        })),
      });
    } catch (e) {
      jsonResp(res, 500, { error: e.message });
    }
    return true;
  }

  // ── GET /api/roamcare/employee/:id — Roaming history & profile ───────
  const ep = pathname.match(/^\/api\/roamcare\/employee\/(.+)$/);
  if (ep && req.method === "GET") {
    const id = decodeURIComponent(ep[1]);
    try {
      const r = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const empSub = r.data?.submission;
      if (!empSub) {
        jsonResp(res, 404, { error: "Employee not found" });
        return true;
      }
      const empId = vf(empSub, "Employee ID");
      const q = `values[Employee]="${empId.replace(/"/g, '\\"')}"`;
      const [apps, assigns, creds] = await Promise.all([
        collect("applications", q),
        collect("assignments", q),
        collect("credentials", q),
      ]);
      const completed = assigns.filter((a) => vf(a, "Assignment Status") === "Completed");
      const ratings = completed
        .map((a) => num(vf(a, "Performance Rating")))
        .filter((n) => n > 0);
      jsonResp(res, 200, {
        employee: empSub,
        summary: {
          totalAssignments: assigns.length,
          completed: completed.length,
          departmentsWorked: [...new Set(assigns.map((a) => vf(a, "Receiving Department")).filter(Boolean))],
          avgRating: ratings.length ? +(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : null,
          applications: apps.length,
          fatigue: num(vf(empSub, "Fatigue Risk Score")),
        },
        assignments: assigns
          .sort((a, b) => (vf(b, "Start Date") || "").localeCompare(vf(a, "Start Date") || ""))
          .map((a) => ({
            asgId: vf(a, "Assignment ID"),
            title: vf(a, "Opportunity Title"),
            dept: vf(a, "Receiving Department"),
            location: vf(a, "Receiving Location"),
            status: vf(a, "Assignment Status"),
            start: vf(a, "Start Date"),
            rating: vf(a, "Performance Rating"),
            notes: vf(a, "Completion Notes"),
          })),
        applications: apps.map((a) => ({
          title: vf(a, "Opportunity Title"),
          status: vf(a, "Application Status"),
          score: vf(a, "Match Score"),
          applied: vf(a, "Applied Date"),
        })),
        credentials: creds.map((c) => ({
          name: vf(c, "Credential Name"),
          type: vf(c, "Credential Type"),
          status: vf(c, "Verification Status"),
          expires: vf(c, "Expiration Date"),
          expiresIn: daysFromToday(vf(c, "Expiration Date")),
        })),
      });
    } catch (e) {
      jsonResp(res, 500, { error: e.message });
    }
    return true;
  }

  // ── GET /api/roamcare/compliance — compliance queue ──────────────────
  if (pathname === "/api/roamcare/compliance" && req.method === "GET") {
    try {
      const [creds, apps, matches] = await Promise.all([
        collect("credentials"),
        collect("applications"),
        collect("matches"),
      ]);
      const expiring = creds
        .map((c) => ({ c, d: daysFromToday(vf(c, "Expiration Date")) }))
        .filter((x) => vf(x.c, "Verification Status") === "Expired" || (x.d != null && x.d <= 45))
        .sort((a, b) => (a.d ?? -999) - (b.d ?? -999))
        .map((x) => ({
          employee: vf(x.c, "Employee Name"),
          credential: vf(x.c, "Credential Name"),
          status: vf(x.c, "Verification Status"),
          expires: vf(x.c, "Expiration Date"),
          daysLeft: x.d,
        }));
      const queue = apps
        .filter((a) =>
          ["Awaiting Compliance Review", "Rejected"].includes(vf(a, "Application Status"))
        )
        .map((a) => ({
          appId: vf(a, "Application ID"),
          employee: vf(a, "Employee Name"),
          opportunity: vf(a, "Opportunity Title"),
          status: vf(a, "Application Status"),
          comment: vf(a, "Compliance Comments"),
        }));
      const blocked = matches
        .filter((m) => vf(m, "Recommendation Status") === "Blocked")
        .map((m) => ({
          employee: vf(m, "Employee Name"),
          opportunity: vf(m, "Opportunity Title"),
          missing: vf(m, "Missing Requirements"),
        }));
      jsonResp(res, 200, {
        kpis: {
          expiring: expiring.filter((e) => e.status !== "Expired").length,
          expired: expiring.filter((e) => e.status === "Expired").length,
          pendingReview: queue.filter((q) => q.status === "Awaiting Compliance Review").length,
          blocked: blocked.length,
        },
        expiring,
        queue,
        blocked,
      });
    } catch (e) {
      jsonResp(res, 500, { error: e.message });
    }
    return true;
  }

  return false;
}

// short employee projection for marketplace switcher
const shortEmp = (vf) => (e) => ({
  id: vf(e, "Employee ID"),
  name: `${vf(e, "First Name")} ${vf(e, "Last Name")}`,
  role: vf(e, "Job Title"),
  location: vf(e, "Home Location"),
  eligibility: vf(e, "Roaming Eligibility Status"),
});
