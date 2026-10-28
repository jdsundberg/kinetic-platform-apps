// Pure logic shared by the server, ingestion, historian and tests — no I/O here.
// IDs, the evidence/truth model (review state machine), and small value helpers.
import crypto from "crypto";
import { ID_PREFIX, PRINCIPLE_MIN_DEALS } from "../model.mjs";

// ── identifiers ──
export function newId(form) {
  const p = ID_PREFIX[form];
  if (!p) throw new Error(`no ID prefix for form ${form}`);
  return `${p}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}
// Deterministic, case-safe source identity: Kinetic unique indexes are case-insensitive, while
// Gmail/Drive/GitHub IDs are case-sensitive, so the dedup key is a hash, never the raw ID.
export function sourceIdFor(system, originalId) {
  if (!system || !originalId) throw new Error("source system and original ID are required");
  return "SR-" + crypto.createHash("sha256").update(`${system}\u0000${originalId}`).digest("hex").slice(0, 20).toUpperCase();
}
export function contentHash(text) { return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 32); }
export function nameKey(name) {
  return String(name || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\b(inc|llc|ltd|ab|ag|gmbh|corp|corporation|company|co|plc|sa|nv|bv)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

// ── list values stored as JSON arrays in text fields ──
export function parseList(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (!v) return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? x.filter(Boolean) : [String(x)]; }
  catch { return String(v).split(/[,\n]/).map(s => s.trim()).filter(Boolean); }
}
export const listValue = (arr) => JSON.stringify([...new Set((arr || []).filter(Boolean))]);
export function parseJson(v, dflt) { if (!v) return dflt; try { return JSON.parse(v); } catch { return dflt; } }

// ── evidence & truth model ──
// Evidence lives in `sources`. Facts / interpretations / narratives / lessons / claims / commitments / recollections
// live in `knowledge-entries` and move through a review state machine. An AI "Model Confidence"
// is informational only — it can never move an entry to verified; only a reviewer can.
export const REVIEW_ACTIONS = {
  approve: "verified",
  reject: "rejected",
  dispute: "disputed",
  research: "needs-research",
  supersede: "superseded",
  reopen: "proposed",
};
const TRANSITIONS = {
  proposed: ["verified", "rejected", "disputed", "needs-research", "superseded"],
  "needs-research": ["proposed", "verified", "rejected", "disputed", "superseded"],
  disputed: ["verified", "rejected", "needs-research", "superseded", "proposed"],
  verified: ["disputed", "superseded"],
  rejected: ["proposed"],
  superseded: [],
};
// Knowledge types that assert something about the past and therefore need evidence to be verified.
const EVIDENCE_REQUIRED = new Set(["fact", "narrative", "lesson", "summary", "interpretation", "commitment",
  "principle", "pricing-model", "deal", "objection", "competitor", "partner-model", "approved-answer"]);

// Extra conditions a sales record must meet before its knowledge entry can be verified (checked by the
// review service, which loads the record). Returns an error message, or "" when the record qualifies.
export function salesVerifyError(knowledgeType, record) {
  if (knowledgeType === "principle") {
    const deals = parseList(record?.["Deal IDs"]);
    if (deals.length < PRINCIPLE_MIN_DEALS)
      return `A principle needs at least ${PRINCIPLE_MIN_DEALS} linked deals before it can be verified (it has ${deals.length}) — one deal is an anecdote, not a pattern`;
  }
  return "";
}

export function reviewTransition(entry, action, { reviewer, actorType = "user", comment, supersededBy, now = new Date().toISOString() } = {}) {
  const v = entry.values || entry;
  const from = v["Review Status"] || "proposed";
  const to = REVIEW_ACTIONS[action];
  if (!to) return { ok: false, error: `Unknown review action "${action}"` };
  if (!reviewer) return { ok: false, error: "A named reviewer is required" };
  if (!(TRANSITIONS[from] || []).includes(to)) return { ok: false, error: `Cannot ${action} an entry that is ${from}` };
  const sources = parseList(v["Supporting Source IDs"]);
  if (to === "verified" && EVIDENCE_REQUIRED.has(v["Knowledge Type"]) && sources.length === 0)
    return { ok: false, error: `A ${v["Knowledge Type"]} cannot be verified without at least one supporting source` };
  // Human approval is the only path to established history: agents and connectors may propose,
  // dispute or ask for research, but never verify.
  if (to === "verified" && actorType !== "user")
    return { ok: false, error: "Only a human reviewer can verify knowledge" };
  if ((to === "disputed" || to === "rejected" || to === "needs-research") && !String(comment || "").trim())
    return { ok: false, error: "A comment is required when disputing, rejecting or requesting research" };
  if (to === "superseded" && !supersededBy) return { ok: false, error: "Superseding requires the ID of the replacing entry" };
  const history = parseJson(v["Review History"], []);
  history.push({ at: now, by: reviewer, actorType, action, from, to, comment: comment || "" });
  const values = { "Review Status": to, "Review History": JSON.stringify(history), "Last Reviewed At": now };
  if (to === "verified") { values["Verified By"] = reviewer; values["Verified At"] = now; }
  if (from === "verified" && to !== "verified") { values["Verified By"] = ""; values["Verified At"] = ""; }
  if (to === "superseded") values["Superseded By"] = supersededBy;
  return { ok: true, from, to, values };
}

// New knowledge always starts proposed, whoever (or whatever) created it.
export function newKnowledgeValues(input, { actor, actorType = "user", now = new Date().toISOString(), form = "knowledge-entries" } = {}) {
  const type = input.knowledgeType || input["Knowledge Type"];
  const title = (input.title || input["Title"] || "").trim();
  const statement = (input.statement || input["Statement"] || "").trim();
  if (!type) throw new Error("Knowledge Type is required");
  if (!title) throw new Error("Title is required");
  if (!statement) throw new Error("Statement is required");
  const conf = input.modelConfidence ?? input["Model Confidence"] ?? "";
  return {
    "Knowledge ID": input.knowledgeId || newId(form),
    "Knowledge Type": type,
    "Subject Type": input.subjectType || input["Subject Type"] || "",
    "Subject ID": input.subjectId || input["Subject ID"] || "",
    "Company ID": input.companyId || input["Company ID"] || "",
    "Title": title.slice(0, 250),
    "Statement": statement,
    "Supporting Source IDs": listValue(parseList(input.sourceIds ?? input["Supporting Source IDs"])),
    "Extraction Method": input.extractionMethod || input["Extraction Method"] || (actorType === "user" ? "manual" : "rule-based"),
    "Model Confidence": conf === "" ? "" : String(conf),
    "Review Status": "proposed",
    "Contradicts": listValue(parseList(input.contradicts ?? input["Contradicts"])),
    "Supersedes": input.supersedes || "",
    "Job ID": input.jobId || "",
    "Review History": JSON.stringify([{ at: now, by: actor, action: "propose", from: "", to: "proposed", comment: input.note || "" }]),
    "Record Status": "active",
    "Created Via": actorType,
    "Lens": input.lens || input["Lens"] || "",
  };
}

// Competing claims are preserved: when two entries about the same subject contradict, both stay and
// each is linked to the other; neither overwrites the other.
export function linkContradiction(a, b) {
  const av = parseList(a["Contradicts"]), bv = parseList(b["Contradicts"]);
  return { a: listValue([...av, b["Knowledge ID"]]), b: listValue([...bv, a["Knowledge ID"]]) };
}

// ── dates ──
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, "0");
// Returns { date: "YYYY-MM-DD" | "YYYY-MM" | "YYYY", precision } or null. Only parses what is literally there.
export function parseDateMention(text) {
  const s = String(text || "");
  let m = s.match(/\b(\d{1,2})[\s-]?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*[\s-]?(\d{2}|\d{4})\b/i);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return { date: `${y}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(+m[1])}`, precision: "exact" }; }
  m = s.match(/(?<!\d)(19|20)(\d{2})[-.](\d{2})[-.](\d{2})(?!\d)/);
  if (m) return { date: `${m[1]}${m[2]}-${m[3]}-${m[4]}`, precision: "exact" };
  m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+((?:19|20)\d{2})\b/i);
  if (m) return { date: `${m[2]}-${pad(MONTHS[m[1].toLowerCase()])}`, precision: "month" };
  m = s.match(/\b(?:fy|q[1-4]\s*)?((?:19|20)\d{2})\b/i);
  if (m) return { date: m[1], precision: "year" };
  return null;
}
export function sortableDate(d) { return d ? String(d).padEnd(10, d.length === 4 ? "-00-00" : "-00").slice(0, 10) : ""; }

export function canReview(roles) { return !!(roles && (roles.admin || roles.reviewer)); }
