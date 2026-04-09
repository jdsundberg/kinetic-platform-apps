/**
 * Credentialing — Custom API Handler
 */

export const appId = "credentials";
export const apiPrefix = "/api/cred";
export const kapp = "credentials";

// ─── App-specific helpers ──────────────────────────────────────────────────

function nowISO() { return new Date().toISOString(); }
const PROVIDER_TRANSITIONS = {
  "Active": ["Suspended", "Under Review"],
  "Suspended": ["Active", "Under Review"],
  "Under Review": ["Active", "Suspended"],
  "Expired": ["Active"],
  "Pending": ["Active"],
};
const REVIEW_TRANSITIONS = {
  "Scheduled": ["In Review"],
  "In Review": ["Approved", "Conditionally Approved", "Denied", "Tabled", "Withdrawn"],
  "Tabled": ["In Review", "Withdrawn"],
};
const APPLICATION_TRANSITIONS = {
  "Submitted": ["Document Collection", "Under Review"],
  "Document Collection": ["Under Review", "Incomplete"],
  "Under Review": ["Committee Review", "Incomplete"],
  "Committee Review": ["Approved", "Denied"],
  "Incomplete": ["Document Collection", "Withdrawn"],
};
const SANCTION_TRANSITIONS = {
  "New": ["Under Investigation", "Cleared"],
  "Under Investigation": ["Confirmed", "Cleared", "Escalated"],
  "Escalated": ["Confirmed", "Cleared"],
};
async function logActivity(auth, providerId, providerName, action, entityType, entityId, prevVal, newVal, performer, details) {
  const logId = `LOG-${Date.now()}`;
  try {
    await kineticRequest("POST", `/kapps/${KAPP}/forms/activity-log/submissions`, {
      values: {
        "Log ID": logId, "Provider Name": providerName, "Provider ID": providerId,
        "Action": action, "Entity Type": entityType, "Entity ID": entityId,
        "Previous Value": prevVal, "New Value": newVal,
        "Performed By": performer, "Timestamp": nowISO(), "Details": details,
      },
    }, auth);
  } catch (e) { console.error("Audit log failed:", e.message); }
}

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }


  const parsedUrl = new URL(req.url, "http://localhost");

  // ─── 1. GET /api/cred/dashboard ───
  if (pathname === "/api/cred/dashboard" && req.method === "GET") {
    try {
      const [providers, licenses, certifications, privileges, reviews, sanctions, applications, notifications] = await Promise.all([
        collect("providers", null, 4),
        collect("licenses", null, 8),
        collect("certifications", null, 8),
        collect("privileges", null, 8),
        collect("committee-reviews", null, 4),
        collect("sanctions", null, 4),
        collect("applications", null, 4),
        collect("notifications", null, 4),
      ]);

      const now = Date.now();
      const d30 = now + 30 * 864e5;
      const activeProviders = providers.filter(p => vf(p, "Status") === "Active").length;

      // Compliance rate: % of active providers with all credentials current
      const activeProvIds = new Set(providers.filter(p => vf(p, "Status") === "Active").map(p => vf(p, "Provider ID")));
      let compliantCount = 0;
      for (const pid of activeProvIds) {
        const pLics = licenses.filter(l => vf(l, "Provider ID") === pid);
        const pCerts = certifications.filter(c => vf(c, "Provider ID") === pid);
        const hasExpired = [...pLics, ...pCerts].some(c => vf(c, "Status") === "Expired" || vf(c, "Status") === "Revoked");
        if (!hasExpired && pLics.length > 0) compliantCount++;
      }
      const complianceRate = activeProvIds.size > 0 ? (compliantCount / activeProvIds.size * 100).toFixed(1) : "0";

      // Expiring within 30 days
      const allCreds = [...licenses, ...certifications];
      const expiring30 = allCreds.filter(c => {
        const exp = new Date(vf(c, "Expiration Date")).getTime();
        return exp > 0 && exp <= d30 && exp > now && vf(c, "Status") !== "Expired";
      }).length;

      // Pending reviews
      const pendingReviews = reviews.filter(r => ["Scheduled", "In Review", "Tabled"].includes(vf(r, "Status"))).length;

      // Open sanctions
      const openSanctions = sanctions.filter(s => ["New", "Under Investigation", "Escalated"].includes(vf(s, "Status"))).length;

      // Avg cycle time from applications
      const completedApps = applications.filter(a => vf(a, "Days In Process") && ["Approved", "Denied"].includes(vf(a, "Status")));
      const avgCycleTime = completedApps.length > 0
        ? (completedApps.reduce((s, a) => s + parseInt(vf(a, "Days In Process") || "0"), 0) / completedApps.length).toFixed(0)
        : "0";

      // Expiring credentials list (top 10 soonest)
      const expiringList = allCreds
        .filter(c => { const exp = new Date(vf(c, "Expiration Date")).getTime(); return exp > now && vf(c, "Status") !== "Expired"; })
        .sort((a, b) => new Date(vf(a, "Expiration Date")).getTime() - new Date(vf(b, "Expiration Date")).getTime())
        .slice(0, 10)
        .map(c => ({
          id: c.id, providerName: vf(c, "Provider Name"), providerId: vf(c, "Provider ID"),
          type: vf(c, "License Type") || vf(c, "Certification Type"),
          expDate: vf(c, "Expiration Date"), status: vf(c, "Status"),
        }));

      // Risk tier distribution
      const riskDist = { Low: 0, Moderate: 0, High: 0 };
      for (const p of providers) { const r = vf(p, "Risk Tier"); if (riskDist[r] !== undefined) riskDist[r]++; }

      // Sanction alerts
      const sanctionAlerts = sanctions
        .filter(s => ["New", "Under Investigation", "Escalated"].includes(vf(s, "Status")))
        .map(s => ({
          id: s.id, sanctionId: vf(s, "Sanction ID"), providerName: vf(s, "Provider Name"),
          type: vf(s, "Sanction Type"), severity: vf(s, "Severity"), status: vf(s, "Status"),
          dateDiscovered: vf(s, "Date Discovered"),
        }));

      // Recent activity
      const activityLogs = await collect("activity-log", null, 4);
      const recentActivity = activityLogs
        .sort((a, b) => (vf(b, "Timestamp") || "").localeCompare(vf(a, "Timestamp") || ""))
        .slice(0, 10)
        .map(l => ({
          action: vf(l, "Action"), providerName: vf(l, "Provider Name"),
          entityType: vf(l, "Entity Type"), performer: vf(l, "Performed By"),
          timestamp: vf(l, "Timestamp"), details: vf(l, "Details"),
        }));

      jsonResp(res, 200, {
        activeProviders, totalProviders: providers.length, complianceRate,
        expiring30, pendingReviews, openSanctions, avgCycleTime,
        expiringList, riskDist, sanctionAlerts, recentActivity,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 2. GET /api/cred/provider/:id/summary ───
  const provMatch = pathname.match(/^\/api\/cred\/provider\/([^/]+)\/summary$/);
  if (provMatch && req.method === "GET") {
    const pid = decodeURIComponent(provMatch[1]);
    try {
      const kql = `values[Provider ID] = "${pid}"`;
      const [provs, lics, certs, privs, revs, sancs, docs, apps, checks, notifs] = await Promise.all([
        collect("providers", kql, 1),
        collect("licenses", kql, 4),
        collect("certifications", kql, 4),
        collect("privileges", kql, 4),
        collect("committee-reviews", kql, 4),
        collect("sanctions", kql, 2),
        collect("documents", kql, 4),
        collect("applications", kql, 2),
        collect("monitoring-checks", kql, 4),
        collect("notifications", kql, 4),
      ]);
      if (provs.length === 0) { jsonResp(res, 404, { error: "Provider not found" }); return true; }
      const provider = provs[0];
      const map = (arr) => arr.map(s => ({ id: s.id, ...s.values }));
      jsonResp(res, 200, {
        provider: { id: provider.id, ...provider.values },
        licenses: map(lics), certifications: map(certs), privileges: map(privs),
        reviews: map(revs), sanctions: map(sancs), documents: map(docs),
        applications: map(apps), monitoringChecks: map(checks), notifications: map(notifs),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 3. GET /api/cred/stats/compliance ───
  if (pathname === "/api/cred/stats/compliance" && req.method === "GET") {
    try {
      const [providers, licenses, certifications, privileges] = await Promise.all([
        collect("providers", null, 4),
        collect("licenses", null, 8),
        collect("certifications", null, 8),
        collect("privileges", null, 8),
      ]);
      const active = providers.filter(p => vf(p, "Status") === "Active");
      const now = Date.now();

      // License verification rate
      const totalLics = licenses.length;
      const verifiedLics = licenses.filter(l => vf(l, "Verification Status") === "Primary Source Verified").length;

      // Cert verification rate
      const totalCerts = certifications.length;
      const verifiedCerts = certifications.filter(c => vf(c, "Verification Status") === "Primary Source Verified").length;

      // Insurance coverage
      const insuranceCerts = certifications.filter(c => vf(c, "Certification Type") === "Malpractice Insurance");
      const currentInsurance = insuranceCerts.filter(c => vf(c, "Status") === "Active").length;

      // FPPE/OPPE stats
      const fppeComplete = privileges.filter(p => vf(p, "FPPE Status") === "Complete").length;
      const fppeOverdue = privileges.filter(p => vf(p, "FPPE Status") === "Overdue").length;
      const oppeCurrentCount = privileges.filter(p => vf(p, "OPPE Status") === "Current").length;
      const oppeOverdue = privileges.filter(p => vf(p, "OPPE Status") === "Overdue").length;

      // DEA status
      const deaCerts = certifications.filter(c => vf(c, "Certification Type") === "DEA");
      const deaActive = deaCerts.filter(c => vf(c, "Status") === "Active").length;

      jsonResp(res, 200, {
        licenseVerificationRate: totalLics > 0 ? (verifiedLics / totalLics * 100).toFixed(1) : "0",
        certVerificationRate: totalCerts > 0 ? (verifiedCerts / totalCerts * 100).toFixed(1) : "0",
        totalLicenses: totalLics, verifiedLicenses: verifiedLics,
        totalCertifications: totalCerts, verifiedCertifications: verifiedCerts,
        insuranceCoverage: insuranceCerts.length > 0 ? (currentInsurance / insuranceCerts.length * 100).toFixed(1) : "0",
        currentInsurance, totalInsurance: insuranceCerts.length,
        fppeComplete, fppeOverdue, totalFPPE: privileges.length,
        oppeCurrent: oppeCurrentCount, oppeOverdue, totalOPPE: privileges.length,
        deaActive, totalDEA: deaCerts.length,
        activeProviders: active.length, totalProviders: providers.length,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 4. GET /api/cred/stats/facilities ───
  if (pathname === "/api/cred/stats/facilities" && req.method === "GET") {
    try {
      const [facilities, providers, privileges, licenses] = await Promise.all([
        collect("facilities", null, 2),
        collect("providers", null, 4),
        collect("privileges", null, 8),
        collect("licenses", null, 8),
      ]);
      const now = Date.now();
      const d30 = now + 30 * 864e5;
      const facStats = facilities.map(f => {
        const fId = vf(f, "Facility ID");
        const facProvs = providers.filter(p => vf(p, "Primary Facility ID") === fId);
        const facPrivs = privileges.filter(p => vf(p, "Facility ID") === fId);
        const activePrivs = facPrivs.filter(p => vf(p, "Status") === "Active").length;
        const provIds = new Set(facProvs.map(p => vf(p, "Provider ID")));
        const facLics = licenses.filter(l => provIds.has(vf(l, "Provider ID")));
        const expiring = facLics.filter(l => {
          const exp = new Date(vf(l, "Expiration Date")).getTime();
          return exp > 0 && exp <= d30 && exp > now;
        }).length;
        return {
          facilityId: fId, facilityName: vf(f, "Facility Name"),
          type: vf(f, "Facility Type"), accreditation: vf(f, "Accreditation"),
          totalProviders: facProvs.length,
          activeProviders: facProvs.filter(p => vf(p, "Status") === "Active").length,
          totalPrivileges: facPrivs.length, activePrivileges: activePrivs,
          expiringCredentials: expiring,
        };
      });
      jsonResp(res, 200, { facilities: facStats });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 5. POST /api/cred/providers/:id/transition ───
  const provTransMatch = pathname.match(/^\/api\/cred\/providers\/([^/]+)\/transition$/);
  if (provTransMatch && req.method === "POST") {
    const subId = decodeURIComponent(provTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const performer = body.performer || "System";
      const r = await kineticRequest("GET", `/submissions/${subId}?include=values`, null, auth);
      if (r.status !== 200) { jsonResp(res, 404, { error: "Submission not found" }); return true; }
      const sub = r.data.submission;
      const oldStatus = sub.values?.["Status"] || "";
      const allowed = PROVIDER_TRANSITIONS[oldStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${oldStatus}" to "${newStatus}"`, allowed: allowed || [] });
        return true;
      }
      await kineticRequest("PUT", `/submissions/${subId}/values`, { "Status": newStatus }, auth);
      await logActivity(auth, sub.values["Provider ID"], sub.values["Provider Name"] || `${sub.values["Last Name"]}, ${sub.values["First Name"]}`, "Status Changed", "Provider", subId, oldStatus, newStatus, performer, `Provider status changed from ${oldStatus} to ${newStatus}`);
      jsonResp(res, 200, { success: true, oldStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 6. POST /api/cred/reviews/:id/decide ───
  const reviewMatch = pathname.match(/^\/api\/cred\/reviews\/([^/]+)\/decide$/);
  if (reviewMatch && req.method === "POST") {
    const subId = decodeURIComponent(reviewMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const r = await kineticRequest("GET", `/submissions/${subId}?include=values`, null, auth);
      if (r.status !== 200) { jsonResp(res, 404, { error: "Submission not found" }); return true; }
      const sub = r.data.submission;
      const oldStatus = sub.values?.["Status"] || "";
      const allowed = REVIEW_TRANSITIONS[oldStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${oldStatus}" to "${newStatus}"`, allowed: allowed || [] });
        return true;
      }
      const updates = { "Status": newStatus, "Decision Date": nowISO().slice(0, 10) };
      if (body.voteFor !== undefined) updates["Vote For"] = String(body.voteFor);
      if (body.voteAgainst !== undefined) updates["Vote Against"] = String(body.voteAgainst);
      if (body.voteAbstain !== undefined) updates["Vote Abstain"] = String(body.voteAbstain);
      if (body.conditions) updates["Conditions"] = body.conditions;
      if (body.decisionSummary) updates["Decision Summary"] = body.decisionSummary;
      if (body.nextCommittee) updates["Next Committee"] = body.nextCommittee;
      await kineticRequest("PUT", `/submissions/${subId}/values`, updates, auth);
      await logActivity(auth, sub.values["Provider ID"], sub.values["Provider Name"], "Committee Decision", "Committee Review", subId, oldStatus, newStatus, body.performer || "System", `Review ${newStatus}: ${body.decisionSummary || ""}`);
      jsonResp(res, 200, { success: true, oldStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 7. POST /api/cred/applications/:id/transition ───
  const appTransMatch = pathname.match(/^\/api\/cred\/applications\/([^/]+)\/transition$/);
  if (appTransMatch && req.method === "POST") {
    const subId = decodeURIComponent(appTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const r = await kineticRequest("GET", `/submissions/${subId}?include=values`, null, auth);
      if (r.status !== 200) { jsonResp(res, 404, { error: "Submission not found" }); return true; }
      const sub = r.data.submission;
      const oldStatus = sub.values?.["Status"] || "";
      const allowed = APPLICATION_TRANSITIONS[oldStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${oldStatus}" to "${newStatus}"`, allowed: allowed || [] });
        return true;
      }
      const updates = { "Status": newStatus };
      if (["Approved", "Denied"].includes(newStatus)) {
        updates["Completed Date"] = nowISO().slice(0, 10);
        const submitted = new Date(sub.values["Submitted Date"]);
        updates["Days In Process"] = String(Math.ceil((Date.now() - submitted.getTime()) / 864e5));
      }
      if (body.missingItems) updates["Missing Items"] = body.missingItems;
      await kineticRequest("PUT", `/submissions/${subId}/values`, updates, auth);
      await logActivity(auth, sub.values["Provider ID"], sub.values["Provider Name"], "Application Updated", "Application", subId, oldStatus, newStatus, body.performer || "System", `Application transitioned to ${newStatus}`);
      jsonResp(res, 200, { success: true, oldStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 8. POST /api/cred/sanctions/:id/transition ───
  const sancTransMatch = pathname.match(/^\/api\/cred\/sanctions\/([^/]+)\/transition$/);
  if (sancTransMatch && req.method === "POST") {
    const subId = decodeURIComponent(sancTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const r = await kineticRequest("GET", `/submissions/${subId}?include=values`, null, auth);
      if (r.status !== 200) { jsonResp(res, 404, { error: "Submission not found" }); return true; }
      const sub = r.data.submission;
      const oldStatus = sub.values?.["Status"] || "";
      const allowed = SANCTION_TRANSITIONS[oldStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${oldStatus}" to "${newStatus}"`, allowed: allowed || [] });
        return true;
      }
      const updates = { "Status": newStatus };
      if (body.resolution) { updates["Resolution"] = body.resolution; updates["Resolution Date"] = nowISO().slice(0, 10); }
      if (body.escalatedTo) updates["Escalated To"] = body.escalatedTo;
      if (body.investigator) updates["Investigator"] = body.investigator;
      await kineticRequest("PUT", `/submissions/${subId}/values`, updates, auth);
      await logActivity(auth, sub.values["Provider ID"], sub.values["Provider Name"], "Sanction Updated", "Sanction", subId, oldStatus, newStatus, body.performer || "System", `Sanction ${newStatus}: ${body.resolution || ""}`);
      jsonResp(res, 200, { success: true, oldStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 9. GET /api/cred/report/:type ───
  const reportMatch = pathname.match(/^\/api\/cred\/report\/([^/]+)$/);
  if (reportMatch && req.method === "GET") {
    const reportType = decodeURIComponent(reportMatch[1]);
    try {
      const now = Date.now();
      const d30 = now + 30 * 864e5;
      const d90 = now + 90 * 864e5;

      if (reportType === "expiring") {
        const [licenses, certifications] = await Promise.all([
          collect("licenses", null, 8),
          collect("certifications", null, 8),
        ]);
        const rows = [...licenses, ...certifications]
          .filter(c => {
            const exp = new Date(vf(c, "Expiration Date")).getTime();
            return exp > 0 && exp <= d90 && exp > now;
          })
          .sort((a, b) => new Date(vf(a, "Expiration Date")).getTime() - new Date(vf(b, "Expiration Date")).getTime())
          .map(c => ({
            providerName: vf(c, "Provider Name"), providerId: vf(c, "Provider ID"),
            type: vf(c, "License Type") || vf(c, "Certification Type"),
            number: vf(c, "License Number") || vf(c, "Certificate Number"),
            expDate: vf(c, "Expiration Date"), status: vf(c, "Status"),
            daysLeft: Math.ceil((new Date(vf(c, "Expiration Date")).getTime() - now) / 864e5),
          }));
        jsonResp(res, 200, { title: "Expiring Credentials Report", rows });
      } else if (reportType === "verification") {
        const [licenses, certifications] = await Promise.all([
          collect("licenses", null, 8),
          collect("certifications", null, 8),
        ]);
        const rows = [...licenses, ...certifications]
          .map(c => ({
            providerName: vf(c, "Provider Name"), providerId: vf(c, "Provider ID"),
            type: vf(c, "License Type") || vf(c, "Certification Type"),
            verificationStatus: vf(c, "Verification Status"),
            verificationDate: vf(c, "Verification Date"),
            status: vf(c, "Status"),
          }));
        jsonResp(res, 200, { title: "Verification Status Report", rows });
      } else if (reportType === "sanctions") {
        const sanctions = await collect("sanctions", null, 4);
        const rows = sanctions.map(s => ({
          providerName: vf(s, "Provider Name"), providerId: vf(s, "Provider ID"),
          type: vf(s, "Sanction Type"), severity: vf(s, "Severity"),
          status: vf(s, "Status"), dateDiscovered: vf(s, "Date Discovered"),
          resolution: vf(s, "Resolution"),
        }));
        jsonResp(res, 200, { title: "Sanctions Report", rows });
      } else if (reportType === "privileges") {
        const privileges = await collect("privileges", null, 8);
        const rows = privileges.map(p => ({
          providerName: vf(p, "Provider Name"), providerId: vf(p, "Provider ID"),
          privilegeName: vf(p, "Privilege Name"), category: vf(p, "Privilege Category"),
          facility: vf(p, "Facility"), status: vf(p, "Status"),
          fppeStatus: vf(p, "FPPE Status"), oppeStatus: vf(p, "OPPE Status"),
          documented: vf(p, "Documented Cases"), required: vf(p, "Required Case Volume"),
        }));
        jsonResp(res, 200, { title: "Privilege Status Report", rows });
      } else if (reportType === "committee") {
        const reviews = await collect("committee-reviews", null, 8);
        const rows = reviews.map(r => ({
          providerName: vf(r, "Provider Name"), reviewType: vf(r, "Review Type"),
          committee: vf(r, "Committee"), status: vf(r, "Status"),
          meetingDate: vf(r, "Meeting Date"), decisionDate: vf(r, "Decision Date"),
          voteFor: vf(r, "Vote For"), voteAgainst: vf(r, "Vote Against"),
          summary: vf(r, "Decision Summary"),
        }));
        jsonResp(res, 200, { title: "Committee Decision Report", rows });
      } else if (reportType === "providers") {
        const providers = await collect("providers", null, 4);
        const rows = providers.map(p => ({
          providerId: vf(p, "Provider ID"),
          name: `${vf(p, "Last Name")}, ${vf(p, "First Name")} ${vf(p, "Credentials")}`,
          specialty: vf(p, "Specialty"), facility: vf(p, "Primary Facility"),
          department: vf(p, "Department"), employment: vf(p, "Employment Type"),
          status: vf(p, "Status"), riskTier: vf(p, "Risk Tier"),
          startDate: vf(p, "Start Date"),
        }));
        jsonResp(res, 200, { title: "Provider Roster Report", rows });
      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${reportType}` });
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 10. GET /api/cred/search?q=&type= ───
  if (pathname === "/api/cred/search" && req.method === "GET") {
    const q = (parsedUrl.searchParams.get("q") || "").toLowerCase();
    const type = parsedUrl.searchParams.get("type") || "all";
    if (!q || q.length < 2) { jsonResp(res, 400, { error: "Query too short" }); return true; }
    try {
      const results = [];
      const matchesName = (s) => {
        const name = (vf(s, "Provider Name") || `${vf(s, "Last Name")} ${vf(s, "First Name")}`).toLowerCase();
        const pid = (vf(s, "Provider ID") || "").toLowerCase();
        return name.includes(q) || pid.includes(q);
      };

      if (type === "all" || type === "providers") {
        const provs = await collect("providers", null, 4);
        for (const p of provs) {
          const name = `${vf(p, "Last Name")}, ${vf(p, "First Name")}`.toLowerCase();
          const pid = vf(p, "Provider ID").toLowerCase();
          const npi = vf(p, "NPI").toLowerCase();
          if (name.includes(q) || pid.includes(q) || npi.includes(q)) {
            results.push({ type: "Provider", id: p.id, name: `${vf(p, "Last Name")}, ${vf(p, "First Name")} ${vf(p, "Credentials")}`, providerId: vf(p, "Provider ID"), status: vf(p, "Status") });
          }
        }
      }
      if (type === "all" || type === "licenses") {
        const lics = await collect("licenses", null, 8);
        for (const l of lics) if (matchesName(l) || vf(l, "License Number").toLowerCase().includes(q)) {
          results.push({ type: "License", id: l.id, name: vf(l, "Provider Name"), providerId: vf(l, "Provider ID"), detail: `${vf(l, "License State")} ${vf(l, "License Type")}`, status: vf(l, "Status") });
        }
      }
      if (type === "all" || type === "certifications") {
        const certs = await collect("certifications", null, 8);
        for (const c of certs) if (matchesName(c) || vf(c, "Certificate Number").toLowerCase().includes(q)) {
          results.push({ type: "Certification", id: c.id, name: vf(c, "Provider Name"), providerId: vf(c, "Provider ID"), detail: vf(c, "Certification Type"), status: vf(c, "Status") });
        }
      }
      if (type === "all" || type === "sanctions") {
        const sancs = await collect("sanctions", null, 4);
        for (const s of sancs) if (matchesName(s)) {
          results.push({ type: "Sanction", id: s.id, name: vf(s, "Provider Name"), providerId: vf(s, "Provider ID"), detail: vf(s, "Sanction Type"), status: vf(s, "Status") });
        }
      }
      jsonResp(res, 200, { query: q, type, count: results.length, results: results.slice(0, 50) });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}

// ─── Standalone mode ───────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const http = await import("node:http");
  const https = await import("node:https");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const PORT = process.env.PORT || 3099;
  const KINETIC = process.env.KINETIC_URL || "https://localhost";
  const __dir = path.dirname(new URL(import.meta.url).pathname);

  function kineticRequest(method, apiPath, body, authHeader) {
    return new Promise((resolve, reject) => {
      const url = new URL(`/app/api/v1${apiPath}`, KINETIC);
      const headers = { "Content-Type": "application/json" };
      if (authHeader) headers["Authorization"] = authHeader;
      const payload = body ? JSON.stringify(body) : null;
      if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
      const r = https.request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
          catch { resolve({ status: res.statusCode, data: text }); }
        });
      });
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  function jsonResp(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
    res.end(JSON.stringify(data));
  }

  function readBody(req) {
    return new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c).toString())); });
  }

  async function collectByQuery(kappSlug, formSlug, kql, authHeader, maxPages = 8) {
    const all = []; let lastCreatedAt = null;
    for (let i = 0; i < maxPages; i++) {
      let url = `/kapps/${kappSlug}/forms/${formSlug}/submissions?include=values,details&limit=25`;
      let q = kql || "";
      if (lastCreatedAt) q = (q ? "(" + q + ") AND " : "") + `createdAt < "${lastCreatedAt}"`;
      if (q) url += `&q=${encodeURIComponent(q)}`;
      const r = await kineticRequest("GET", url, null, authHeader);
      const subs = r.data?.submissions || [];
      all.push(...subs);
      if (subs.length > 0) lastCreatedAt = subs[subs.length - 1].createdAt;
      if (!r.data?.nextPageToken || subs.length < 25) break;
    }
    return all;
  }

  const helpers = {
    kineticRequest, jsonResp, readBody, collectByQuery,
    vf: (s, f) => s.values?.[f] || "",
  };

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }); res.end(); return; }
    if (pathname.startsWith(apiPrefix)) {
      const handled = await handleAPI(req, res, pathname, req.headers.authorization, helpers);
      if (handled) return;
    }
    if (pathname.startsWith("/app/")) {
      const url = new URL(req.url, KINETIC);
      const headers = { ...req.headers, host: url.host }; delete headers.origin; delete headers.referer;
      const body = await readBody(req);
      const pr = https.request(url, { method: req.method, headers }, (pres) => {
        res.writeHead(pres.statusCode, { ...pres.headers, "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
        pres.pipe(res);
      });
      pr.on("error", e => { res.writeHead(502); res.end(e.message); });
      if (body.length) pr.write(body);
      pr.end(); return;
    }
    let fp = pathname === "/" ? "/index.html" : pathname;
    fp = path.join(__dir, fp);
    try { const c = fs.readFileSync(fp); res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(fp)] || "application/octet-stream" }); res.end(c); }
    catch { res.writeHead(404); res.end("Not found"); }
  });

  server.listen(PORT, () => console.log(`\n  Credentialing: http://localhost:${PORT}\n`));
}
