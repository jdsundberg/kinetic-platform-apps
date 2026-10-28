// RFP Intelligence — question/answer extraction, normalization, similarity and categorization.
// Pure functions over a parsed DocModel (lib/docparse.mjs); no I/O.
//
// The one rule that matters: nothing here writes an answer. Every answer comes verbatim from a cell or
// paragraph of the source document, with that location. When the pairing of a question and an answer is
// inferred rather than declared by the document's own structure (a labelled response column, "Response:"),
// the row is marked needs_review; when no answer exists it is unanswered.
import { locLabel, locKey } from "./docparse.mjs";
import crypto from "crypto";

export const CATEGORIES = [
  ["product-capabilities", "Product capabilities"], ["architecture", "Architecture"], ["deployment-hosting", "Deployment and hosting"],
  ["security", "Security"], ["compliance-certifications", "Compliance and certifications"], ["authn-authz", "Authentication and authorization"],
  ["integrations-apis", "Integrations and APIs"], ["scalability-performance", "Scalability and performance"], ["high-availability", "High availability"],
  ["backup-dr", "Backup and disaster recovery"], ["accessibility", "Accessibility"], ["support-maintenance", "Support and maintenance"],
  ["implementation-services", "Implementation services"], ["training-documentation", "Training and documentation"], ["pricing-licensing", "Pricing and licensing"],
  ["company-background", "Company background"], ["customer-references", "Customer references"], ["contractual-legal", "Contractual and legal"],
  ["ai-capabilities", "AI capabilities"], ["data-management-privacy", "Data management and privacy"],
];
export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);
// Answers in these categories make security, compliance, financial, legal or contractual commitments: approving
// one needs an explicit confirmation and a comment from the reviewer.
export const SENSITIVE_CATEGORIES = new Set(["security", "compliance-certifications", "authn-authz", "pricing-licensing", "contractual-legal",
  "data-management-privacy", "high-availability", "backup-dr"]);

// keyword → weight per category (matched on word boundaries against the lower-cased question)
const KW = {
  "product-capabilities": ["functionality:1", "feature:1", "capabilit:1", "workflow:1", "portal:1", "catalog:1", "ticket:1", "incident:1", "service request:1", "knowledge base:1", "dashboard:1", "report:0.5", "form:0.5", "notification:1", "approval:1", "self-service:1", "change management:1", "problem management:1", "asset:1", "case management:1"],
  architecture: ["architecture:2", "multi-tenant:2", "multitenant:2", "microservice:2", "database:1", "technology stack:2", "tech stack:2", "component:1", "platform design:1", "scalable architecture:1"],
  "deployment-hosting": ["hosted:2", "hosting:2", "cloud:1.5", "saas:2", "on-premise:2", "on premise:2", "on-prem:2", "aws:1.5", "azure:1", "data center:2", "datacenter:2", "region:1", "deploy:1", "environment:0.5", "kinops:1", "physically:1"],
  security: ["security:2", "vulnerabilit:2", "penetration:2", "pen test:2", "encrypt:2", "firewall:2", "malware:2", "antivirus:2", "siem:2", "intrusion:2", "patch:1", "harden:2", "nist:1.5", "audit log:1.5", "logging:1", "threat:1.5", "security incident:2", "breach:2", "control:0.5"],
  "compliance-certifications": ["soc 2:3", "soc2:3", "soc 1:2", "iso 27001:3", "iso:1", "fedramp:3", "stateramp:3", "hipaa:3", "pci:2", "cjis:3", "certification:2", "certified:2", "attestation:2", "compliance:1.5", "compliant:1", "audit report:2", "irs 1075:3"],
  "authn-authz": ["single sign-on:3", "sso:3", "saml:3", "oauth:2", "oidc:2", "openid:2", "ldap:2", "active directory:2", "entra:2", "mfa:3", "multi-factor:3", "two-factor:3", "role-based:2", "rbac:2", "permission:1.5", "authentication:2", "authorization:2", "password:2", "identity provider:3", "account management:1.5", "privileged:1"],
  "integrations-apis": ["api:2", "apis:2", "rest:1.5", "integration:2", "integrate:2", "webhook:2", "connector:1.5", "interface:1", "soap:2", "import:1", "export:0.5", "teams integration:2", "email integration:1"],
  "scalability-performance": ["performance:2", "scalab:2", "scale:1", "concurrent:2", "response time:2", "throughput:2", "load test:2", "capacity:1.5", "latency:2"],
  "high-availability": ["availability:2", "uptime:3", "redundan:2", "failover:3", "99.9:3", "high availability:3", "fault toleran:2"],
  "backup-dr": ["backup:3", "back up:2", "disaster recovery:3", "rto:3", "rpo:3", "restore:2", "recovery:1.5", "business continuity:3", "continuity:1.5"],
  accessibility: ["accessib:3", "wcag:3", "508:3", "vpat:3", "screen reader:3", "ada:1.5"],
  "support-maintenance": ["support hours:3", "help desk:2", "helpdesk:2", "maintenance:2", "upgrade:2", "release:1", "support tier:2", "technical support:2", "24x7:2", "24/7:2", "support:0.8", "service level:1.5", "sla:1.5"],
  "implementation-services": ["implementation:3", "implement:1.5", "project plan:2", "work plan:2", "configuration:1", "migration:2", "data conversion:3", "go-live:3", "go live:3", "professional services:2", "consulting:1.5", "deliverable:1.5", "onboarding:1.5"],
  "training-documentation": ["training:3", "train:2", "documentation:2", "user guide:2", "manual:1.5", "knowledge transfer:3", "train-the-trainer:3"],
  "pricing-licensing": ["price:3", "pricing:3", "cost:2", "license:2", "licensing:3", "subscription:2", "fee:2", "invoice:1.5", "payment:1.5", "rate:0.5"],
  "company-background": ["company:1", "years in business:3", "headquarter:2", "employees:2", "financial:1.5", "ownership:2", "legal name:3", "founded:2", "organization chart:2", "subcontractor:1", "partnerships:1", "product line:1.5"],
  "customer-references": ["reference:3", "references:3", "similar customers:2", "case stud:2", "past performance:3", "current clients:2", "clients:1"],
  "contractual-legal": ["contract:2", "terms and conditions:3", "liability:3", "indemn:3", "insurance:3", "warranty:2", "termination:2", "legal:1.5", "exception:1", "governing law:3", "intellectual property:2"],
  "ai-capabilities": ["artificial intelligence:3", "ai:2", "machine learning:3", "natural language:2", "chatbot:3", "llm:3", "generative:3", "virtual agent:3", "predictive:1.5"],
  "data-management-privacy": ["data retention:3", "retention:2", "privacy:3", "pii:3", "personal information:3", "data ownership:3", "data residency:3", "records:1", "purge:2", "data classification:3", "sensitive data:2", "gdpr:3", "ccpa:3", "confidential:1"],
};
const KW_RE = Object.fromEntries(Object.entries(KW).map(([c, list]) => [c, list.map(k => { const [w, n] = k.split(":"); return [new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), +n]; })]));

// Rule-based suggestion: { category, tags, scores }. Always a suggestion — a person can change it.
export function classify(text, context = "") {
  const t = ` ${String(text || "").toLowerCase()} `, c = ` ${String(context || "").toLowerCase()} `;
  const scores = {};
  for (const [cat, res] of Object.entries(KW_RE)) {
    let s = 0;
    for (const [re, w] of res) { if (re.test(t)) s += w; else if (re.test(c)) s += w * 0.4; }
    if (s > 0) scores[cat] = Math.round(s * 10) / 10;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const category = ranked[0] && ranked[0][1] >= 1 ? ranked[0][0] : "";
  return { category, tags: ranked.filter(([, s]) => s >= 1.5).map(([k]) => k).slice(0, 4), scores };
}

// ── normalization & similarity ──
const STOP = new Set("a an the and or of to in on for with by is are be been being do does did can could will would shall should may might must your you our we it its this that these those as at from how what which who whom when where why please describe explain provide list identify indicate confirm state any all each other such if than then there their they them also into via per about vendor proposer offeror bidder contractor solution system".split(" "));
const SYN = [
  ["sso", "saml", "single sign on", "signon", "identity provider", "idp", "okta", "entra", "azure ad", "federat", "oidc", "openid"],
  ["mfa", "multi factor", "two factor", "2fa"],
  ["encrypt", "encryption", "tls", "aes"],
  ["backup", "back up", "restore", "disaster recovery", "rpo", "rto"],
  ["availability", "uptime", "failover", "redundan"],
  ["accessib", "wcag", "508", "vpat"],
  ["api", "rest", "integrat", "webhook", "connector"],
  ["host", "cloud", "saas", "data center", "aws"],
  ["price", "pricing", "cost", "fee", "licens", "subscript"],
  ["train", "training", "documentation"],
  ["reference", "past performance", "case study"],
  ["ai", "artificial intelligence", "machine learning", "chatbot", "virtual agent", "llm"],
];
const SYN_KEY = new Map(); SYN.forEach((g, i) => g.forEach(w => SYN_KEY.set(w, `§${i}`)));
const stem = (w) => w.length > 4 ? w.replace(/(ations?|ings?|ments?|ness|ities|ity|ies|ied|ed|es|s)$/, "") : w;
export function normalizeText(text) {
  return String(text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[“”"'’‘`]/g, "").replace(/[^a-z0-9.\s-]/g, " ").replace(/(\D)\.|\.(\D)/g, "$1 $2").replace(/\s+/g, " ").trim();
}
export function tokens(text) {
  // hyphens read as spaces for phrases ("sign-on" = "sign on"); a matched phrase stands for its words
  let n = ` ${normalizeText(text).replace(/-/g, " ")} `; const out = new Set();
  for (const [phrase, key] of SYN_KEY) if (phrase.includes(" ") && n.includes(` ${phrase}`)) { out.add(key); n = n.split(phrase).join(" "); }
  for (const w of n.trim().split(/[\s-]+/)) {
    if (!w || STOP.has(w) || (w.length < 2 && !/\d/.test(w))) continue;
    const s = stem(w); let key = null;
    for (const [phrase, k] of SYN_KEY) if (!phrase.includes(" ") && (s === phrase || s.startsWith(phrase))) { key = k; break; }
    out.add(key || s);
  }
  return [...out];
}
// Weighted overlap of two token sets (0–1). Synonym groups count as one shared concept.
export function similarity(a, b) {
  const A = new Set(Array.isArray(a) ? a : tokens(a)), B = new Set(Array.isArray(b) ? b : tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter += t.startsWith("§") ? 1.5 : 1;
  const w = (S) => [...S].reduce((n, t) => n + (t.startsWith("§") ? 1.5 : 1), 0);
  return Math.min(1, inter / Math.sqrt(w(A) * w(B)));
}
export const normalizedKey = (text) => crypto.createHash("sha256").update(tokens(text).sort().join(" ")).digest("hex").slice(0, 24).toUpperCase();
export const hashKey = (...parts) => crypto.createHash("sha256").update(parts.map(String).join("\u0000")).digest("hex").slice(0, 24).toUpperCase();

// ── requirement level (only where the document states it) ──
const LEVEL_VALUES = [[/^(m|mandatory|required|must|must have|shall|req|yes - mandatory)$/i, "mandatory"], [/^(d|o|desirable|desired|optional|should have|nice to have|nice-to-have|preferred|should|may|could have)$/i, "optional"]];
export function levelFromValue(v) { const s = String(v || "").trim(); for (const [re, l] of LEVEL_VALUES) if (re.test(s)) return l; return ""; }
export function levelFromText(text) {
  const t = String(text || "");
  if (/\((mandatory|required|m)\)|\bmandatory\b/i.test(t)) return { level: "mandatory", basis: "labelled mandatory in the text" };
  if (/\((desirable|optional|d)\)|\b(desirable|optional)\b/i.test(t)) return { level: "optional", basis: "labelled optional in the text" };
  if (/\b(shall|must)\b/i.test(t)) return { level: "mandatory", basis: "wording: shall/must" };
  return { level: "unspecified", basis: "" };
}

// ── question-likeness ──
const IMPERATIVE = /^(please\s+)?(describe|explain|provide|list|identify|indicate|confirm|detail|outline|specify|state whether|discuss|demonstrate|summarize|include|attach|submit)\s+[a-z(“"]/;
const INTERROGATIVE = /^(does|do|is|are|can|will|would|has|have|what|how|where|when|which|who|why)\b/i;
const REQ = /^(ability to|able to|support|supports|provide|the (system|solution|vendor|contractor|proposer|offeror) (shall|must|should|will)|system (shall|must)|must|shall)\b|\b(shall|must)\b/i;
const ANSWERISH = /^(yes|no|n\/a|included|supported|not supported|partially|kinetic|we |our |the kinetic|available|provided|see )/i;
// A question: ends with "?", or an imperative sentence ("Describe your …"), or an interrogative with a clear subject.
const looksQuestion = (t) => {
  t = String(t || "").trim();
  if (t.length < 12 || (t === t.toUpperCase() && /[A-Z]{4}/.test(t))) return false;
  if (/\?\s*$/.test(t)) return true;
  const body = t.replace(/^(please\s+)/i, "");
  if (IMPERATIVE.test(body.charAt(0).toLowerCase() + body.slice(1)) && t.length >= 25) return true;
  return INTERROGATIVE.test(t) && t.length >= 40 && /\b(you|your|the (system|solution|proposer|vendor|platform|product|offeror|contractor))\b/i.test(t);
};
const looksRequirement = (t) => { t = String(t || "").trim(); return t.length > 12 && REQ.test(t); };
const ID_RE = /^([A-Z]{1,8}[-_ ]?\d+[A-Za-z]?([.\-_(]\d+\)?)*|\d+(\.\d+)*\.?|[A-Z]\.\d+(\.\d+)*|Q\d+|\(?[a-z]\)|[ivx]+\.)$/;
const isId = (t) => ID_RE.test(String(t || "").trim()) && String(t).trim().length <= 20;

// header vocabularies
const H_Q = /\b(question|questions|requirement|requirements|control name|control enhancement|use case details?|features?|task description|criteria|specification|item description|topics?|query)\b/i;
const H_QWEAK = /\bdescription\b/i;   // "Description" heads question columns and answer columns alike
const H_A = /\b(response|responses|answer|answers|vendor notes|notes|comments?|explain|explanation|describe how|how .* (met|supported|provided)|proposer|offeror|bidder|contractor response|reply|remarks|narrative|details of compliance)\b/i;
const H_C = /\b(compl(y|iance|iant)|able to provide|able to offer|how are you able|supported|availability|status|implemented|y\/n|yes\/no|meets?|met|managed by|implemented as|capabilit)/i;
const H_L = /\b(priorit|mandatory|importance|criticality|m\/d|must have|required\?)/i;
const H_ID = /^(#|no\.?|num(ber)?|id|ref(erence)?( no\.?| #)?|item( no\.?| #)?|req(uirement)?\.? ?(id|#|no\.?|number)|q(uestion)? ?(#|no\.?|number)|control)$/i;

// ── tables ──
export function analyzeTable(table, role) {
  const rows = table.rows.filter(r => r.some(c => String(c.text).trim()));
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map(r => r.length));
  const cell = (r, c) => String(rows[r]?.[c]?.text || "").trim();
  // header: the row (within the first 25) whose short cells best match the vocabularies
  let best = { score: 0, row: -1 };
  for (let r = 0; r < Math.min(25, rows.length - 1); r++) {
    let s = 0, filled = 0, hits = 0;
    for (let c = 0; c < width; c++) {
      const t = cell(r, c); if (!t) continue; filled++;
      if (t.length > 90) { s -= 0.5; continue; }
      const before = s;
      if (H_Q.test(t)) s += 2; else if (H_QWEAK.test(t)) s += 1; if (H_A.test(t)) s += 2; if (H_C.test(t)) s += 1; if (H_L.test(t)) s += 1; if (H_ID.test(t)) s += 1;
      if (s > before) hits++;
    }
    // a header names at least two of its columns (one matching cell is usually a data row that mentions "questions")
    if (filled >= 2 && hits >= 2 && s > best.score) best = { score: s, row: r };
  }
  const headerRow0 = best.score >= 3 ? best.row : -1;
  // sub-header rows right under the header: only short labels, no IDs, no long text (e.g. "Agency | Vendor | Base | Add-on")
  let headerRow = headerRow0;
  while (headerRow >= 0 && headerRow + 1 < rows.length - 1) {
    const r = rows[headerRow + 1].map(c => String(c.text || "").trim()).filter(Boolean);
    if (r.length >= 3 && r.every(t => t.length <= 40 && !isId(t) && !/^(x|✓|✔|yes|no)$/i.test(t))) headerRow++; else break;
  }
  // merged ranges: sheet coordinates → does a merged banner at (row, col) cover column c?
  const merges = table.merges || [];
  const covers = (rowIdx, k, c) => {
    if (k === c) return true;
    const loc = rows[rowIdx]?.[k]?.loc; if (!loc?.row) return false;
    return merges.some(m => m.r1 <= loc.row && loc.row <= m.r2 && m.c1 === loc.col && m.c2 >= c + 1) || (rows[rowIdx][k].span || 1) > c - k;
  };
  // multi-row headers: a column's label joins its header cell with up to three banner rows above it
  const band = (c) => {
    if (headerRow < 0) return "";
    const parts = [];
    for (let r = Math.max(0, headerRow - 4); r <= headerRow; r++) {
      let t = cell(r, c);
      if (!t) for (let k = c - 1; k >= 0; k--) { if (cell(r, k)) { if (covers(r, k, c)) t = cell(r, k); break; } }
      if (t && t.length <= 300 && !parts.includes(tidy(t))) parts.push(tidy(t));
    }
    return parts.join(" / ");
  };
  const tidy = (t) => t.replace(/\s+/g, " ").trim().slice(0, 120);
  const label = (c) => { if (headerRow < 0) return ""; for (let r = headerRow; r >= Math.max(0, headerRow - 4); r--) { const t = cell(r, c); if (t && t.length <= 300) return tidy(t); } return ""; };
  // banner rows spanning several columns (e.g. "Phase 1 Bid Response" over D:L) are inherited by the columns to their right
  // the nearest label above this column's own header cell that spans it (a merged banner, or its own cell)
  const banner = (c) => {
    if (headerRow < 0) return "";
    for (let r = headerRow - 1; r >= Math.max(0, headerRow - 4); r--) for (let k = c; k >= 0; k--) { const t = cell(r, k); if (t) { if (covers(r, k, c)) return tidy(t); break; } }
    return "";
  };
  const start = headerRow + 1, data = rows.slice(start);
  const stats = Array.from({ length: width }, (_, c) => {
    const vals = data.map(r => String(r[c]?.text || "").trim()).filter(Boolean);
    const distinct = new Set(vals.map(v => v.toLowerCase()));
    const avg = vals.length ? vals.reduce((n, v) => n + v.length, 0) / vals.length : 0;
    return {
      c, label: label(c), band: band(c), banner: banner(c), fill: data.length ? 0 : 0, filled: vals.length, avg, distinct: distinct.size,
      q: vals.length ? vals.filter(looksQuestion).length / vals.length : 0,
      req: vals.length ? vals.filter(looksRequirement).length / vals.length : 0,
      ans: vals.length ? vals.filter(v => ANSWERISH.test(v)).length / vals.length : 0,
      id: vals.length ? vals.filter(isId).length / vals.length : 0,
      x: vals.length ? vals.filter(v => /^(x|✓|✔|yes|no|y|n)$/i.test(v)).length / vals.length : 0,
      lvl: vals.length ? vals.filter(v => levelFromValue(v)).length / vals.length : 0,
    };
  });
  const used = (s) => s.filled > 0;
  const dataRows = Math.max(1, data.length);
  const hA = (s) => H_A.test(s.band) || H_A.test(s.banner);
  // question column
  const qScore = (s) => (H_Q.test(s.band) ? 2.5 : H_QWEAK.test(s.band) ? 1 : 0) + s.q * 4 + s.req * 2.5 - s.ans * 3 - s.id * 4 - s.x * 4 - s.lvl * 4
    + Math.min(s.avg, 120) / 60 - (hA(s) ? 3 : 0) + Math.min(1, s.filled / dataRows) * 2 - (s.avg > 220 ? 1.5 : 0);
  const qCandidates = stats.filter(s => used(s) && s.avg >= 12).sort((a, b) => qScore(b) - qScore(a));
  const qCol = qCandidates[0];
  if (!qCol || qScore(qCol) < 1.2) return { headerRow, skipped: `no question or requirement column found` };
  // without a header row, only columns that read as questions or requirements count
  if (headerRow < 0 && qCol.q + qCol.req < 0.35) return { headerRow, skipped: "no header row and the text does not read as questions" };
  let confident = headerRow >= 0 && (H_Q.test(qCol.band) || H_QWEAK.test(qCol.band));
  // answer columns (narrative) and compliance columns (short choices / X marks), to the right of the question
  const right = stats.filter(s => s.c > qCol.c);
  // a dropdown column: few distinct values over many rows, or X marks
  const dropdown = (s) => s.x >= 0.5 || (s.filled > 8 && s.distinct <= 8 && s.avg < 60);
  const isLevel = (s) => H_L.test(s.label) || s.lvl >= 0.6;   // a priority column is the buyer's, never an answer
  const isAnswer = (s) => !dropdown(s) && !isLevel(s) && s.id < 0.5 && ((hA(s) && s.avg >= 2) || (headerRow < 0 && s.avg >= 25 && s.q < 0.3));
  let answers = right.filter(s => used(s) && isAnswer(s));
  // a response document whose answer column has an ambiguous header ("Topics | Description"): the long free-text
  // column right of the questions is the answer, but the pairing is inferred, so every row goes to review
  if (!answers.length && role !== "solicitation") {
    answers = right.filter(s => used(s) && !dropdown(s) && !isLevel(s) && s.avg >= 25 && s.q < 0.3 && s.distinct > 1);
    if (answers.length) confident = false;
  }
  const comply = right.filter(s => used(s) && !answers.includes(s) && !isLevel(s) && s.id < 0.5 && (H_C.test(s.band) || H_C.test(s.banner) || s.x >= 0.6 || (s.distinct <= 8 && s.avg < 40 && s.filled >= 2)));
  const lvlCol = stats.find(s => used(s) && s.c !== qCol.c && (H_L.test(s.band) || s.lvl >= 0.6));
  // ID columns on either side of the question; the best-filled one first (a per-row "UC-001-01" beats a merged "UC-001")
  const idCols = stats.filter(s => used(s) && s.c !== qCol.c && (s.id >= 0.5 || (s.c < qCol.c && H_ID.test(s.label)))).sort((a, b) => b.filled - a.filled || a.c - b.c);
  // a long-text column left of the question that is mostly blank carries a heading down (merged "Use Case" cells)
  const ctxCol = stats.find(s => used(s) && s.c < qCol.c && !idCols.includes(s) && s.avg >= 8 && s.filled < data.length * 0.6);
  if (role === "response" && !answers.length && !comply.length) return { headerRow, skipped: "no response column found (a response document's table with no answers)" };
  return { headerRow, rows, qCol, answers, comply, lvlCol, idCols, ctxCol, confident };
}

function tableQuestions(table, role, ctx) {
  const a = analyzeTable(table, role);
  const where = table.name ? `worksheet "${table.name}"` : `table ${table.loc?.table || ""}`.trim();
  if (!a) return { items: [], note: null };
  if (a.skipped) return { items: [], note: `${where}: skipped — ${a.skipped}` };
  const { rows, headerRow, qCol, answers, comply, lvlCol, idCols, ctxCol, confident } = a;
  const items = []; let section = table.name || table.loc?.section || "", context = "";
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const t = (c) => String(row[c]?.text || "").trim();
    const filled = row.filter(c => String(c.text).trim());
    let qText = t(qCol.c), qLoc = row[qCol.c]?.loc;
    // the question can sit one column left when the ID column is merged with it (e.g. "AC-1 | Access Control Policy")
    if (!qText) { for (let c = qCol.c - 1; c >= 0; c--) if (t(c) && !isId(t(c)) && t(c).length > 6) { qText = t(c); qLoc = row[c].loc; break; } }
    const answerParts = answers.map(s => ({ text: String(row[s.c]?.text || ""), loc: row[s.c]?.loc, label: s.label })).filter(p => p.text.trim());
    const complyParts = comply.map(s => ({ text: String(row[s.c]?.text || "").trim(), loc: row[s.c]?.loc, label: s.label, group: s.banner && s.banner !== s.label ? s.banner : "" })).filter(p => p.text);
    // section rows: a lone label (no answer, no compliance) — e.g. "Requirements - General Functions", "AC"
    if (filled.length === 1 && !answerParts.length && !complyParts.length && (!qText || filled[0].loc === qLoc)) {
      const only = String(filled[0].text).trim();
      if (only.length < 120 && !looksQuestion(only)) { section = only; context = ""; continue; }
    }
    if (ctxCol && t(ctxCol.c)) context = t(ctxCol.c);
    if (!qText || qText.length < 4) continue;
    // a date, amount or one-word label is not a question unless the column is explicitly the question column
    if (!(H_Q.test(qCol.band)) && !looksQuestion(qText) && (qText.split(/\s+/).filter(w => /[a-z]{2}/i.test(w)).length < 4 || qText.length < 20)) continue;
    const number = idCols.map(s => t(s.c)).find(Boolean) || "";
    const lvRaw = lvlCol ? t(lvlCol.c) : "";
    const lvl = levelFromValue(lvRaw) ? { level: levelFromValue(lvRaw), basis: `${lvlCol.label || "priority column"}: ${lvRaw}` } : levelFromText(qText);
    // the X / choice marks read as "<column label>: <value>" (X marks name their column)
    const compliance = complyParts.map(p => /^(x|✓|✔)$/i.test(p.text) ? `${p.group ? p.group.replace(/[:\s]+$/, "") + ": " : ""}${p.label}` : `${p.label || "Response"}: ${p.text}`).join("; ");
    let answer = null;
    if (answerParts.length || complyParts.length) {
      const primary = answerParts.length ? answerParts : complyParts.filter(p => !/^(x|✓|✔)$/i.test(p.text));
      const parts = primary.length ? primary : complyParts;
      answer = {
        text: parts.length === 1 ? parts[0].text : parts.map(p => p.text).join("\n\n"),
        parts: parts.map(p => ({ text: p.text, loc: p.loc, label: p.label })), compliance,
        loc: parts[0].loc, locLabel: parts.map(p => locLabel(p.loc)).join(" + "),
      };
    }
    items.push({
      number, text: qText, loc: qLoc, section: context ? `${section}${section ? " › " : ""}${context}` : section, subsection: context,
      level: lvl.level, levelBasis: lvl.basis, answer,
      status: confident ? "extracted" : "needs_review",
      reason: confident ? `header "${qCol.label}"${answers[0] ? ` → "${answers[0].label}"` : ""}` : "question column inferred from the cell contents (no clear header)",
    });
  }
  return { items, note: `${where}: question column "${qCol.label || "col " + (qCol.c + 1)}"${answers.length ? `, answers from ${answers.map(s => `"${s.label || "col " + (s.c + 1)}"`).join(", ")}` : ""}${comply.length ? `, compliance from ${comply.length} column(s)` : ""}${a.lvlCol ? `, priority from "${a.lvlCol.label}"` : ""}` };
}

// ── narrative (paragraphs: Word body, PDF, text) ──
const NUM_START = /^\s*((?:Q(?:uestion)?\s*)?\d+(?:\.\d+)*[.)]?|[A-Z]\.\d+(?:\.\d+)*[.)]?|[A-Z]{1,6}-\d+(?:\.\d+)*[.):]?)\s+(.*)$/s;
const ANSWER_LABEL = /^\s*((kinetic(\s+data)?(\s+response)?|vendor\s+response|proposer\s+response|offeror\s+response|contractor\s+response|response|answer|a)\s*[:\-–—]\s*)/i;
function narrativeQuestions(blocks, role) {
  const items = []; const paras = blocks.filter(b => b.kind === "para");
  let section = "";
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]; const raw = p.text.trim();
    if (p.heading) { section = (p.list ? p.list + " " : "") + raw; continue; }
    const withLabel = (p.list ? p.list + " " : "") + raw;
    const m = NUM_START.exec(withLabel);
    const body = m ? m[2].trim() : raw;
    const isQ = looksQuestion(body) || (m && looksRequirement(body)) || (role !== "response" && looksRequirement(body) && /\b(shall|must)\b/i.test(body));
    if (!isQ || ANSWER_LABEL.test(raw)) {
      // a short line that is not a sentence acts as a heading in PDFs and text files
      if (!p.heading && raw.length < 90 && !/[.?:;,]$/.test(raw) && (/^(section\s+\d+|\d+(\.\d+)*\s+[A-Z])/i.test(raw) || (raw === raw.toUpperCase() && /[A-Z]{3}/.test(raw)))) section = raw;
      continue;
    }
    const lvl = levelFromText(body);
    const q = { number: m ? m[1].replace(/[.):]$/, "").replace(/^Q(uestion)?\s*/i, "") : (p.list || "").replace(/\.$/, ""), text: raw, loc: p.loc, section, subsection: "",
      level: lvl.level, levelBasis: lvl.basis, answer: null,
      // "?" or an imperative ask is explicit; a shall/must sentence may be an instruction to bidders rather than a requirement
      status: looksQuestion(body) ? "extracted" : "needs_review", reason: looksQuestion(body) ? (m ? "numbered question" : "question wording") : "requirement wording (shall/must) — confirm it is a requirement" };
    // the answer: following paragraphs up to the next question/heading — only in a response document
    if (role === "response" || role === "combined") {
      const parts = [];
      for (let j = i + 1; j < paras.length; j++) {
        const n = paras[j]; const nt = n.text.trim();
        if (n.heading) break;
        const nm = NUM_START.exec((n.list ? n.list + " " : "") + nt);
        if (!ANSWER_LABEL.test(nt) && (looksQuestion(nm ? nm[2] : nt) || (nm && looksRequirement(nm[2])))) break;
        parts.push(n);
        if (parts.length >= 12) break;
      }
      if (parts.length) {
        const labelled = ANSWER_LABEL.exec(parts[0].text.trim());
        const texts = parts.map((x, k) => (k === 0 && labelled ? x.text.trim().slice(labelled[1].length) : x.text));
        q.answer = { text: texts.join("\n"), parts: parts.map((x, k) => ({ text: texts[k], loc: x.loc, label: k === 0 && labelled ? labelled[1].trim() : "" })), compliance: "",
          loc: parts[0].loc, locLabel: parts.length > 1 ? `${locLabel(parts[0].loc)} – ${locLabel(parts[parts.length - 1].loc).replace(/^.*?(paragraph|line)/i, "$1")}` : locLabel(parts[0].loc) };
        if (!labelled) { q.status = "needs_review"; q.reason += "; answer inferred from the paragraphs that follow (no Response: label)"; }
        else q.reason += "; labelled answer";
      }
    }
    items.push(q);
  }
  return items;
}

const NIST_FAMILY = { AC: "access control authorization", AT: "security awareness training", AU: "audit logging security", CA: "security assessment", CM: "configuration management security",
  CP: "contingency planning backup disaster recovery", IA: "identification authentication", IR: "security incident response", MA: "maintenance security", MP: "media protection security",
  PE: "physical security", PL: "security planning", PM: "security program", PS: "personnel security", PT: "privacy pii", RA: "risk assessment security vulnerability",
  SA: "system acquisition security", SC: "system communications protection encryption security", SI: "system integrity malware security", SR: "supply chain security" };
const NIST_CATEGORY = { AC: "authn-authz", IA: "authn-authz", CP: "backup-dr", AT: "training-documentation", PT: "data-management-privacy" };

// role: "solicitation" (the buyer's questions; never yields answers), "response" (Kinetic's answers) or "combined"
export function extractQuestions(doc, { role = "response" } = {}) {
  const notes = [...(doc.warnings || [])];
  let items = [];
  for (const b of doc.blocks) if (b.kind === "table" && !b.hidden) {
    const r = tableQuestions(b, role); if (r.note) notes.push(r.note); items.push(...r.items);
  }
  // Word/PDF/text narrative questions (tables were handled above)
  const narrative = narrativeQuestions(doc.blocks, role);
  if (narrative.length) notes.push(`${narrative.length} question(s) found in the document text`);
  // keep document order: tables and paragraphs interleave by their position in the block list
  const order = new Map(); let k = 0;
  for (const b of doc.blocks) { if (b.kind === "para") order.set(locKey(b.loc), k++); else for (const row of b.rows) for (const c of row) order.set(locKey(c.loc), k++); }
  items = [...items, ...narrative].sort((a, b) => (order.get(locKey(a.loc)) ?? 0) - (order.get(locKey(b.loc)) ?? 0));
  if (role === "solicitation") for (const q of items) { q.answer = null; }
  // duplicates inside the same document (same normalized wording)
  const seen = new Map();
  items.forEach((q, i) => {
    q.seq = i + 1; q.locLabel = locLabel(q.loc); q.normalized = tokens(q.text).join(" "); q.key = normalizedKey(q.text);
    const fam = /^([A-Z]{2})-\d/.exec(q.number || "")?.[1];   // NIST 800-53 control family in the number (AC-2, CP-9 …)
    const c = classify(q.text, `${q.section} ${NIST_FAMILY[fam] || ""}`); q.category = c.category || (fam && NIST_FAMILY[fam] ? NIST_CATEGORY[fam] || "security" : ""); q.tags = c.tags;
    if (seen.has(q.key)) q.duplicateOfSeq = seen.get(q.key); else seen.set(q.key, q.seq);
    q.answerStatus = q.answer && q.answer.text.trim() ? (q.status === "needs_review" ? "needs_review" : "answered") : "unanswered";
    if (!q.answer || !q.answer.text.trim()) q.answer = null;
  });
  return { items, notes };
}

// Citation check: the stored text must be found, exactly, at its cited location in the original document.
export function verifyCitation(doc, loc, text) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  for (const b of doc.blocks) {
    if (b.kind === "para" && locKey(b.loc) === locKey(loc)) return norm(b.text).includes(norm(text).slice(0, 400));
    if (b.kind === "table") for (const row of b.rows) for (const c of row) if (locKey(c.loc) === locKey(loc)) return norm(c.text).includes(norm(text).slice(0, 400));
  }
  return false;
}
// Find where a pasted passage occurs in a document (for a reviewer correcting an association).
export function locate(doc, text) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim(); const want = norm(text);
  if (want.length < 3) return null;
  for (const b of doc.blocks) {
    if (b.kind === "para" && norm(b.text).includes(want)) return b.loc;
    if (b.kind === "table") for (const row of b.rows) for (const c of row) if (norm(c.text).includes(want)) return c.loc;
  }
  return null;
}
