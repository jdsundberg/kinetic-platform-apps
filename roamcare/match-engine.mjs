/**
 * match-engine.mjs — RoamCare explainable matching engine.
 *
 * Pure function shared by gen-seed.mjs (to pre-compute seed Match Recommendations)
 * and server.mjs (to score candidates live). Operates on plain "values" objects
 * (field name -> string), so callers pass sub.values for a submission or a raw
 * seed record's values map.
 *
 * Scoring model (base 100, per the build spec):
 *   +20 required role match
 *   +20 required certifications all present
 *   +15 required skills present (proportional)
 *   +15 availability / willingness match
 *   +10 location preference match
 *    +5 schedule (shift) preference match
 *    +5 prior successful assignment in receiving department
 *    +5 development-interest match
 *    +5 low fatigue risk
 * Deductions:
 *   -10 overtime risk        -10 recent-assignment fatigue
 *   -20 home-department staffing risk   -15 expiring credential
 *    -5 long travel          -5 manager release required
 *   -20 union / seniority conflict
 *   Missing a REQUIRED credential => automatic Block.
 */

export const splitList = (s) =>
  String(s || "")
    .split(/[;,]/)
    .map((x) => x.trim())
    .filter(Boolean);

const yes = (v) => /^(yes|true|y|1)$/i.test(String(v || "").trim());
const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};

/**
 * Score one employee against one opportunity.
 * @param {object} emp  employee values map
 * @param {object} opp  opportunity values map
 * @param {object} ctx  optional context:
 *        { homeStaffingRisk:bool, priorInDept:bool, expiringCred:string|null,
 *          today: 'YYYY-MM-DD' }
 * @returns {object} { score, status, reasons[], missing[], risks[], components,
 *                     skillMatch, certMatch, locationMatch, scheduleMatch,
 *                     overtimeRisk, fatigueRisk }
 */
export function scoreMatch(emp, opp, ctx = {}) {
  const reasons = [];
  const missing = [];
  const risks = [];
  const c = {};

  const role = (opp["Needed Role"] || "").trim();
  const empRole = (emp["Job Title"] || "").trim();
  const empFamily = (emp["Job Family"] || "").trim();
  const oppFamily = (opp["Job Family"] || "").trim();

  // ── Role (+20) ──────────────────────────────────────────────────────
  if (role && empRole && role.toLowerCase() === empRole.toLowerCase()) {
    c.role = 20;
    reasons.push(`Exact role match — employee is a ${empRole}`);
  } else if (oppFamily && empFamily && oppFamily.toLowerCase() === empFamily.toLowerCase()) {
    c.role = 8;
    reasons.push(`Adjacent role — same ${empFamily} job family`);
  } else {
    c.role = 0;
    missing.push(`Role mismatch (need ${role || "n/a"}, has ${empRole || "n/a"})`);
  }

  // ── Required certifications (+20, or BLOCK) ─────────────────────────
  const reqCerts = splitList(opp["Required Certifications"]);
  const empCerts = splitList(emp["Certifications"]).map((x) => x.toLowerCase());
  const empLic = splitList(emp["Licenses"]).map((x) => x.toLowerCase());
  const have = new Set([...empCerts, ...empLic]);
  const missingCerts = reqCerts.filter((rc) => !have.has(rc.toLowerCase()));
  let blocked = false;
  if (reqCerts.length === 0) {
    c.cert = 20;
  } else if (missingCerts.length === 0) {
    c.cert = 20;
    reasons.push(`Holds all required credentials (${reqCerts.join(", ")})`);
  } else {
    c.cert = 0;
    blocked = true;
    missingCerts.forEach((mc) => missing.push(`Missing required credential: ${mc}`));
  }
  const certMatch =
    reqCerts.length === 0 ? "N/A" : `${reqCerts.length - missingCerts.length}/${reqCerts.length}`;

  // ── Required licenses (folded into block check) ─────────────────────
  const reqLic = splitList(opp["Required Licenses"]);
  const missingLic = reqLic.filter((rl) => !have.has(rl.toLowerCase()));
  if (missingLic.length) {
    blocked = true;
    missingLic.forEach((ml) => missing.push(`Missing required license: ${ml}`));
  }

  // ── Required skills (+15 proportional) ──────────────────────────────
  const reqSkills = splitList(opp["Required Skills"]);
  const empSkills = new Set(
    [...splitList(emp["Primary Skills"]), ...splitList(emp["Secondary Skills"])].map((x) =>
      x.toLowerCase()
    )
  );
  let skillHit = reqSkills.filter((s) => empSkills.has(s.toLowerCase())).length;
  if (reqSkills.length === 0) {
    c.skill = 15;
  } else {
    c.skill = Math.round((skillHit / reqSkills.length) * 15);
    if (skillHit === reqSkills.length)
      reasons.push(`Has every required skill (${reqSkills.join(", ")})`);
    else if (skillHit > 0)
      reasons.push(`Has ${skillHit} of ${reqSkills.length} required skills`);
    else missing.push(`Lacks required skills (${reqSkills.join(", ")})`);
  }
  const skillMatch = reqSkills.length === 0 ? "N/A" : `${skillHit}/${reqSkills.length}`;

  // ── Availability / willingness (+15) ────────────────────────────────
  const shift = (opp["Shift Type"] || "").toLowerCase();
  const elig = (emp["Roaming Eligibility Status"] || "").toLowerCase();
  let avail = 15;
  if (elig && elig !== "eligible") {
    avail = 0;
    if (elig.includes("suspend") || elig.includes("ineligible")) blocked = true;
    missing.push(`Roaming eligibility: ${emp["Roaming Eligibility Status"]}`);
  } else {
    if (!yes(emp["Willing to Float"])) {
      avail -= 8;
      risks.push("Employee has not opted in to floating");
    }
    if (/night/.test(shift) && !yes(emp["Willing to Work Nights"])) {
      avail -= 5;
      risks.push("Night shift but employee prefers not to work nights");
    }
    if (/weekend|holiday/.test(shift) && !yes(emp["Willing to Work Weekends"])) {
      avail -= 4;
      risks.push("Weekend/holiday shift outside stated preference");
    }
    if (avail >= 13) reasons.push("Available and opted in for this shift type");
  }
  c.avail = Math.max(0, avail);

  // ── Location preference (+10) / travel (-5) ─────────────────────────
  const oppLoc = (opp["Requesting Location"] || "").toLowerCase();
  const prefLoc = splitList(emp["Preferred Locations"]).map((x) => x.toLowerCase());
  const homeLoc = (emp["Home Location"] || "").toLowerCase();
  let locationMatch = "Other facility";
  if (oppLoc && homeLoc && oppLoc === homeLoc) {
    c.location = 10;
    locationMatch = "Home facility";
    reasons.push("Opportunity is at employee's home facility — no travel");
  } else if (prefLoc.includes(oppLoc)) {
    c.location = 10;
    locationMatch = "Preferred facility";
    reasons.push("Opportunity is at one of the employee's preferred facilities");
  } else {
    c.location = 0;
    c.travel = -5;
    locationMatch = "Travel required";
    risks.push("Cross-campus travel required");
  }

  // ── Schedule / shift preference (+5) ────────────────────────────────
  let scheduleMatch = "Neutral";
  if (/day/.test(shift)) {
    c.schedule = 5;
    scheduleMatch = "Preferred";
  } else if (/night/.test(shift) && yes(emp["Willing to Work Nights"])) {
    c.schedule = 5;
    scheduleMatch = "Preferred";
  } else if (/weekend/.test(shift) && yes(emp["Willing to Work Weekends"])) {
    c.schedule = 5;
    scheduleMatch = "Preferred";
  } else {
    c.schedule = 0;
  }

  // ── Prior assignment in receiving department (+5) ───────────────────
  if (ctx.priorInDept) {
    c.prior = 5;
    reasons.push(`Has worked in ${opp["Requesting Department"] || "this department"} before`);
  }

  // ── Development interest (+5) ───────────────────────────────────────
  const devInterests = splitList(emp["Development Interests"]).map((x) => x.toLowerCase());
  const oppDept = (opp["Requesting Department"] || "").toLowerCase();
  if (
    devInterests.length &&
    (devInterests.includes(oppDept) ||
      devInterests.some((d) => oppDept.includes(d) || d.includes(role.toLowerCase())))
  ) {
    c.dev = 5;
    reasons.push("Aligns with the employee's stated development interests");
  }

  // ── Fatigue (+5 low / -10 high) ─────────────────────────────────────
  const fatigue = num(emp["Fatigue Risk Score"]);
  let fatigueRisk = "Low";
  if (fatigue >= 70) {
    c.fatigue = -10;
    fatigueRisk = "High";
    risks.push(`Elevated fatigue risk score (${fatigue}/100)`);
  } else if (fatigue <= 30) {
    c.fatigue = 5;
    fatigueRisk = "Low";
  } else {
    c.fatigue = 0;
    fatigueRisk = "Moderate";
  }

  // ── Overtime risk (-10) ─────────────────────────────────────────────
  let overtimeRisk = "None";
  if (yes(opp["Overtime Allowed"]) && !yes(emp["Willing to Work Overtime"])) {
    c.overtime = -10;
    overtimeRisk = "High";
    risks.push("Assignment may trigger overtime the employee has not opted into");
  } else if (yes(opp["Overtime Allowed"])) {
    overtimeRisk = "Possible";
  }

  // ── Home-department staffing risk (-20) ─────────────────────────────
  if (ctx.homeStaffingRisk) {
    c.homeRisk = -20;
    risks.push(`Releasing this employee drops ${emp["Home Department"]} below minimum staffing`);
  }

  // ── Expiring credential (-15) ───────────────────────────────────────
  if (ctx.expiringCred) {
    c.expiring = -15;
    risks.push(`${ctx.expiringCred} expires soon — verify before assignment`);
  }

  // ── Union / seniority conflict (-20) ────────────────────────────────
  if (ctx.unionConflict) {
    c.union = -20;
    risks.push("Union/seniority rules require senior staff to be offered first");
  }

  // ── Manager release required (-5) ───────────────────────────────────
  if (ctx.managerReleaseRequired) {
    c.release = -5;
    risks.push("Home manager release approval required before offer");
  }

  // ── Total & status ──────────────────────────────────────────────────
  const score = Math.max(
    0,
    Math.min(100, Object.values(c).reduce((s, n) => s + n, 0))
  );

  let status;
  if (blocked) status = "Blocked";
  else if (score >= 75) status = "Recommended";
  else if (score >= 50) status = "Needs Review";
  else status = "Not Recommended";

  return {
    score,
    status,
    reasons,
    missing,
    risks,
    components: c,
    skillMatch,
    certMatch,
    locationMatch,
    scheduleMatch,
    overtimeRisk,
    fatigueRisk,
  };
}

/** One-line plain-English headline for a scored match. */
export function explain(result, emp, opp) {
  const name = `${emp["First Name"] || ""} ${emp["Last Name"] || ""}`.trim();
  if (result.status === "Blocked") {
    return `Blocked — ${result.missing[0] || "does not meet a hard requirement"}.`;
  }
  if (result.status === "Recommended") {
    return `Strong match (${result.score}) — ${result.reasons.slice(0, 2).join("; ") || "meets the core requirements"}.`;
  }
  if (result.status === "Needs Review") {
    return `Possible match (${result.score}) — ${result.risks[0] || result.reasons[0] || "review before offering"}.`;
  }
  return `Not recommended (${result.score}) — ${result.missing[0] || result.risks[0] || "weak fit for this opportunity"}.`;
}
