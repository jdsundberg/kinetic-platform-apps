// RFP Intelligence services: import → extract → review/confirm → search → approve → reuse.
// Runs with the caller's Kinetic credentials like every Corporate Brain service, so the kapp's policies
// (private kapp, restricted RFP rows, immutable confirmed answers) apply to every read and write.
//
// Invariants this module keeps:
//  • An answer is only ever text found verbatim in an original document, at a stored location. Confirming re-checks
//    that against the original file; a correction must also be found in the document, and becomes a new revision.
//  • A historical answer is evidence, never "current". Only an approved answer — approved by a named human reviewer —
//    becomes current knowledge (a verified knowledge entry, Lens "rfp").
//  • AI-generated drafts (new-RFP analysis) are labelled drafts, are built only from retrieved text, and say which
//    evidence they used; a requirement without adequate evidence gets no draft.
//  • Unknown stays unknown: dates, submission and award status are never inferred from a document's existence.
import crypto from "crypto";
import { kq } from "./store.mjs";
import { newId, parseList, listValue, parseJson, nameKey } from "./core.mjs";
import { parseDocument, detectFormat, locLabel, locKey } from "./docparse.mjs";
import { extractQuestions, verifyCitation, locate, tokens, similarity, normalizedKey, hashKey, classify, CATEGORY_LABEL, SENSITIVE_CATEGORIES } from "./rfp-extract.mjs";
import { PROCUREMENT_TYPES, DOCUMENT_ROLES } from "../model.mjs";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const CONCURRENCY = 4;
const err = (status, message) => Object.assign(new Error(message), { status });
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const nowIso = () => new Date().toISOString();
const clip = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const TRANSIENT = /updated or deleted by another user|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|\((409|429|50\d)\)/i;
const UNIQUE = /must be unique/i;
// Kinetic refuses an update when the submission changed since it was read ("updated or deleted by another user"): retry
async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries - 1 || !TRANSIENT.test(e.message)) throw e; await new Promise(r => setTimeout(r, 300 * 2 ** i)); }
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ── match strength: what a score means (documented in RFP_INTELLIGENCE.md and shown in the UI) ──
// score = token overlap of the two questions (0–1) after normalization and synonym grouping, plus a small boost when the
// historical answer also shares the new question's terms. Not a probability.
export const STRENGTH = [
  ["strong", 0.6, "Same subject and most of the same terms — the historical answer is likely relevant; still check its scope and date"],
  ["partial", 0.35, "Related subject — useful context, but the requirement differs; do not reuse the answer as-is"],
  ["weak", 0.18, "Shares a few terms only"],
];
export const strengthOf = (s) => (STRENGTH.find(([, min]) => s >= min) || ["none"])[0];

// ── per-user search index (keyed by login: it only ever holds rows that login may see) ──
const INDEX_TTL = 10 * 60 * 1000;
const indexes = new Map();   // scopeKey → { at, building, data }
const summaries = new Map();   // scopeKey → { at, data } | { building } — KPI tiles, 5-minute cache
const SUMMARY_TTL = 5 * 60 * 1000;
const searchLists = new Map();   // scope|library → { at, items } — what a library search matches against
const SEARCH_TTL = 2 * 60 * 1000;
export function bustRfpIndex() { indexes.clear(); summaries.clear(); searchLists.clear(); }
export function bustRfpLists() { summaries.clear(); searchLists.clear(); }   // after any RFP write: KPI tiles and search list

export function createRfp(store, services, ingestion, { actor, me, scopeKey, files }) {
  const who = actor.label || actor.username;
  const isReviewer = !!me.roles.reviewer;
  const audit = services.audit;

  // ── RFP sources ──
  async function allRfps() {
    return (await store.collect("rfp-sources", `values[Record Status] = "active"`, { maxPages: 40 })).items;
  }
  // The library list: one Kinetic page (≤25) per request, pageToken for Next — never a walk, never a total.
  // Each filter/sort combination has its own compound index (Library Status first; app.json); filtering by type or
  // outcome orders by customer. A search (the user asked for it) matches words anywhere in the customer, RFP name or
  // solicitation number over a short-lived per-scope list, and returns the first 25 matches.
  const LIB_SORT = { received: ["Received At", "DESC"], due: ["Due At", "DESC"], customer: ["Customer Name", "ASC"], name: ["Opportunity Name", "ASC"] };
  async function listRfps({ library = "historical", type = "", status = "", q = "", sort = "received", pageToken = "" } = {}) {
    const libName = library === "analysis" ? "analysis" : "historical";
    const lib = `values[Library Status] = ${kq(libName)}`;
    const filters = [type && `values[Procurement Type] = ${kq(type)}`, status && `values[Opportunity Status] = ${kq(status)}`].filter(Boolean);
    q = String(q || "").trim().toLowerCase();
    if (q) {
      const words = q.split(/\s+/);
      const hits = (await searchList(libName)).filter(x => (!type || x["Procurement Type"] === type) && (!status || (x["Opportunity Status"] || "unknown") === status)
        && words.every(w => `${x["Customer Name"]} ${x["Opportunity Name"]} ${x["Solicitation Number"]}`.toLowerCase().includes(w)))
        .sort((a, b) => String(a["Customer Name"]).localeCompare(String(b["Customer Name"])) || String(a["Opportunity Name"]).localeCompare(String(b["Opportunity Name"])));
      return { items: hits.slice(0, 25), nextPageToken: null, sort: "customer", search: true, more: hits.length > 25 };
    }
    const key = filters.length ? "customer" : LIB_SORT[sort] ? sort : "received";
    const [field, direction] = LIB_SORT[key];
    const r = await store.page("rfp-sources", { q: [lib, ...filters].join(" AND "), orderBy: `values[${field}]`, direction, pageToken, limit: 25 });
    return { items: r.items, nextPageToken: r.nextPageToken, sort: key };
  }
  async function searchList(libName) {
    const k = `${scopeKey}|${libName}`; const e = searchLists.get(k);
    if (e && Date.now() - e.at < SEARCH_TTL) return e.items;
    const items = (await store.collect("rfp-sources", `values[Library Status] = ${kq(libName)}`, { maxPages: 40 })).items;
    searchLists.set(k, { at: Date.now(), items });
    return items;
  }
  // documents still waiting for review (extracted, or partly extracted) — one page, with their RFP's name
  async function reviewDocuments({ pageToken = "" } = {}) {
    const r = await store.page("rfp-documents", { q: `values[Extraction Status] IN ("extracted", "partial")`, orderBy: "values[RFP Source ID]", pageToken, limit: 25 });
    const ids = [...new Set(r.items.map(d => d["RFP Source ID"]))];
    const rfps = new Map((await pool(ids, CONCURRENCY, id => store.byId("rfp-sources", id))).filter(Boolean).map(x => [x["RFP Source ID"], x]));
    return { items: r.items.map(d => ({ ...d, rfp: { id: d["RFP Source ID"], name: rfps.get(d["RFP Source ID"])?.["Opportunity Name"] || "", customer: rfps.get(d["RFP Source ID"])?.["Customer Name"] || "" } })), nextPageToken: r.nextPageToken };
  }
  async function getRfp(id) {
    const rfp = await store.byId("rfp-sources", id); if (!rfp) return null;
    const docs = (await store.collect("rfp-documents", `values[RFP Source ID] = ${kq(id)}`, { maxPages: 8 })).items
      .sort((a, b) => String(a["File Name"]).localeCompare(b["File Name"]) || (+a.Revision || 0) - (+b.Revision || 0));
    // Corporate Brain sources linked to the RFP but not imported as documents (Drive files, email threads, Bid History)
    const own = new Set(docs.map(d => d["Source ID"]));
    const driveId = (u) => (String(u || "").match(/\/d\/([\w-]+)/) || [])[1];
    const importedOriginals = new Set(docs.map(d => driveId(d["Original URL"])).filter(Boolean));   // the Drive file a document was imported from
    const ids = parseList(rfp["Source IDs"]).filter(s => !own.has(s));
    const linked = [];
    for (let i = 0; i < ids.length; i += 25) {
      const page = (await store.collect("sources", `values[Source ID] IN (${ids.slice(i, i + 25).map(kq).join(", ")})`, { maxPages: 2 })).items;
      linked.push(...page.filter(x => !importedOriginals.has(driveId(x["Original URL"]))).map(x => ({ id: x["Source ID"], title: x.Title, date: x["Source Date"], url: x["Original URL"], system: x["Source System"], type: x["Source Type"] })));
    }
    linked.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    return { rfp, documents: docs, linkedSources: linked };
  }
  function cleanRfpInput(v, { partial = false } = {}) {
    const out = {};
    for (const k of ["Opportunity Name", "Customer Name", "Company ID", "Solicitation Number", "Procurement Type", "Received At", "Due At", "Submitted At",
      "Opportunity Status", "Status Basis", "Deal ID", "Notes"]) if (v[k] !== undefined) out[k] = String(v[k] ?? "").trim();
    if (!partial && !out["Opportunity Name"]) throw err(400, "Opportunity Name is required");
    if (out["Procurement Type"] && !PROCUREMENT_TYPES.includes(out["Procurement Type"])) throw err(400, `Procurement Type must be one of ${PROCUREMENT_TYPES.join(", ")}`);
    for (const k of ["Received At", "Due At", "Submitted At"]) if (out[k] && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(out[k])) throw err(400, `${k} must be YYYY, YYYY-MM or YYYY-MM-DD (leave it blank when unknown)`);
    // status is a fact about the world: it needs a basis, and is never set from the documents' existence
    if (out["Opportunity Status"] && out["Opportunity Status"] !== "unknown" && !String(out["Status Basis"] || "").trim() && !partial)
      throw err(400, "An opportunity status other than unknown needs a basis (the evidence or who said so)");
    return out;
  }
  async function createRfp(input) {
    const values = cleanRfpInput(input);
    if (!values["Company ID"] && values["Customer Name"]) {
      const m = await services.findCompanies(values["Customer Name"]);
      if (m.length === 1) values["Company ID"] = m[0]["Company ID"];
    }
    const rec = await store.create("rfp-sources", { "Procurement Type": "rfp", "Opportunity Status": "unknown", ...values,
      "Library Status": input["Library Status"] === "analysis" ? "analysis" : "historical", "Document IDs": "[]", "Question Count": "0", "Answered Count": "0", "Approved Count": "0",
      "Access Scope": input.restricted || input["Access Scope"] === "restricted" ? "restricted" : "internal", "Record Status": "active", "Source IDs": "[]", "Created Via": actor.type });
    await audit("create", "rfp", rec["RFP Source ID"], { details: values });
    return rec;
  }
  async function updateRfp(id, input) {
    const cur = await store.byId("rfp-sources", id); if (!cur) throw err(404, "RFP not found");
    const values = cleanRfpInput(input, { partial: true });
    const st = values["Opportunity Status"] ?? cur["Opportunity Status"];
    if (st && st !== "unknown" && !String(values["Status Basis"] ?? cur["Status Basis"] ?? "").trim()) throw err(400, "An opportunity status other than unknown needs a basis");
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => (cur[k] || "") !== v));
    if (!Object.keys(changed).length) return cur;
    const rec = await store.update(cur._id, changed);
    await audit("update", "rfp", id, { details: { changed: Object.fromEntries(Object.keys(changed).map(k => [k, { from: cur[k] || "", to: changed[k] }])) } });
    return rec;
  }
  // Link Corporate Brain sources already loaded (Drive files, email threads) to an RFP whose documents are not imported
  // yet — the RFP becomes findable; nothing is extracted until someone imports the files themselves.
  async function linkSources(id, sourceIds) {
    const cur = await store.byId("rfp-sources", id); if (!cur) throw err(404, "RFP not found");
    const want = [...new Set(parseList(sourceIds))].filter(s => !parseList(cur["Source IDs"]).includes(s));
    if (!want.length) return { item: cur, linked: [] };
    const found = await pool(want, CONCURRENCY, s => store.byId("sources", s));
    const missing = want.filter((s, i) => !found[i]);
    if (missing.length) throw err(400, `Sources not found or not visible to you: ${missing.join(", ")}`);
    const rec = await store.update(cur._id, { "Source IDs": listValue([...parseList(cur["Source IDs"]), ...want]) });
    await audit("link-sources", "rfp", id, { details: { sources: want } });
    return { item: rec, linked: want };
  }
  async function recount(rfpId) {
    const rfp = await store.byId("rfp-sources", rfpId); if (!rfp) return;
    const qs = (await store.collect("rfp-questions", `values[RFP Source ID] = ${kq(rfpId)}`, { maxPages: 40 })).items.filter(q => q["Extraction Status"] !== "rejected");
    const canon = new Set(qs.map(q => q["Canonical Question ID"]).filter(Boolean));
    let approved = 0;
    if (canon.size) {
      const aa = (await store.collect("approved-answers", `values[Approval Status] = "approved"`, { maxPages: 20 })).items;
      approved = qs.filter(q => q["Canonical Question ID"] && aa.some(a => a["Canonical Question ID"] === q["Canonical Question ID"])).length;
    }
    await store.update(rfp._id, { "Question Count": String(qs.length), "Answered Count": String(qs.filter(q => ["answered", "needs_review"].includes(q["Answer Status"])).length), "Approved Count": String(approved) });
    bustRfpLists();
  }

  // ── import: register the original, then extract in the background ──
  async function importDocument({ rfpId, rfp: newRfp, file, role = "response", origin = null, documentDate = "", restricted = false, extract = true }) {
    if (!DOCUMENT_ROLES.includes(role)) throw err(400, `Document role must be one of ${DOCUMENT_ROLES.join(", ")}`);
    // a reference document (e.g. the buyer's published Q&A — the answers there are the agency's, not Kinetic's) is stored, not extracted
    if (role === "reference") extract = false;
    if (!file?.name || !file?.base64) throw err(400, "file.name and file.base64 are required");
    const buf = Buffer.from(file.base64, "base64");
    if (!buf.length) throw err(400, "The file is empty");
    if (buf.length > MAX_FILE_BYTES) throw err(413, `Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    if (documentDate && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(documentDate)) throw err(400, "documentDate must be YYYY, YYYY-MM or YYYY-MM-DD");
    const rfp = rfpId ? await store.byId("rfp-sources", rfpId) : await createRfp({ ...newRfp, restricted });
    if (!rfp) throw err(404, "RFP not found or not visible to you");
    const scope = rfp["Access Scope"] === "restricted" || restricted ? "restricted" : "internal";
    if (scope === "restricted" && !isReviewer) throw err(403, "Restricted RFP documents are visible to reviewers only, so only reviewers can import them");
    const hash = sha256(buf), docKey = hashKey(rfp["RFP Source ID"], hash);
    const existing = (await store.page("rfp-documents", { q: `values[Document Key] = ${kq(docKey)}`, limit: 1, unscoped: true })).items[0];
    if (existing) return { document: existing, rfp, duplicate: true, note: "This exact file is already imported for this RFP — nothing was created" };

    const format = detectFormat(file.name, buf);
    let doc; try { doc = parseDocument(buf, file.name); } catch (e) { doc = { format, blocks: [], warnings: [`Could not read the file: ${e.message}`] }; }
    // revisions: a file with the same name (or the same original in its source system) in this RFP is an earlier revision
    const siblings = (await store.collect("rfp-documents", `values[RFP Source ID] = ${kq(rfp["RFP Source ID"])}`, { maxPages: 8 })).items;
    const stem = (n) => String(n || "").toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[\s_-]*(draft\s*)?v(ersion)?\s*\d+(\.\d+)?$/i, "").replace(/[\s_-]*\(\d+\)$/, "").trim();
    const prev = siblings.filter(d => stem(d["File Name"]) === stem(file.name) || (origin?.id && String(d["Original URL"] || "").includes(origin.id)))
      .sort((a, b) => (+b.Revision || 0) - (+a.Revision || 0))[0];
    const revision = prev ? (+prev.Revision || 1) + 1 : 1;

    // provenance: a Corporate Brain source for this exact file revision (idempotent through its hashed Source ID)
    const system = origin?.system === "google-drive" ? "google-drive" : "rfp-upload";
    const originalId = system === "google-drive" ? `${origin.id}@${hash.slice(0, 16)}` : `sha256:${hash}`;
    const job = await ingestion.createJob({ title: `RFP import: ${file.name}`.slice(0, 200), jobType: "ingestion", connector: system,
      scope: { rfp: rfp["RFP Source ID"], file: file.name, role, origin: origin || null }, subjectType: rfp["Company ID"] ? "company" : "", subjectId: rfp["Company ID"] || "" });
    const text = doc.blocks.map(b => b.kind === "para" ? b.text : b.rows.slice(0, 6).map(r => r.map(c => c.text).join(" | ")).join("\n")).join("\n");
    const batch = await ingestion.processBatch(job, [{ system, originalId, sourceType: "rfp-document", title: file.name, date: documentDate || "", owner: me.username,
      url: origin?.url || "", excerpt: clip(text.replace(/\s+/g, " "), 1000), contentHash: hash.slice(0, 32), accessScope: scope, participants: [],
      companyIds: rfp["Company ID"] ? [rfp["Company ID"]] : [], companyHints: [] }], { done: false });
    const sourceId = batch.results[0]?.sourceId || "";
    if (batch.results[0]?.outcome === "failed") throw err(502, `Could not register the source: ${batch.results[0].error}`);

    const unsupported = doc.format === "unsupported" || !doc.blocks.length;
    const values = { "Document ID": newId("rfp-documents"), "RFP Source ID": rfp["RFP Source ID"], "File Name": file.name, "File Type": doc.format || format,
      "Document Role": role, "Revision": String(revision), "Supersedes Document ID": prev?.["Document ID"] || "", "Content Hash": hash, "Document Key": docKey,
      "Source ID": sourceId, "Original URL": origin?.url || "", "File Size": String(buf.length), "Page Count": String(doc.pages || ""), "Document Date": documentDate || "",
      "Extraction Status": unsupported ? "unsupported" : extract ? "queued" : "stored", "Extraction Notes": JSON.stringify((doc.warnings || []).slice(0, 20)),
      "Question Count": "0", "Answered Count": "0", "Needs Review Count": "0", "Import Job ID": job["Job ID"], "Access Scope": scope,
      "Record Status": "active", "Source IDs": listValue([sourceId]), "Created Via": actor.type };
    // the original file itself, as a Kinetic attachment — the controlled archival copy every citation points back to
    const document = await files.upload("rfp-documents", values, { name: file.name, type: file.type || "application/octet-stream", buf });
    await store.update(rfp._id, { "Document IDs": listValue([...parseList(rfp["Document IDs"]), values["Document ID"]]), "Source IDs": listValue([...parseList(rfp["Source IDs"]), sourceId]) });
    await audit("import", "rfpdocument", values["Document ID"], { details: { rfp: rfp["RFP Source ID"], file: file.name, role, revision, sourceId, format: doc.format, bytes: buf.length, warnings: doc.warnings } });
    if (unsupported) {
      await ingestion.processBatch(await store.byId("research-jobs", job["Job ID"]), [], { done: true });
      return { document, rfp, job, unsupported: true, warnings: doc.warnings };
    }
    let started = false;
    if (extract) { started = true; runExtraction(values["Document ID"], { buf, doc }).catch(e => console.error("[corporate-brain] rfp extraction", values["Document ID"], e.message)); }
    else await ingestion.processBatch(await store.byId("research-jobs", job["Job ID"]), [], { done: true });
    return { document, rfp, job, started, warnings: doc.warnings, revision };
  }

  const running = new Set();
  // Extraction is idempotent (Row Key / Answer Key unique indexes) and resumable: run it again and it skips what exists.
  async function runExtraction(documentId, { buf = null, doc = null } = {}) {
    if (running.has(documentId)) throw err(409, "Extraction is already running for this document");
    running.add(documentId);
    const d = await store.byId("rfp-documents", documentId);
    try {
      if (!d) throw err(404, "Document not found");
      if (!doc) { buf = buf || await files.download(d); doc = parseDocument(buf, d["File Name"]); }
      await store.update(d._id, { "Extraction Status": "extracting" });
      const role = d["Document Role"] || "response";
      const { items, notes } = extractQuestions(doc, { role });
      const rfpId = d["RFP Source ID"];
      // questions this RFP already has from its other documents (a response answering the solicitation; an earlier revision)
      const others = (await store.collect("rfp-questions", `values[RFP Source ID] = ${kq(rfpId)}`, { maxPages: 40 })).items
        .filter(q => q["Document ID"] !== documentId && q["Extraction Status"] !== "rejected");
      const mine = (await store.collect("rfp-questions", `values[Document ID] = ${kq(documentId)}`, { maxPages: 40 })).items;
      const haveRow = new Map(mine.map(q => [q["Row Key"], q]));
      const existingAnswers = new Set((await store.collect("rfp-answers", `values[Document ID] = ${kq(documentId)}`, { maxPages: 40 })).items.map(a => a["Answer Key"]));
      const version = `Revision ${d.Revision || 1}${d["File Name"] ? ` (${d["File Name"]})` : ""}`;
      let created = 0, skipped = 0, attached = 0, failed = 0; const errors = []; const seqToId = new Map();
      const locks = new Map();   // two rows of one document can answer the same existing question: write to it one at a time
      const withLock = async (key, fn) => { const prev = locks.get(key) || Promise.resolve(); let release; const p = new Promise(r => (release = r)); locks.set(key, prev.then(() => p)); await prev; try { return await fn(); } finally { release(); } };
      await pool(items, CONCURRENCY, async (it) => { for (let attempt = 0; ; attempt++) {
        try {
          // 1. the question this row answers: an existing question of the same RFP (same number, same wording) or a new one
          let target = null, matchNote = "";
          if (role !== "solicitation") {
            const toks = tokens(it.text);
            let best = null;
            for (const q of others) {
              const sameNum = it.number && q["Question Number"] && it.number.toLowerCase() === String(q["Question Number"]).toLowerCase();
              const sim = q["Question Key"] === it.key ? 1 : similarity(toks, String(q["Question Text Normalized"] || "").split(" ").filter(Boolean));
              const score = sim + (sameNum ? 0.3 : 0);
              if ((sim >= 0.92 && (!it.number || !q["Question Number"] || sameNum)) || (sameNum && sim >= 0.5)) if (!best || score > best.score) best = { q, sim, sameNum, score };
            }
            if (best) { target = best.q; matchNote = best.sim >= 0.92 ? "" : `matched to ${best.q["Question ID"]} by number ${it.number} (wording ${Math.round(best.sim * 100)}% similar)`; }
          }
          const rowKey = hashKey(documentId, locKey(it.loc), it.key);
          let q = target || haveRow.get(rowKey); const resumed = !target && !!q;
          const answerId = it.answer ? newId("rfp-answers") : "";
          const answerStatus = it.answer ? (it.status === "needs_review" || matchNote ? "needs_review" : "candidate") : "";
          const verified = it.answer ? it.answer.parts.every(p => verifyCitation(doc, p.loc, p.text)) : false;
          if (!q) {
            q = await store.create("rfp-questions", {
              "Question ID": newId("rfp-questions"), "RFP Source ID": rfpId, "Document ID": documentId, "Question Number": it.number, "Question Text Original": it.text,
              "Question Text Normalized": it.normalized, "Question Key": it.key, "Row Key": rowKey, "Sequence": String(it.seq).padStart(5, "0"), "Section": clip(it.section, 250),
              "Subsection": clip(it.subsection, 250), "Category": it.category, "Tags": listValue(it.tags), "Category Source": it.category ? "rule-suggested" : "",
              "Source Location": JSON.stringify(it.loc), "Location Label": clip(it.locLabel, 250), "Requirement Level": it.level, "Requirement Basis": clip(it.levelBasis, 250),
              "Extraction Status": it.status, "Extraction Reason": it.reason, "Answer Status": it.answer ? (answerStatus === "needs_review" ? "needs_review" : "answered") : "unanswered",
              "Answer Preview": it.answer ? clip(it.answer.text, 600) : "", "Latest Answer ID": answerId, "Citation Verified": verifyCitation(doc, it.loc, it.text) ? "yes" : "no",
              "Access Scope": d["Access Scope"] || "internal", "Record Status": "active", "Source IDs": listValue([d["Source ID"]]), "Created Via": actor.type,
            }).catch(async (e) => {
              if (!UNIQUE.test(e.message)) throw e;   // an earlier attempt wrote it before the connection dropped
              const ex = (await store.page("rfp-questions", { q: `values[Row Key] = ${kq(rowKey)}`, limit: 1, unscoped: true })).items[0];
              if (!ex) throw e; return ex;
            });
            created++;
          } else if (!target) { skipped++; }
          else {
            attached++;
            if (it.answer) await withLock(q._id, () => retry(() => store.update(q._id, { "Answer Status": answerStatus === "needs_review" ? "needs_review" : "answered", "Answer Preview": clip(it.answer.text, 600), "Latest Answer ID": answerId })));
          }
          seqToId.set(it.seq, q["Question ID"]);
          // 2. the exact historical answer, at its exact location
          if (it.answer) {
            const answerKey = hashKey(q["Question ID"], documentId, locKey(it.answer.loc), crypto.createHash("sha256").update(it.answer.text).digest("hex"));
            if (existingAnswers.has(answerKey)) return;
            const prevAnswers = target ? (await store.collect("rfp-answers", `values[Question ID] = ${kq(q["Question ID"])}`, { maxPages: 4 })).items : [];
            const revOf = prevAnswers.filter(a => a["Document ID"] !== documentId).sort((a, b) => String(b._createdAt).localeCompare(a._createdAt))[0];
            await store.create("rfp-answers", {
              "Answer ID": answerId, "Question ID": q["Question ID"], "RFP Source ID": rfpId, "Document ID": documentId, "Answer Text Original": it.answer.text,
              "Answer Parts": JSON.stringify(it.answer.parts.map(p => ({ text: p.text, label: p.label, loc: p.loc, locLabel: locLabel(p.loc) }))), "Compliance": it.answer.compliance || "",
              "Answer Date": d["Document Date"] || "", "Date Precision": d["Document Date"] ? (d["Document Date"].length === 10 ? "exact" : d["Document Date"].length === 7 ? "month" : "year") : "unknown",
              "Source Location": JSON.stringify(it.answer.loc), "Location Label": clip(it.answer.locLabel, 250), "Document Version": clip(version, 250), "Product Version": "",
              "Answer Status": answerStatus, "Answer Key": answerKey, "Citation Verified": verified ? "yes" : "no", "Revision Of": revOf?.["Answer ID"] || "",
              "Correction Note": matchNote, "Access Scope": d["Access Scope"] || "internal", "Record Status": "active", "Source IDs": listValue([d["Source ID"]]), "Created Via": actor.type,
            }).catch(e => { if (!UNIQUE.test(e.message)) throw e; });   // already written by an earlier attempt
            // a resumed run whose first attempt stopped between the question and its answer: point the question at this answer
            if (resumed && q["Latest Answer ID"] !== answerId) await retry(() => store.update(q._id, { "Latest Answer ID": answerId, "Answer Preview": clip(it.answer.text, 600) }));
          }
          break;
        } catch (e) {
          // a network blip: the row is retried as a whole — its unique Row Key / Answer Key make a repeat write harmless
          if (attempt < 3 && TRANSIENT.test(e.message)) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
          failed++; if (errors.length < 20) errors.push(`#${it.seq} ${it.locLabel}: ${e.message}`); break;
        }
      } });
      // 3. duplicates: the same wording repeated inside this document, then near-duplicates in other RFPs
      let fresh = (await store.collect("rfp-questions", `values[Document ID] = ${kq(documentId)}`, { maxPages: 40 })).items;
      for (const it of items) if (it.duplicateOfSeq && seqToId.get(it.seq) && seqToId.get(it.duplicateOfSeq) && seqToId.get(it.seq) !== seqToId.get(it.duplicateOfSeq)) {
        const q = fresh.find(x => x["Question ID"] === seqToId.get(it.seq));
        if (q && !q["Possible Duplicate Of"]) { await store.update(q._id, { "Possible Duplicate Of": seqToId.get(it.duplicateOfSeq), "Duplicate Score": "1.00" }); q["Possible Duplicate Of"] = seqToId.get(it.duplicateOfSeq); }
      }
      const idx = await index(true);
      for (const q of fresh) {
        if (q["Possible Duplicate Of"]) continue;
        const qt = String(q["Question Text Normalized"] || "").split(" ").filter(Boolean);
        let best = null;
        for (const o of idx.questions) {
          if (o.rfpId === rfpId) continue;
          const s = o.key === q["Question Key"] ? 1 : similarity(qt, o.tokens);
          if (s >= 0.8 && (!best || s > best.s)) best = { o, s };
        }
        if (best) await store.update(q._id, { "Possible Duplicate Of": best.o.id, "Duplicate Score": best.s.toFixed(2) });
      }
      const nReview = fresh.filter(q => q["Extraction Status"] === "needs_review" || q["Answer Status"] === "needs_review").length;
      const answered = fresh.filter(q => ["answered", "needs_review"].includes(q["Answer Status"])).length;
      await store.update(d._id, { "Extraction Status": failed ? "partial" : "extracted", "Question Count": String(fresh.length + attached), "Answered Count": String(answered + attached),
        "Needs Review Count": String(nReview), "Extraction Notes": JSON.stringify([...notes, ...(attached ? [`${attached} answer(s) attached to questions from this RFP's other documents`] : []), ...errors].slice(0, 40)) });
      const job = await store.byId("research-jobs", d["Import Job ID"]);
      if (job) await store.update(job._id, { "Status": failed && !created && !attached ? "failed" : "completed", "Completed At": nowIso(),
        "Items Discovered": String(items.length), "Items Processed": String(created + attached), "Items Skipped": String(skipped), "Items Failed": String(failed),
        "Errors": JSON.stringify(errors.slice(0, 25)), "Summary": `${items.length} question rows: ${created} new, ${attached} answered existing questions, ${skipped} already extracted, ${failed} failed` });
      await audit("extract", "rfpdocument", documentId, { details: { found: items.length, created, attached, skipped, failed } });
      await recount(rfpId);
      bustRfpIndex();
      return { found: items.length, created, attached, skipped, failed, errors };
    } catch (e) {
      if (d) await store.update(d._id, { "Extraction Status": "failed", "Extraction Notes": JSON.stringify([`Extraction failed: ${e.message}`]) }).catch(() => {});
      throw e;
    } finally { running.delete(documentId); }
  }

  // ── review of extracted rows ──
  async function documentRows(documentId) {
    const d = await store.byId("rfp-documents", documentId); if (!d) return null;
    const qs = (await store.collect("rfp-questions", `values[Document ID] = ${kq(documentId)}`, { maxPages: 40 })).items;
    const ans = (await store.collect("rfp-answers", `values[Document ID] = ${kq(documentId)}`, { maxPages: 40 })).items;
    // answers this document gave to questions that came from another document of the same RFP
    const own = new Set(qs.map(q => q["Question ID"]));
    const foreign = new Set(ans.map(a => a["Question ID"]).filter(id => !own.has(id)));
    const extra = foreign.size ? (await store.collect("rfp-questions", `values[RFP Source ID] = ${kq(d["RFP Source ID"])}`, { maxPages: 40 })).items.filter(q => foreign.has(q["Question ID"])) : [];
    const rows = [...qs, ...extra].map(q => ({ question: q, answers: ans.filter(a => a["Question ID"] === q["Question ID"]).sort((a, b) => String(b._createdAt).localeCompare(a._createdAt)) }))
      .sort((a, b) => String(a.question.Sequence).localeCompare(String(b.question.Sequence)));
    return { document: d, rows };
  }
  // Confirm extracted rows. Every citation is re-checked against the original file first; a row whose text is not found
  // at its location is not confirmed. "all" confirms rows the extractor was sure of — needs_review rows must be named.
  async function confirmRows(documentId, { questionIds = [], all = false } = {}) {
    const data = await documentRows(documentId); if (!data) throw err(404, "Document not found");
    const doc = parseDocument(await files.download(data.document), data.document["File Name"]);
    const want = new Set(questionIds);
    const pick = data.rows.filter(r => want.has(r.question["Question ID"]) || (all && r.question["Extraction Status"] === "extracted" && !r.answers.some(a => a["Answer Status"] === "needs_review")));
    const at = nowIso(); const confirmed = [], refused = [];
    for (const r of pick) {
      const q = r.question;
      if (["rejected"].includes(q["Extraction Status"])) continue;
      const qLoc = parseJson(q["Source Location"], null);
      const ownQuestion = q["Document ID"] === documentId;
      if (ownQuestion && (!qLoc || !verifyCitation(doc, qLoc, q["Question Text Original"]))) { refused.push({ id: q["Question ID"], reason: "question text not found at its cited location" }); continue; }
      const pending = r.answers.filter(a => ["candidate", "needs_review"].includes(a["Answer Status"]) && a["Document ID"] === documentId);
      let bad = null;
      for (const a of pending) for (const p of parseJson(a["Answer Parts"], [])) if (!verifyCitation(doc, p.loc, p.text)) bad = a;
      if (bad) { refused.push({ id: q["Question ID"], reason: `answer ${bad["Answer ID"]} not found at its cited location` }); continue; }
      for (const a of pending) await store.update(a._id, { "Answer Status": "confirmed", "Citation Verified": "yes", "Confirmed By": who, "Confirmed At": at });
      if (ownQuestion && q["Extraction Status"] !== "confirmed") await store.update(q._id, { "Extraction Status": "confirmed", "Citation Verified": "yes", "Confirmed By": who, "Confirmed At": at,
        ...(pending.length ? { "Answer Status": "answered" } : {}) });
      else if (pending.length) await store.update(q._id, { "Answer Status": "answered" });
      confirmed.push(q["Question ID"]);
    }
    await audit("confirm", "rfpdocument", documentId, { details: { confirmed: confirmed.length, refused, ids: confirmed.slice(0, 200) } });
    await refreshDocumentCounts(documentId); bustRfpIndex();
    return { confirmed: confirmed.length, refused };
  }
  async function refreshDocumentCounts(documentId) {
    const data = await documentRows(documentId); if (!data) return;
    const own = data.rows.filter(r => r.question["Document ID"] === documentId && r.question["Extraction Status"] !== "rejected");
    const allConfirmed = data.rows.length && data.rows.every(r => ["confirmed", "rejected"].includes(r.question["Extraction Status"]) || r.question["Document ID"] !== documentId)
      && data.rows.every(r => r.answers.every(a => !["candidate", "needs_review"].includes(a["Answer Status"])));
    await store.update(data.document._id, { "Question Count": String(data.rows.length), "Answered Count": String(data.rows.filter(r => r.answers.some(a => !["rejected", "corrected"].includes(a["Answer Status"]))).length),
      "Needs Review Count": String(own.filter(r => r.question["Extraction Status"] === "needs_review" || r.answers.some(a => a["Answer Status"] === "needs_review")).length),
      ...(["extracted", "partial", "confirmed"].includes(data.document["Extraction Status"]) ? { "Extraction Status": allConfirmed ? "confirmed" : data.document["Extraction Status"] === "confirmed" ? "extracted" : data.document["Extraction Status"] } : {}) });
  }
  // Corrections to an unconfirmed row. Original text is never edited: the reviewer either rejects the row, marks it
  // unanswered, or points at the right answer — which must be found, verbatim, in the original document.
  async function updateRow(questionId, { action, text = "", category, tags, level, note = "" }) {
    const q = await store.byId("rfp-questions", questionId); if (!q) throw err(404, "Question not found");
    const answers = (await store.collect("rfp-answers", `values[Question ID] = ${kq(questionId)}`, { maxPages: 4 })).items;
    const pending = answers.filter(a => ["candidate", "needs_review"].includes(a["Answer Status"]));
    if (action === "meta") {
      const v = {};
      if (category !== undefined) { if (category && !CATEGORY_LABEL[category] && !/^custom:/.test(category)) throw err(400, "Unknown category (custom categories start with custom:)"); v.Category = category; v["Category Source"] = "manual"; }
      if (tags !== undefined) v.Tags = listValue(parseList(tags));
      if (level !== undefined) { if (!["mandatory", "optional", "unspecified"].includes(level)) throw err(400, "level must be mandatory, optional or unspecified"); v["Requirement Level"] = level; v["Requirement Basis"] = level === "unspecified" ? "" : `set by ${who}`; }
      const rec = await store.update(q._id, v); await audit("update", "rfpquestion", questionId, { details: v }); bustRfpIndex(); return { question: rec };
    }
    if (q["Extraction Status"] === "confirmed" && action !== "meta") throw err(409, "This row is confirmed. A reviewer can correct a confirmed answer, which records a new revision.");
    if (action === "reject") {
      for (const a of pending) await store.update(a._id, { "Answer Status": "rejected", "Correction Note": note || "row rejected: not a question" });
      const rec = await store.update(q._id, { "Extraction Status": "rejected", "Extraction Reason": `${q["Extraction Reason"] || ""}\nRejected by ${who}: ${note || "not a question"}`.trim() });
      await audit("reject", "rfpquestion", questionId, { comment: note }); await recount(q["RFP Source ID"]); bustRfpIndex(); return { question: rec };
    }
    if (action === "unanswered") {
      for (const a of pending) await store.update(a._id, { "Answer Status": "rejected", "Correction Note": note || `not the answer to this question (${who})` });
      const rec = await store.update(q._id, { "Answer Status": "unanswered", "Answer Preview": "", "Latest Answer ID": "", "Extraction Status": "extracted" });
      await audit("mark-unanswered", "rfpquestion", questionId, { comment: note }); bustRfpIndex(); return { question: rec };
    }
    if (action === "set-answer") {
      const docId = pending[0]?.["Document ID"] || q["Document ID"];
      const d = await store.byId("rfp-documents", docId); if (!d) throw err(404, "Document not found");
      const doc = parseDocument(await files.download(d), d["File Name"]);
      const exact = String(text || "").trim();
      const loc = locate(doc, exact);
      if (!loc) throw err(400, "That text was not found in the original document. Paste the answer exactly as it appears in the document — citations must be verifiable.");
      const key = hashKey(questionId, docId, locKey(loc), crypto.createHash("sha256").update(exact).digest("hex"));
      const same = answers.find(a => a["Answer Key"] === key);
      if (same && ["candidate", "needs_review"].includes(same["Answer Status"])) {
        // the reviewer pointed at the answer the row already has: accept the association as it stands
        if (same["Answer Status"] === "needs_review") await store.update(same._id, { "Answer Status": "candidate", "Correction Note": `association checked by ${who}` });
        const rec = await store.update(q._id, { "Answer Status": "answered", "Latest Answer ID": same["Answer ID"], "Extraction Status": q["Extraction Status"] === "needs_review" ? "extracted" : q["Extraction Status"] });
        await audit("set-answer", "rfpquestion", questionId, { comment: note, details: { answerId: same["Answer ID"], location: locLabel(loc), unchanged: true } }); bustRfpIndex();
        return { question: rec, answerId: same["Answer ID"], location: locLabel(loc) };
      }
      for (const a of pending) await store.update(a._id, { "Answer Status": "rejected", "Correction Note": `replaced by the reviewer's association (${who})` });
      const answerId = newId("rfp-answers");
      await store.create("rfp-answers", { "Answer ID": answerId, "Question ID": questionId, "RFP Source ID": q["RFP Source ID"], "Document ID": docId, "Answer Text Original": exact,
        "Answer Parts": JSON.stringify([{ text: exact, label: "", loc, locLabel: locLabel(loc) }]), "Compliance": "", "Answer Date": d["Document Date"] || "", "Date Precision": d["Document Date"] ? "exact" : "unknown",
        "Source Location": JSON.stringify(loc), "Location Label": locLabel(loc), "Document Version": `Revision ${d.Revision || 1} (${d["File Name"]})`, "Product Version": "",
        "Answer Status": "candidate", "Answer Key": same ? hashKey(key, "reassociated", Date.now()) : key, "Citation Verified": "yes",
        "Revision Of": pending[0]?.["Answer ID"] || "", "Correction Note": note || `association corrected by ${who}`, "Access Scope": q["Access Scope"] || "internal", "Record Status": "active",
        "Source IDs": listValue([d["Source ID"]]), "Created Via": actor.type });
      const rec = await store.update(q._id, { "Answer Status": "answered", "Answer Preview": clip(exact, 600), "Latest Answer ID": answerId, "Extraction Status": "extracted" });
      await audit("set-answer", "rfpquestion", questionId, { comment: note, details: { answerId, location: locLabel(loc) } }); bustRfpIndex();
      return { question: rec, answerId, location: locLabel(loc) };
    }
    throw err(400, "action must be meta, reject, unanswered or set-answer");
  }
  // A confirmed answer is never overwritten: a reviewer's correction is a new confirmed revision; the old one is kept as "corrected".
  async function correctAnswer(answerId, { text, note }) {
    if (!isReviewer) throw err(403, "Only reviewers can correct a confirmed historical answer");
    if (!String(note || "").trim()) throw err(400, "Say why the answer is being corrected");
    const a = await store.byId("rfp-answers", answerId); if (!a) throw err(404, "Answer not found");
    if (a["Answer Status"] !== "confirmed") throw err(409, "Only confirmed answers are corrected this way; unconfirmed rows are fixed in review");
    const d = await store.byId("rfp-documents", a["Document ID"]);
    const doc = parseDocument(await files.download(d), d["File Name"]);
    const exact = String(text || "").trim(); const loc = locate(doc, exact);
    if (!loc) throw err(400, "The corrected text was not found in the original document. A historical answer can only be text the document contains.");
    const id = newId("rfp-answers"), at = nowIso();
    await store.create("rfp-answers", { "Answer ID": id, "Question ID": a["Question ID"], "RFP Source ID": a["RFP Source ID"], "Document ID": a["Document ID"], "Answer Text Original": exact,
      "Answer Parts": JSON.stringify([{ text: exact, label: "", loc, locLabel: locLabel(loc) }]), "Compliance": a.Compliance || "", "Answer Date": a["Answer Date"] || "", "Date Precision": a["Date Precision"] || "unknown",
      "Source Location": JSON.stringify(loc), "Location Label": locLabel(loc), "Document Version": a["Document Version"] || "", "Product Version": a["Product Version"] || "",
      "Answer Status": "confirmed", "Answer Key": hashKey(a["Question ID"], a["Document ID"], locKey(loc), crypto.createHash("sha256").update(exact).digest("hex")), "Citation Verified": "yes",
      "Confirmed By": who, "Confirmed At": at, "Revision Of": answerId, "Correction Note": note, "Access Scope": a["Access Scope"] || "internal", "Record Status": "active",
      "Source IDs": a["Source IDs"] || "[]", "Created Via": actor.type });
    await store.update(a._id, { "Answer Status": "corrected", "Correction Note": `Superseded by ${id}: ${note}` });
    const q = await store.byId("rfp-questions", a["Question ID"]);
    if (q && q["Latest Answer ID"] === answerId) await store.update(q._id, { "Latest Answer ID": id, "Answer Preview": clip(exact, 600) });
    await audit("correct-answer", "rfpanswer", answerId, { from: "confirmed", to: "corrected", comment: note, details: { newAnswer: id, location: locLabel(loc) } });
    bustRfpIndex();
    return { answerId: id, location: locLabel(loc) };
  }

  // ── question library ──
  async function questionDetail(id) {
    const q = await store.byId("rfp-questions", id); if (!q) return null;
    const [rfp, doc, answers] = await Promise.all([store.byId("rfp-sources", q["RFP Source ID"]), q["Document ID"] ? store.byId("rfp-documents", q["Document ID"]) : null,
      store.collect("rfp-answers", `values[Question ID] = ${kq(id)}`, { maxPages: 4 })]);
    const docIds = [...new Set(answers.items.map(a => a["Document ID"]))];
    const docs = Object.fromEntries((await Promise.all(docIds.map(x => store.byId("rfp-documents", x).catch(() => null)))).filter(Boolean).map(x => [x["Document ID"], x]));
    const canonical = q["Canonical Question ID"] ? await store.byId("canonical-questions", q["Canonical Question ID"]) : null;
    const approved = canonical ? (await store.collect("approved-answers", `values[Canonical Question ID] = ${kq(canonical["Canonical Question ID"])}`, { maxPages: 2 })).items : [];
    const groupMates = canonical ? (await store.collect("rfp-questions", `values[Canonical Question ID] = ${kq(canonical["Canonical Question ID"])}`, { maxPages: 4 })).items.filter(x => x["Question ID"] !== id) : [];
    const idx = await index();
    const toks = String(q["Question Text Normalized"] || "").split(" ").filter(Boolean);
    const related = idx.questions.filter(o => o.id !== id).map(o => ({ o, s: o.key === q["Question Key"] ? 1 : similarity(toks, o.tokens) })).filter(x => x.s >= 0.35)
      .sort((a, b) => b.s - a.s).slice(0, 10).map(({ o, s }) => ({ ...lightOut(o, idx), score: +s.toFixed(2), strength: strengthOf(s) }));
    return { question: q, rfp, document: doc, documents: docs, answers: answers.items.sort((a, b) => String(b._createdAt).localeCompare(a._createdAt)), canonical, approved, groupMates, related,
      duplicateOf: q["Possible Duplicate Of"] ? await store.byId("rfp-questions", q["Possible Duplicate Of"]).catch(() => null) : null };
  }
  async function listQuestions({ rfpId = "", documentId = "", status = "", category = "", answer = "", canonical = "", offset = 0 }) {
    let items;
    if (documentId || rfpId) {
      items = (await store.collect("rfp-questions", documentId ? `values[Document ID] = ${kq(documentId)}` : `values[RFP Source ID] = ${kq(rfpId)}`, { maxPages: 40 })).items
        .sort((a, b) => String(a["Document ID"]).localeCompare(b["Document ID"]) || String(a.Sequence).localeCompare(b.Sequence));
    } else if (canonical) items = (await store.collect("rfp-questions", `values[Canonical Question ID] = ${kq(canonical)}`, { maxPages: 8 })).items;
    else { const idx = await index(); items = idx.questions.map(o => o.rec); }
    items = items.filter(q => (!status || q["Extraction Status"] === status) && (!category || q.Category === category) && (!answer || q["Answer Status"] === answer) && (status === "rejected" || q["Extraction Status"] !== "rejected"));
    const off = Math.max(0, +offset || 0);
    return { items: items.slice(off, off + 25), total: items.length, offset: off, next: off + 25 < items.length ? off + 25 : null };
  }

  // ── canonical questions (grouping by meaning without losing original wording) ──
  async function createCanonical({ text, category = "", questionIds = [], description = "" }) {
    const t = String(text || "").trim(); if (t.length < 8) throw err(400, "Write the canonical question (at least a few words)");
    const rec = await store.create("canonical-questions", { "Canonical Question": t, "Subject Key": normalizedKey(t), "Category": category || classify(t).category,
      "Tags": "[]", "Description": description, "Question Count": "0", "Record Status": "active", "Source IDs": "[]", "Created Via": actor.type });
    if (questionIds.length) await linkCanonical(rec["Canonical Question ID"], questionIds);
    await audit("create", "canonical", rec["Canonical Question ID"], { details: { text: t, questionIds } });
    return rec;
  }
  async function linkCanonical(canonicalId, questionIds, { unlink = false } = {}) {
    const c = await store.byId("canonical-questions", canonicalId); if (!c) throw err(404, "Canonical question not found");
    let n = 0;
    for (const id of questionIds.slice(0, 200)) {
      const q = await store.byId("rfp-questions", id); if (!q) continue;
      if (unlink ? q["Canonical Question ID"] !== canonicalId : q["Canonical Question ID"] === canonicalId) continue;
      await store.update(q._id, { "Canonical Question ID": unlink ? "" : canonicalId }); n++;
    }
    const count = (await store.collect("rfp-questions", `values[Canonical Question ID] = ${kq(canonicalId)}`, { maxPages: 8 })).items.length;
    await store.update(c._id, { "Question Count": String(count) });
    await audit(unlink ? "unlink" : "link", "canonical", canonicalId, { details: { questionIds: questionIds.slice(0, 200) } });
    bustRfpIndex();
    return { changed: n, questionCount: count };
  }
  // Suggested groups: unconfirmed clusters of similar questions across RFPs (a person decides).
  async function suggestGroups({ category = "", min = 0.55 } = {}) {
    const idx = await index();
    const pool_ = idx.questions.filter(o => !o.canonicalId && (!category || o.category === category));
    const used = new Set(), groups = [];
    for (const o of pool_) {
      if (used.has(o.id)) continue;
      const mates = pool_.filter(x => x.id !== o.id && !used.has(x.id) && x.rfpId !== o.rfpId && similarity(o.tokens, x.tokens) >= min);
      if (!mates.length) continue;
      [o, ...mates].forEach(x => used.add(x.id));
      groups.push({ lead: lightOut(o, idx), members: mates.slice(0, 12).map(x => ({ ...lightOut(x, idx), score: +similarity(o.tokens, x.tokens).toFixed(2) })) });
      if (groups.length >= 40) break;
    }
    return { groups };
  }

  // ── approved answers ──
  const APPROVAL_FIELDS = ["Approved Answer", "Category", "Product Versions", "Deployment Conditions", "Applicable Environments", "Owner", "Review Due At", "Canonical Question"];
  async function promote({ answerId, canonicalId = "", text = "" }) {
    const a = await store.byId("rfp-answers", answerId); if (!a) throw err(404, "Historical answer not found");
    if (a["Answer Status"] !== "confirmed") throw err(409, "Only a confirmed historical answer (citation verified) can be promoted");
    const q = await store.byId("rfp-questions", a["Question ID"]);
    let canon = canonicalId ? await store.byId("canonical-questions", canonicalId) : q["Canonical Question ID"] ? await store.byId("canonical-questions", q["Canonical Question ID"]) : null;
    if (!canon) canon = await createCanonical({ text: q["Question Text Original"], category: q.Category, questionIds: [q["Question ID"]] });
    else if (q["Canonical Question ID"] !== canon["Canonical Question ID"]) await linkCanonical(canon["Canonical Question ID"], [q["Question ID"]]);
    const d = await store.byId("rfp-documents", a["Document ID"]); const rfp = await store.byId("rfp-sources", a["RFP Source ID"]);
    const category = canon.Category || q.Category || "";
    const rec = await store.create("approved-answers", {
      "Canonical Question ID": canon["Canonical Question ID"], "Canonical Question": canon["Canonical Question"], "Approved Answer": String(text || a["Answer Text Original"]).trim(),
      "Category": category, "Product Versions": a["Product Version"] || "", "Deployment Conditions": "", "Applicable Environments": "",
      "Evidence References": JSON.stringify([{ type: "historical-answer", answerId, questionId: q["Question ID"], documentId: a["Document ID"], sourceId: d?.["Source ID"] || "",
        rfp: rfp?.["Opportunity Name"] || "", location: a["Location Label"], date: a["Answer Date"] || "" }]),
      "Historical Answer IDs": listValue([answerId]), "Owner": me.username, "Approval Status": "draft", "Sensitive": SENSITIVE_CATEGORIES.has(category) ? "yes" : "no",
      "Review History": JSON.stringify([{ at: nowIso(), by: who, action: "draft", from: "", to: "draft", comment: `Promoted from historical answer ${answerId}` }]),
      "Record Status": "active", "Source IDs": listValue([d?.["Source ID"]].filter(Boolean)), "Created Via": actor.type });
    await audit("promote", "approvedanswer", rec["Approved Answer ID"], { to: "draft", details: { answerId, canonical: canon["Canonical Question ID"] } });
    return rec;
  }
  async function createApproved(values) {
    const canon = values["Canonical Question ID"] ? await store.byId("canonical-questions", values["Canonical Question ID"]) : null;
    if (!canon) throw err(400, "An approved answer belongs to a canonical question (create one first)");
    const v = {}; for (const k of APPROVAL_FIELDS) if (values[k] !== undefined) v[k] = String(values[k]).trim();
    const evidence = await checkEvidence(parseList(values["Historical Answer IDs"]));
    const category = v.Category || canon.Category || "";
    const rec = await store.create("approved-answers", { ...v, "Canonical Question ID": canon["Canonical Question ID"], "Canonical Question": canon["Canonical Question"], "Category": category,
      "Evidence References": JSON.stringify(evidence.refs), "Historical Answer IDs": listValue(evidence.ids), "Owner": v.Owner || me.username, "Approval Status": "draft",
      "Sensitive": SENSITIVE_CATEGORIES.has(category) ? "yes" : "no", "Review History": JSON.stringify([{ at: nowIso(), by: who, action: "draft", from: "", to: "draft", comment: "" }]),
      "Record Status": "active", "Source IDs": listValue(evidence.sources), "Created Via": actor.type });
    await audit("create", "approvedanswer", rec["Approved Answer ID"], { to: "draft" });
    return rec;
  }
  async function checkEvidence(answerIds) {
    const refs = [], ids = [], sources = [];
    for (const id of answerIds.slice(0, 25)) {
      const a = await store.byId("rfp-answers", id);
      if (!a) throw err(400, `Evidence ${id} not found or not visible`);
      if (a["Answer Status"] !== "confirmed") throw err(400, `Evidence ${id} is not a confirmed historical answer`);
      const d = await store.byId("rfp-documents", a["Document ID"]); const rfp = await store.byId("rfp-sources", a["RFP Source ID"]);
      refs.push({ type: "historical-answer", answerId: id, questionId: a["Question ID"], documentId: a["Document ID"], sourceId: d?.["Source ID"] || "", rfp: rfp?.["Opportunity Name"] || "", location: a["Location Label"], date: a["Answer Date"] || "" });
      ids.push(id); if (d?.["Source ID"]) sources.push(d["Source ID"]);
    }
    return { refs, ids, sources };
  }
  async function updateApproved(id, values) {
    const cur = await store.byId("approved-answers", id); if (!cur) throw err(404, "Approved answer not found");
    if (!["draft", "needs-review"].includes(cur["Approval Status"])) throw err(409, `An ${cur["Approval Status"]} answer is not edited. Draft a new answer that supersedes it.`);
    if (cur["Approval Status"] === "needs-review" && !isReviewer) throw err(403, "Only reviewers change an answer that is waiting for review");
    const v = {}; for (const k of APPROVAL_FIELDS) if (values[k] !== undefined && k !== "Canonical Question") v[k] = String(values[k]).trim();
    if (values["Historical Answer IDs"] !== undefined) { const e = await checkEvidence(parseList(values["Historical Answer IDs"])); v["Evidence References"] = JSON.stringify(e.refs); v["Historical Answer IDs"] = listValue(e.ids); v["Source IDs"] = listValue(e.sources); }
    if (values.Supersedes !== undefined) {
      if (values.Supersedes) { const old = await store.byId("approved-answers", values.Supersedes); if (!old) throw err(400, "The answer to supersede was not found"); }
      v.Supersedes = String(values.Supersedes || "");
    }
    if (v["Review Due At"] && !/^\d{4}-\d{2}-\d{2}$/.test(v["Review Due At"])) throw err(400, "Review Due At must be YYYY-MM-DD");
    if (v.Category !== undefined) v.Sensitive = SENSITIVE_CATEGORIES.has(v.Category) ? "yes" : "no";
    const changed = Object.fromEntries(Object.entries(v).filter(([k, x]) => (cur[k] || "") !== x));
    if (!Object.keys(changed).length) return cur;
    const rec = await store.update(cur._id, changed);
    await audit("update", "approvedanswer", id, { details: { changed: Object.fromEntries(Object.keys(changed).map(k => [k, { from: clip(cur[k] || "", 1500), to: clip(changed[k], 1500) }])) } });
    bustRfpIndex();
    return rec;
  }
  const TRANSITIONS = {
    submit: { from: ["draft"], to: "needs-review", reviewer: false },
    approve: { from: ["needs-review"], to: "approved", reviewer: true },
    reject: { from: ["needs-review"], to: "draft", reviewer: true, comment: true },
    outdate: { from: ["approved"], to: "outdated", reviewer: true, comment: true },
    supersede: { from: ["approved", "outdated"], to: "superseded", reviewer: true },
    "historical-only": { from: ["draft", "needs-review", "outdated"], to: "historical-only", reviewer: true, comment: true },
    reopen: { from: ["outdated", "historical-only"], to: "draft", reviewer: true, comment: true },
  };
  async function transitionApproved(id, action, { comment = "", confirmSensitive = false, supersededBy = "" } = {}) {
    const t = TRANSITIONS[action]; if (!t) throw err(400, `action must be one of ${Object.keys(TRANSITIONS).join(", ")}`);
    const cur = await store.byId("approved-answers", id); if (!cur) throw err(404, "Approved answer not found");
    const from = cur["Approval Status"] || "draft";
    if (!t.from.includes(from)) throw err(409, `Cannot ${action} an answer that is ${from}`);
    if (t.reviewer && !isReviewer) throw err(403, "Only Corporate Brain reviewers can do this");
    // approval is a human act: agents and connectors may draft, never approve
    if (action === "approve" && actor.type !== "user") throw err(403, "Only a human reviewer can approve an answer");
    if (t.comment && !String(comment).trim()) throw err(400, "A comment is required");
    if (action === "submit" || action === "approve") {
      if (!String(cur["Approved Answer"] || "").trim()) throw err(400, "The answer text is empty");
      if (!parseList(cur["Historical Answer IDs"]).length) throw err(400, "Attach at least one confirmed historical answer as evidence");
      if (!cur.Owner) throw err(400, "Assign an owner");
    }
    if (action === "approve" && cur.Sensitive === "yes") {
      if (!confirmSensitive) throw err(400, `This is a ${CATEGORY_LABEL[cur.Category] || cur.Category} answer: confirm explicitly that you reviewed the commitment it makes`);
      if (!String(comment).trim()) throw err(400, "Sensitive answers need a review comment");
    }
    let replacement = null;
    if (action === "supersede") {
      replacement = await store.byId("approved-answers", supersededBy || "");
      if (!replacement || replacement["Approved Answer ID"] === id) throw err(400, "Superseding needs the ID of the replacing approved answer");
    }
    const at = nowIso();
    const history = parseJson(cur["Review History"], []); history.push({ at, by: who, action, from, to: t.to, comment });
    const values = { "Approval Status": t.to, "Review History": JSON.stringify(history) };
    if (action === "approve") {
      values["Approved By"] = who; values["Approved At"] = at;
      if (!cur["Review Due At"]) { const d = new Date(); d.setFullYear(d.getFullYear() + 1); values["Review Due At"] = d.toISOString().slice(0, 10); }
    }
    if (action === "supersede") values["Superseded By"] = supersededBy;
    // keep the Brain in step: an approved answer is a verified knowledge entry (Lens "rfp"); outdated → disputed; superseded → superseded
    let knowledgeId = cur["Knowledge ID"];
    if (action === "approve") {
      const ev = parseJson(cur["Evidence References"], []);
      const statement = [cur["Approved Answer"], cur["Product Versions"] && `Product versions: ${cur["Product Versions"]}`, cur["Applicable Environments"] && `Environments: ${cur["Applicable Environments"]}`,
        cur["Deployment Conditions"] && `Conditions: ${cur["Deployment Conditions"]}`].filter(Boolean).join("\n");
      if (!knowledgeId) {
        const k = await services.proposeKnowledge({ knowledgeType: "approved-answer", subjectType: "approvedanswer", subjectId: id, title: `Approved answer: ${clip(cur["Canonical Question"], 200)}`,
          statement, sourceIds: [...new Set(ev.map(e => e.sourceId).filter(Boolean))], lens: "rfp", extractionMethod: "manual", note: `Approved answer ${id}` });
        knowledgeId = k["Knowledge ID"];
      }
      values["Knowledge ID"] = knowledgeId;
      await services.review(knowledgeId, "approve", { comment: comment || "Approved answer" });
    }
    const rec = await store.update(cur._id, values);
    if (knowledgeId && action === "outdate") await services.review(knowledgeId, "dispute", { comment: `Answer marked outdated: ${comment}` }).catch(e => audit("knowledge-sync-failed", "knowledge", knowledgeId, { comment: e.message }));
    if (knowledgeId && action === "supersede") {
      const kTo = replacement["Knowledge ID"];
      if (kTo) await services.review(knowledgeId, "supersede", { supersededBy: kTo, comment }).catch(e => audit("knowledge-sync-failed", "knowledge", knowledgeId, { comment: e.message }));
      else await services.review(knowledgeId, "dispute", { comment: `Superseded by ${supersededBy}, which is not approved yet` }).catch(() => {});
    }
    // approving an answer that names one it supersedes retires the old one
    if (action === "approve" && cur.Supersedes) {
      const old = await store.byId("approved-answers", cur.Supersedes);
      if (old && ["approved", "outdated"].includes(old["Approval Status"])) await transitionApproved(old["Approved Answer ID"], "supersede", { supersededBy: id, comment: `Superseded by ${id}` });
    }
    await audit(`approval:${action}`, "approvedanswer", id, { from, to: t.to, comment, details: { sensitive: cur.Sensitive === "yes", confirmSensitive: !!confirmSensitive, knowledgeId } });
    if (["approve", "supersede", "outdate"].includes(action)) {
      for (const qid of [...new Set(parseJson(cur["Evidence References"], []).map(e => e.questionId))].slice(0, 10)) {
        const q = await store.byId("rfp-questions", qid).catch(() => null); if (q) await recount(q["RFP Source ID"]).catch(() => {});
      }
    }
    bustRfpIndex();
    return rec;
  }
  async function approvedDetail(id) {
    const a = await store.byId("approved-answers", id); if (!a) return null;
    const canon = a["Canonical Question ID"] ? await store.byId("canonical-questions", a["Canonical Question ID"]) : null;
    const evidence = await Promise.all(parseList(a["Historical Answer IDs"]).map(async x => {
      const h = await store.byId("rfp-answers", x).catch(() => null); if (!h) return { "Answer ID": x, _missing: true };
      const q = await store.byId("rfp-questions", h["Question ID"]).catch(() => null);
      return { ...h, _question: q };
    }));
    const auditTrail = (await store.collect("audit-log", `values[Entity ID] = ${kq(id)}`, { maxPages: 2 })).items.sort((x, y) => String(x["Occurred At"]).localeCompare(y["Occurred At"]));
    const questions = canon ? (await store.collect("rfp-questions", `values[Canonical Question ID] = ${kq(canon["Canonical Question ID"])}`, { maxPages: 4 })).items : [];
    return { answer: a, canonical: canon, evidence, questions, audit: auditTrail, knowledge: a["Knowledge ID"] ? await store.byId("knowledge-entries", a["Knowledge ID"]) : null };
  }
  async function listApproved({ status = "", category = "", offset = 0 }) {
    const q = status ? `values[Approval Status] = ${kq(status)}` : `values[Record Status] = "active"`;
    let items = (await store.collect("approved-answers", q, { maxPages: 40 })).items.filter(x => !category || x.Category === category)
      .sort((a, b) => String(b._updatedAt).localeCompare(a._updatedAt));
    const off = Math.max(0, +offset || 0);
    return { items: items.slice(off, off + 25), total: items.length, offset: off, next: off + 25 < items.length ? off + 25 : null };
  }
  async function listHistorical({ status = "", rfpId = "", offset = 0 }) {
    const idx = await index();
    let items = idx.questions.filter(o => o.latestAnswerId && (!rfpId || o.rfpId === rfpId) && (!status || o.answerStatus === status));
    const off = Math.max(0, +offset || 0);
    return { items: items.slice(off, off + 25).map(o => lightOut(o, idx)), total: items.length, offset: off, next: off + 25 < items.length ? off + 25 : null };
  }

  // ── search index ──
  async function index(fresh = false) {
    let e = indexes.get(scopeKey);
    if (!fresh && e?.data && Date.now() - e.at < INDEX_TTL) return e.data;
    if (e?.building) return e.building;
    const building = (async () => {
      const rfps = await allRfps();
      const rfpMap = new Map(rfps.map(r => [r["RFP Source ID"], r]));
      const qs = (await pool(rfps.filter(r => r["Library Status"] !== "analysis"), CONCURRENCY,
        r => store.collect("rfp-questions", `values[RFP Source ID] = ${kq(r["RFP Source ID"])}`, { maxPages: 40 }).then(x => x.items))).flat();
      const approved = (await store.collect("approved-answers", `values[Record Status] = "active"`, { maxPages: 40 })).items;
      const questions = qs.filter(q => q["Extraction Status"] !== "rejected").map(q => ({
        id: q["Question ID"], rec: q, rfpId: q["RFP Source ID"], documentId: q["Document ID"], number: q["Question Number"] || "", text: q["Question Text Original"] || "",
        tokens: String(q["Question Text Normalized"] || "").split(" ").filter(Boolean), key: q["Question Key"], category: q.Category || "", section: q.Section || "",
        answerStatus: q["Answer Status"] || "", answerPreview: q["Answer Preview"] || "", answerTokens: null, latestAnswerId: q["Latest Answer ID"] || "",
        canonicalId: q["Canonical Question ID"] || "", extractionStatus: q["Extraction Status"] || "", locLabel: q["Location Label"] || "", level: q["Requirement Level"] || "",
      }));
      const approvedLight = approved.map(a => ({ id: a["Approved Answer ID"], rec: a, canonicalId: a["Canonical Question ID"], status: a["Approval Status"], category: a.Category || "",
        tokens: tokens(`${a["Canonical Question"]}`), text: a["Approved Answer"] || "", question: a["Canonical Question"] || "", reviewDue: a["Review Due At"] || "" }));
      const data = { at: Date.now(), questions, approved: approvedLight, rfps: rfpMap };
      indexes.set(scopeKey, { at: Date.now(), data });
      return data;
    })().finally(() => { const x = indexes.get(scopeKey); if (x) delete x.building; });
    indexes.set(scopeKey, { ...(e || {}), building });
    return building;
  }
  function lightOut(o, idx) {
    const r = idx.rfps.get(o.rfpId) || {};
    return { id: o.id, number: o.number, text: o.text, category: o.category, section: o.section, answerStatus: o.answerStatus, answerPreview: o.answerPreview,
      latestAnswerId: o.latestAnswerId, canonicalId: o.canonicalId, extractionStatus: o.extractionStatus, location: o.locLabel, documentId: o.documentId, level: o.level,
      rfpId: o.rfpId, rfp: r["Opportunity Name"] || "", customer: r["Customer Name"] || "", rfpDate: r["Submitted At"] || r["Received At"] || r["Due At"] || "",
      rfpDateKind: r["Submitted At"] ? "submitted" : r["Received At"] ? "received" : r["Due At"] ? "due" : "",
      contentClass: "historical-evidence" };
  }
  // query → ranked historical questions (+ the approved answers that apply). Keyword/structured today; a semantic provider
  // (Kinetic Search API with vector indexes) can replace scoreFn without changing callers — see RFP_INTELLIGENCE.md.
  async function search({ q = "", category = "", rfpId = "", customer = "", from = "", to = "", answered = "", limit = 25, offset = 0, exclude = "" } = {}) {
    const idx = await index();
    const qt = tokens(q);
    const phrase = String(q).toLowerCase().trim();
    let hits = idx.questions.filter(o => (!category || o.category === category) && (!rfpId || o.rfpId === rfpId) && (!exclude || o.rfpId !== exclude)
      && (!answered || (answered === "yes" ? !!o.latestAnswerId : !o.latestAnswerId)));
    if (customer) { const c = customer.toLowerCase(); hits = hits.filter(o => String(idx.rfps.get(o.rfpId)?.["Customer Name"] || "").toLowerCase().includes(c)); }
    if (from || to) hits = hits.filter(o => { const r = idx.rfps.get(o.rfpId) || {}; const d = r["Submitted At"] || r["Received At"] || r["Due At"] || ""; return d && (!from || d >= from) && (!to || d <= to + "~"); });
    let scored;
    if (qt.length) {
      scored = hits.map(o => {
        o.answerTokens ||= tokens(o.answerPreview);
        let s = similarity(qt, o.tokens) + 0.25 * similarity(qt, o.answerTokens);
        if (phrase.length > 6 && o.text.toLowerCase().includes(phrase)) s += 0.25;
        return { o, s: Math.min(1, s) };
      }).filter(x => x.s >= 0.12).sort((a, b) => b.s - a.s);
    } else scored = hits.map(o => ({ o, s: 0 }));
    const page = scored.slice(offset, offset + Math.min(limit, 25));
    const out = page.map(({ o, s }) => {
      const approved = o.canonicalId ? idx.approved.filter(a => a.canonicalId === o.canonicalId && a.status === "approved") : [];
      return { ...lightOut(o, idx), score: +s.toFixed(3), strength: qt.length ? strengthOf(s) : "", approved: approved.map(a => ({ id: a.id, text: clip(a.text, 400), reviewDue: a.reviewDue, contentClass: "current-approved" })), related: [] };
    });
    // related questions: same canonical group, else the next best matches of the same subject
    for (const h of out) {
      const o = idx.questions.find(x => x.id === h.id);
      h.related = idx.questions.filter(x => x.id !== h.id && ((h.canonicalId && x.canonicalId === h.canonicalId) || (!h.canonicalId && similarity(o.tokens, x.tokens) >= 0.6))).slice(0, 4).map(x => ({ id: x.id, text: clip(x.text, 140), rfp: idx.rfps.get(x.rfpId)?.["Opportunity Name"] || "" }));
    }
    const approvedHits = qt.length ? idx.approved.map(a => ({ a, s: similarity(qt, a.tokens) + 0.2 * similarity(qt, tokens(a.text)) })).filter(x => x.s >= 0.3 && (!category || x.a.category === category))
      .sort((x, y) => y.s - x.s).slice(0, 5).map(({ a, s }) => ({ id: a.id, question: a.question, text: clip(a.text, 500), status: a.status, score: +s.toFixed(3), strength: strengthOf(s),
        contentClass: a.status === "approved" ? "current-approved" : ["superseded", "outdated"].includes(a.status) ? "superseded" : "unapproved-draft" })) : [];
    return { total: scored.length, offset, next: offset + 25 < scored.length ? offset + 25 : null, hits: out, approved: approvedHits,
      provider: { name: "Kinetic submissions + token/synonym similarity (keyword)", semantic: false, note: "Semantic retrieval via the Kinetic Search API (vector indexes) can replace the scorer later; results and permissions stay the same." } };
  }

  // ── new RFP analysis ──
  const polarity = (t) => { const s = String(t || "").trim().toLowerCase(); if (/^(yes|included|supported|fully|comply|compliant|meets|available)\b/.test(s)) return "yes"; if (/^(no|not supported|not available|does not|cannot|n\/a|unable)\b/.test(s)) return "no"; if (/^partial/.test(s)) return "partial"; return ""; };
  async function createAnalysis({ title, customer = "", solicitation = "", dueAt = "", procurementType = "rfp", files: uploads = [], restricted = false }) {
    if (!String(title || "").trim()) throw err(400, "Give the analysis a title");
    if (!uploads.length) throw err(400, "Upload the RFP (and any attachments)");
    const rfp = await createRfp({ "Opportunity Name": title, "Customer Name": customer, "Solicitation Number": solicitation, "Due At": dueAt, "Procurement Type": procurementType,
      "Library Status": "analysis", "Opportunity Status": "unknown", restricted });
    const docs = [];
    for (const f of uploads) {
      const r = await importDocument({ rfpId: rfp["RFP Source ID"], file: f, role: "solicitation", extract: false, restricted });
      docs.push(r.document);
    }
    const an = await store.create("rfp-analyses", { "Title": title, "RFP Source ID": rfp["RFP Source ID"], "Customer Name": customer, "Solicitation Number": solicitation, "Due At": dueAt,
      "Document IDs": listValue(docs.map(d => d["Document ID"])), "Status": "queued", "Item Count": "0", "Drafted Count": "0", "No Evidence Count": "0", "Conflict Count": "0",
      "Notes": "", "Record Status": "active", "Source IDs": listValue(docs.map(d => d["Source ID"])), "Created Via": actor.type });
    await audit("create", "rfpanalysis", an["Analysis ID"], { details: { rfp: rfp["RFP Source ID"], documents: docs.map(d => d["Document ID"]) } });
    runAnalysis(an["Analysis ID"]).catch(e => console.error("[corporate-brain] rfp analysis", an["Analysis ID"], e.message));
    return { analysis: an, rfp, documents: docs };
  }
  async function runAnalysis(analysisId) {
    const an = await store.byId("rfp-analyses", analysisId); if (!an) throw err(404, "Analysis not found");
    await store.update(an._id, { Status: "analyzing" });
    try {
      const existing = new Set((await store.collect("rfp-analysis-items", `values[Analysis ID] = ${kq(analysisId)}`, { maxPages: 40 })).items.map(x => `${x["Document ID"]}|${x.Sequence}`));
      const idx = await index(true);
      let seqBase = 0, drafted = 0, noEvidence = 0, conflicts = 0, count = 0; const notes = [];
      for (const docId of parseList(an["Document IDs"])) {
        const d = await store.byId("rfp-documents", docId); if (!d) continue;
        const doc = parseDocument(await files.download(d), d["File Name"]);
        const { items, notes: n } = extractQuestions(doc, { role: "solicitation" });
        notes.push(...n.map(x => `${d["File Name"]}: ${x}`));
        await pool(items, CONCURRENCY, async (it) => {
          const seq = String(seqBase + it.seq).padStart(5, "0");
          count++;
          const toks = tokens(it.text);
          const matches = idx.questions.filter(o => o.rfpId !== an["RFP Source ID"]).map(o => ({ o, s: (o.key === it.key ? 1 : similarity(toks, o.tokens)) }))
            .filter(x => x.s >= 0.18).sort((a, b) => b.s - a.s).slice(0, 5);
          const canon = new Set(matches.filter(m => m.s >= 0.35).map(m => m.o.canonicalId).filter(Boolean));
          const approved = idx.approved.filter(a => a.status === "approved" && (canon.has(a.canonicalId) || similarity(toks, a.tokens) >= 0.6))
            .map(a => ({ a, s: Math.max(similarity(toks, a.tokens), ...matches.filter(m => m.o.canonicalId === a.canonicalId).map(m => m.s)) })).sort((x, y) => y.s - x.s);
          const flags = [];
          let draft = "", basis = "no-evidence", citations = [], used = [];
          const best = matches[0];
          if (approved.length && approved[0].s >= 0.6) {
            const a = approved[0].a; draft = a.text; basis = "approved-answer"; used = [a.id];
            citations = [{ type: "approved-answer", id: a.id, question: a.question }, ...parseJson(a.rec["Evidence References"], []).map(e => ({ type: "historical-answer", id: e.answerId, documentId: e.documentId, location: e.location, rfp: e.rfp }))];
            if (a.reviewDue && a.reviewDue < nowIso().slice(0, 10)) flags.push(`The approved answer's review date (${a.reviewDue}) has passed`);
            const distinct = new Set(approved.filter(x => x.s >= 0.6).map(x => x.a.text.trim()));
            if (distinct.size > 1) flags.push(`${distinct.size} different approved answers apply — choose the one whose versions and environment fit`);
          } else if (best && best.s >= 0.6 && best.o.latestAnswerId) {
            const h = await store.byId("rfp-answers", best.o.latestAnswerId).catch(() => null);
            if (h && h["Answer Status"] === "confirmed") {
              draft = h["Answer Text Original"]; basis = "historical-answer";
              citations = [{ type: "historical-answer", id: h["Answer ID"], questionId: best.o.id, documentId: h["Document ID"], location: h["Location Label"], rfp: idx.rfps.get(best.o.rfpId)?.["Opportunity Name"] || "", date: h["Answer Date"] || "" }];
              flags.push("Drafted from a historical answer that has not been approved for reuse — check it is still true");
            } else { basis = "unconfirmed-history"; flags.push("Similar questions exist, but their answers are not confirmed yet — confirm the extraction first"); }
          } else if (best && best.s >= 0.35) basis = "partial-evidence";
          // contradictions among the confirmed historical answers to strong matches
          const pol = new Set(matches.filter(m => m.s >= 0.6 && m.o.answerPreview).map(m => polarity(m.o.answerPreview)).filter(Boolean));
          if (pol.has("yes") && pol.has("no")) flags.push("Historical answers to similar questions disagree (some yes, some no)");
          if (!draft) noEvidence++; else drafted++;
          if (flags.some(f => /disagree|different approved/.test(f))) conflicts++;
          if (existing.has(`${docId}|${seq}`)) return;
          await store.create("rfp-analysis-items", {
            "Analysis ID": analysisId, "Sequence": seq, "Question Number": it.number, "Question Text Original": it.text, "Section": clip(it.section, 250), "Requirement Level": it.level,
            "Requirement Basis": clip(it.levelBasis, 250), "Source Location": JSON.stringify(it.loc), "Location Label": clip(it.locLabel, 250), "Document ID": docId, "Category": it.category,
            "Draft Answer": draft, "Draft Basis": basis, "Content Class": draft ? "ai-generated-draft" : "no-draft", "Approved Answer IDs": listValue(used),
            "Matched Questions": JSON.stringify(matches.map(m => ({ id: m.o.id, text: clip(m.o.text, 300), rfp: idx.rfps.get(m.o.rfpId)?.["Opportunity Name"] || "", score: +m.s.toFixed(3), strength: strengthOf(m.s),
              answered: !!m.o.latestAnswerId, answerStatus: m.o.answerStatus, location: m.o.locLabel, canonicalId: m.o.canonicalId }))),
            "Citations": JSON.stringify(citations), "Match Strength": best ? strengthOf(best.s) : "none", "Match Score": best ? best.s.toFixed(3) : "0", "Conflicts": JSON.stringify(flags),
            "Review Status": draft ? "ai-draft" : "needs-evidence", "Final Answer": "", "Record Status": "active", "Created Via": "agent",
          });
        });
        seqBase += items.length;
      }
      await store.update(an._id, { Status: "ready", "Item Count": String(count), "Drafted Count": String(drafted), "No Evidence Count": String(noEvidence), "Conflict Count": String(conflicts), Notes: JSON.stringify(notes.slice(0, 40)) });
      await audit("analyze", "rfpanalysis", analysisId, { details: { items: count, drafted, noEvidence, conflicts } });
    } catch (e) { await store.update(an._id, { Status: "failed", Notes: JSON.stringify([`Analysis failed: ${e.message}`]) }); throw e; }
  }
  async function analysisItems(analysisId, { filter = "", offset = 0, all = false } = {}) {
    let items = (await store.collect("rfp-analysis-items", `values[Analysis ID] = ${kq(analysisId)}`, { maxPages: 40 })).items.sort((a, b) => String(a.Sequence).localeCompare(b.Sequence));
    if (filter === "no-evidence") items = items.filter(x => !x["Draft Answer"]);
    else if (filter === "conflicts") items = items.filter(x => parseJson(x.Conflicts, []).some(f => /disagree|different approved|review date/.test(f)));
    else if (filter === "mandatory") items = items.filter(x => x["Requirement Level"] === "mandatory");
    else if (filter) items = items.filter(x => x["Review Status"] === filter);
    if (all) return items;
    const off = Math.max(0, +offset || 0);
    return { items: items.slice(off, off + 25), total: items.length, offset: off, next: off + 25 < items.length ? off + 25 : null };
  }
  async function reviewItem(itemId, { action, finalAnswer = "" }) {
    const it = await store.byId("rfp-analysis-items", itemId); if (!it) throw err(404, "Item not found");
    const at = nowIso();
    const v = { "Reviewed By": who, "Reviewed At": at };
    if (action === "accept") { if (!it["Draft Answer"]) throw err(400, "There is no draft to accept — write the answer"); v["Review Status"] = "accepted"; v["Final Answer"] = it["Draft Answer"]; }
    else if (action === "edit") { if (!String(finalAnswer).trim()) throw err(400, "Write the answer"); v["Review Status"] = "edited"; v["Final Answer"] = String(finalAnswer).trim(); }
    else if (action === "needs-evidence") v["Review Status"] = "needs-evidence";
    else if (action === "reject") { v["Review Status"] = "rejected-draft"; v["Final Answer"] = ""; }
    else throw err(400, "action must be accept, edit, needs-evidence or reject");
    const rec = await store.update(it._id, v);
    await audit(`analysis:${action}`, "rfpanalysisitem", itemId, { details: { analysis: it["Analysis ID"], final: clip(v["Final Answer"] || "", 500) } });
    return rec;
  }
  async function exportCsv(analysisId) {
    const an = await store.byId("rfp-analyses", analysisId); if (!an) throw err(404, "Analysis not found");
    const items = await analysisItems(analysisId, { all: true });
    const cell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const head = ["Order", "Question Number", "Section", "Requirement", "Requirement Level", "Proposed Answer (AI-generated draft)", "Draft Basis", "Match Strength", "Match Score",
      "Citations", "Flags", "Review Status", "Final Answer", "Reviewed By", "Source Location"];
    const rows = items.map(x => [x.Sequence, x["Question Number"], x.Section, x["Question Text Original"], x["Requirement Level"], x["Draft Answer"], x["Draft Basis"], x["Match Strength"], x["Match Score"],
      parseJson(x.Citations, []).map(c => `${c.type} ${c.id}${c.location ? ` (${c.rfp ? c.rfp + ", " : ""}${c.location})` : ""}`).join("; "), parseJson(x.Conflicts, []).join("; "),
      x["Review Status"], x["Final Answer"], x["Reviewed By"], x["Location Label"]]);
    await audit("export", "rfpanalysis", analysisId, { details: { rows: rows.length } });
    return "﻿" + [head, ...rows].map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
  }

  // ── retrieval for other agents: every hit says what kind of content it is ──
  async function retrieve({ q, limit = 10, includeDrafts = false }) {
    const r = await search({ q, limit });
    const out = [
      ...r.approved.map(a => ({ contentClass: a.contentClass, type: "approved-answer", id: a.id, question: a.question, text: a.text, score: a.score, status: a.status })),
      ...r.hits.map(h => ({ contentClass: "historical-evidence", type: "historical-question", id: h.id, question: h.text, answerPreview: h.answerPreview, answerStatus: h.answerStatus,
        source: { rfp: h.rfp, customer: h.customer, date: h.rfpDate, location: h.location, documentId: h.documentId }, score: h.score, strength: h.strength,
        note: "Historical evidence: what Kinetic answered at the time. Not a current verified fact unless an approved answer says so." })),
    ];
    if (includeDrafts) {
      // drafts stay AI-generated content even after a person accepts them for one proposal: they are never approved knowledge
      const items = (await Promise.all(["ai-draft", "accepted", "edited"].map(st => store.collect("rfp-analysis-items", `values[Review Status] = ${kq(st)}`, { maxPages: 4 }).then(r => r.items)))).flat()
        .filter(x => x["Draft Answer"]);
      const qt = tokens(q);
      out.push(...items.map(x => ({ x, s: similarity(qt, tokens(x["Question Text Original"])) })).filter(y => y.s >= 0.35).sort((a, b) => b.s - a.s).slice(0, 5)
        .map(({ x, s }) => ({ contentClass: "ai-generated-draft", type: "analysis-draft", id: x["Analysis Item ID"], question: x["Question Text Original"], text: x["Draft Answer"],
          reviewStatus: x["Review Status"], basis: x["Draft Basis"], score: +s.toFixed(3), note: "AI-generated draft for one proposal — not approved knowledge" })));
    }
    return { query: q, results: out.slice(0, Math.max(limit, 10) * 2), provider: r.provider };
  }

  // KPI tiles from the counters stored on each RFP and document (a few small pages) — not the full question index,
  // which costs one query per RFP and is built only when someone searches. Cached per scope; concurrent callers share one build.
  async function summary() {
    const e = summaries.get(scopeKey);
    if (e?.data && Date.now() - e.at < SUMMARY_TTL) return e.data;
    if (e?.building) return e.building;
    const building = (async () => {
      const sum = (rows, f) => rows.reduce((t, x) => t + (+x[f] || 0), 0);
      const [hist, analyses, docs, approved, canon] = await Promise.all([
        store.collect("rfp-sources", `values[Library Status] = "historical"`, { maxPages: 40 }),
        store.collect("rfp-sources", `values[Library Status] = "analysis"`, { maxPages: 40 }),
        store.collect("rfp-documents", `values[Extraction Status] IN ("extracted", "partial")`, { maxPages: 40 }),
        store.collect("approved-answers", `values[Record Status] = "active"`, { maxPages: 40 }),
        store.collect("canonical-questions", `values[Record Status] = "active"`, { maxPages: 40 }),
      ]);
      const h = hist.items, aa = approved.items;
      const data = { rfps: h.length, analyses: analyses.items.length, questions: sum(h, "Question Count"), answered: sum(h, "Answered Count"),
        withApproved: sum(h, "Approved Count"), needsReview: sum(docs.items, "Needs Review Count"), docsToReview: docs.items.length, canonical: canon.items.length,
        approved: aa.filter(a => a["Approval Status"] === "approved").length, awaitingApproval: aa.filter(a => a["Approval Status"] === "needs-review").length,
        drafts: aa.filter(a => a["Approval Status"] === "draft").length, builtAt: new Date().toISOString() };
      summaries.set(scopeKey, { at: Date.now(), data });
      return data;
    })().catch(err => { summaries.delete(scopeKey); throw err; });
    summaries.set(scopeKey, { ...(e || {}), building });
    return building;
  }

  return { allRfps, listRfps, reviewDocuments, getRfp, createRfp, updateRfp, linkSources, importDocument, runExtraction, documentRows, confirmRows, updateRow, correctAnswer, questionDetail, listQuestions,
    createCanonical, linkCanonical, suggestGroups, promote, createApproved, updateApproved, transitionApproved, approvedDetail, listApproved, listHistorical,
    search, index, createAnalysis, runAnalysis, analysisItems, reviewItem, exportCsv, retrieve, summary, recount };
}
