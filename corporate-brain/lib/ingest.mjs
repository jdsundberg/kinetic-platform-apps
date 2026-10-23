// Ingestion pipeline — idempotent and resumable.
//  1 discover → 2 retrieve allowed metadata → 3 detect already-processed (hashed Source ID)
//  4 normalize → 5 resolve companies/people → 6 extract candidates → 7 save source
//  8 save proposed knowledge/events/communications → 9 route to review (status proposed)
//  10 track checkpoint, counters and errors on the research-jobs record.
// Re-running a batch is safe: an unchanged record is skipped, a changed one is updated and its
// knowledge flagged for re-review, a deleted or permission-revoked one is marked, never silently kept.
import { CONNECTORS } from "./connectors/index.mjs";
import { sourceIdFor, listValue, parseList, parseJson, newId } from "./core.mjs";
import { extractCandidates } from "./extract.mjs";
import { kq } from "./store.mjs";

const KINETIC_DOMAINS = ["kineticdata.com", "kinops.io"];
// Domains several organizations share (the whole Army, Guard included, sends from army.mil): never mapped to a
// company by domain. A sender there joins the thread's own company when the thread names exactly one.
export const SHARED_DOMAIN = /(^|\.)(army\.mil|mail\.mil|navy\.mil|af\.mil|us\.af\.mil|usmc\.mil)$/i;
// Automated senders and group addresses are not people.
export const AUTOMATED_ADDRESS = /(^|[._-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|calendar|bounce|alerts?)([._+-]|@)|^(support|sales|info|help|admin|billing|kinetic\.data|driveninsights)@kineticdata\.com$/i;
const MAX_BATCHES_PER_RUN = 8;      // bounded work per run; the job pauses and resumes from its checkpoint
const MAX_RECORDS_PER_BATCH = 25;
const running = new Set();          // in-process guard against concurrent runs of one job

export function validateRecord(r) {
  const errs = [];
  if (!r || typeof r !== "object") return ["record must be an object"];
  if (!CONNECTORS[r.system]) errs.push(`unknown system "${r.system}"`);
  if (!r.originalId) errs.push("originalId is required");
  if (!r.deleted && !r.permissionRevoked && !r.title) errs.push("title is required");
  if (r.excerpt && String(r.excerpt).length > 4000) errs.push("excerpt longer than 4000 characters — store a reference, not the document");
  return errs;
}

export function createIngestion(store, services, { kineticRequest, auth, actor }) {
  async function flagCitingKnowledge(source, reason) {
    const scope = source["Company ID"] ? `values[Company ID] = ${kq(source["Company ID"])}` : "";
    const kn = (await store.collect("knowledge-entries", scope, { maxPages: 8 })).items
      .filter(k => parseList(k["Supporting Source IDs"]).includes(source["Source ID"]));
    let n = 0, blocked = 0;
    for (const k of kn) {
      const st = k["Review Status"];
      const action = st === "verified" ? "dispute" : (["proposed", "disputed"].includes(st) ? "research" : null);
      if (!action) continue;
      try { await services.review(k["Knowledge ID"], action, { comment: `Evidence changed: ${reason} (${source["Source ID"]})` }); n++; }
      catch (e) {
        // e.g. a member re-syncing cannot change reviewed knowledge — leave a visible trail for reviewers
        blocked++;
        await services.audit("flag-blocked", "knowledge", k["Knowledge ID"], { comment: `Evidence changed (${reason}, ${source["Source ID"]}) but this entry could not be flagged: ${e.message}` });
      }
    }
    if (blocked) throw Object.assign(new Error(`${blocked} knowledge entr${blocked === 1 ? "y" : "ies"} citing ${source["Source ID"]} need a reviewer to re-check them (${reason})`), { status: 403, retryable: false, partial: n });
    return n;
  }

  let kineticId;   // Kinetic Data's company ID, looked up once per ingestion instance
  async function processRecord(rec, job) {
    const errs = validateRecord(rec);
    if (errs.length) return { outcome: "failed", error: errs.join("; ") };
    const sid = sourceIdFor(rec.system, rec.originalId);
    const existing = await store.byId("sources", sid);
    const now = new Date().toISOString();

    if (existing) {
      if (rec.deleted) {
        if (existing["Processing Status"] === "source-deleted") return { outcome: "skipped", sourceId: sid };
        await store.update(existing._id, { "Processing Status": "source-deleted", "Last Synced At": now, "Excerpt": "" });
        const flagged = await flagCitingKnowledge(existing, "original deleted in source system");
        await services.audit("source-deleted", "source", sid, { details: { flagged } });
        return { outcome: "updated", sourceId: sid, note: `deleted upstream; ${flagged} knowledge entries flagged` };
      }
      if (rec.permissionRevoked) {
        await store.update(existing._id, { "Access Scope": "restricted", "Processing Status": "permission-restricted", "Last Synced At": now, "Excerpt": "" });
        await services.audit("source-restricted", "source", sid, {});
        return { outcome: "updated", sourceId: sid, note: "permission restricted" };
      }
      if (existing["Content Hash"] && existing["Content Hash"] === rec.contentHash) {
        await store.update(existing._id, { "Last Synced At": now });
        return { outcome: "skipped", sourceId: sid };
      }
      await store.update(existing._id, { "Title": rec.title, "Excerpt": rec.excerpt || "", "Content Hash": rec.contentHash || "", "Original URL": rec.url || "",
        "Processing Status": "changed", "Last Synced At": now });
      const flagged = await flagCitingKnowledge(existing, "original content changed");
      await services.audit("source-changed", "source", sid, { details: { flagged } });
      return { outcome: "updated", sourceId: sid, note: `content changed; ${flagged} knowledge entries flagged` };
    }
    if (rec.deleted || rec.permissionRevoked) return { outcome: "skipped", sourceId: sid, note: "never ingested" };

    // 5. resolve entities
    const scope = parseJson(job["Scope"], {});
    const companies = [];
    const pushCo = (c) => { if (c && !companies.some(x => x["Company ID"] === c["Company ID"])) companies.push(c); };
    if (job["Subject Type"] === "company" && job["Subject ID"]) pushCo(await store.byId("companies", job["Subject ID"]));
    for (const id of rec.companyIds || []) pushCo(await store.byId("companies", id));   // e.g. from the thread's Gmail labels
    for (const name of rec.companyHints || []) pushCo((await services.resolveCompany({ name, create: true, sourceIds: [sid] })).company);
    const people = [];
    for (const p of (rec.participants || []).slice(0, 15)) {
      if (!p.email || AUTOMATED_ADDRESS.test(p.email)) continue;
      const domain = p.email.split("@")[1] || "";
      const isKinetic = KINETIC_DOMAINS.includes(domain);
      let companyId = "";
      if (SHARED_DOMAIN.test(domain)) companyId = companies.length === 1 ? companies[0]["Company ID"] : "";
      else if (!isKinetic) { const r = await services.resolveCompany({ domain }); if (r.company) { companyId = r.company["Company ID"]; pushCo(r.company); } }
      else companyId = kineticId ??= (await services.resolveCompany({ name: "Kinetic Data", create: false })).company?.["Company ID"] || "";
      const r = await services.resolvePerson({ name: p.name, email: p.email, companyId, create: !!scope.createPeople, sourceIds: [sid] });
      if (r.person) people.push(r.person);
    }

    // 7. source reference (metadata + short excerpt; the original stays in its system)
    let source;
    try { source = await store.create("sources", {
      "Source ID": sid, "Source Type": rec.sourceType || "", "Source System": rec.system, "Original ID": rec.originalId, "Title": rec.title,
      "Source Date": rec.date || "", "Owner": rec.owner || "", "Access Scope": rec.accessScope || "internal", "Original URL": rec.url || "",
      "Excerpt": rec.excerpt || "", "Content Hash": rec.contentHash || "", "Processing Status": "retrieved",
      "Company ID": companies[0]?.["Company ID"] || "", "Company IDs": listValue(companies.map(c => c["Company ID"])),
      "Person IDs": listValue(people.map(p => p["Person ID"])), "Ingest Job ID": job["Job ID"], "Last Synced At": now,
      "Record Status": "active", "Created Via": actor.type,
    }); } catch (e) {
      // another job ingested the same original between our check and create — it is already in the brain
      if (/unique/i.test(e.message) && (await store.byId("sources", sid))) return { outcome: "skipped", sourceId: sid, note: "ingested concurrently by another job" };
      throw e;
    }

    // 6 + 8. candidates → proposed records
    const c = extractCandidates(rec, { companies, people, sourceId: sid });
    const knowledgeIds = [];
    for (const k of c.knowledge) {
      const kr = await services.proposeKnowledge({ ...k, jobId: job["Job ID"] });
      knowledgeIds.push(kr["Knowledge ID"]);
    }
    for (const e of c.events) {
      const ev = await store.create("historical-events", {
        "Title": e.title, "Event Type": e.eventType, "Event Date": e.date, "Date Precision": e.precision, "Company ID": e.companyId,
        "Person IDs": listValue(people.map(p => p["Person ID"])), "Description": e.description, "Verification Status": "proposed",
        "Knowledge ID": e.linkKnowledgeIndex != null ? knowledgeIds[e.linkKnowledgeIndex] || "" : "", "Record Status": "active",
        "Source IDs": listValue([sid]), "Created Via": actor.type,
      });
      await services.audit("create", "event", ev["Event ID"], { details: { sourceId: sid } });
    }
    for (const m of c.communications) {
      await store.create("communications", {
        "Channel": m.channel, "Subject": m.subject, "Communication Date": m.date, "Participants": JSON.stringify(m.participants),
        "Company ID": m.companyId, "Company IDs": listValue(companies.map(x => x["Company ID"])), "Person IDs": listValue(people.map(p => p["Person ID"])),
        "Source ID": sid, "Summary": m.summary, "Record Status": "active", "Source IDs": listValue([sid]), "Created Via": actor.type,
      });
    }
    for (const co of companies) await services.link("source", sid, "company", co["Company ID"], "evidence-for", { sourceIds: [sid] });
    await store.update(source._id, { "Processing Status": "extracted" });
    return { outcome: "created", sourceId: sid, proposed: knowledgeIds.length, events: c.events.length };
  }

  async function withRetry(fn, attempts = 3) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); } catch (e) {
        last = e;
        // a concurrent writer touched the same submission: re-reading and retrying is safe
        const conflict = /updated or deleted by another user/i.test(e.message);
        if (e.retryable === false || (!conflict && e.status && e.status < 500 && e.status !== 429)) break;
        await new Promise(r => setTimeout(r, 500 * 2 ** i));
      }
    }
    throw last;
  }

  // Processes one bounded batch and records progress on the job.
  async function processBatch(job, records, { checkpoint, done } = {}) {
    if (records.length > MAX_RECORDS_PER_BATCH) throw Object.assign(new Error(`batches are limited to ${MAX_RECORDS_PER_BATCH} records`), { status: 400 });
    const results = [];
    for (const rec of records) {
      try { results.push({ originalId: rec.originalId, ...(await withRetry(() => processRecord(rec, job))) }); }
      catch (e) { results.push({ originalId: rec?.originalId, outcome: "failed", error: e.message }); }
    }
    const fresh = await store.byId("research-jobs", job["Job ID"]);
    const n = (k) => parseInt(fresh[k] || "0", 10) || 0;
    const errors = parseJson(fresh["Errors"], []);
    for (const r of results.filter(r => r.outcome === "failed")) errors.push({ at: new Date().toISOString(), originalId: r.originalId, error: r.error });
    const values = {
      "Items Discovered": String(n("Items Discovered") + records.length),
      "Items Processed": String(n("Items Processed") + results.filter(r => r.outcome === "created" || r.outcome === "updated").length),
      "Items Skipped": String(n("Items Skipped") + results.filter(r => r.outcome === "skipped").length),
      "Items Failed": String(n("Items Failed") + results.filter(r => r.outcome === "failed").length),
      "Errors": JSON.stringify(errors.slice(-25)),
      "Status": done ? (results.length && results.every(r => r.outcome === "failed") ? "failed" : "completed") : "running",
    };
    if (checkpoint !== undefined) values["Checkpoint"] = JSON.stringify(checkpoint);
    if (!fresh["Started At"]) values["Started At"] = new Date().toISOString();
    if (done) values["Completed At"] = new Date().toISOString();
    await store.update(fresh._id, values);
    return { results, job: { ...fresh, ...values } };
  }

  // Server-side pull: runs up to MAX_BATCHES_PER_RUN batches from the stored checkpoint, then pauses.
  async function runPull(jobId) {
    if (running.has(jobId)) throw Object.assign(new Error("This job is already running"), { status: 409 });
    running.add(jobId);
    let job = await store.byId("research-jobs", jobId);
    try {
      const conn = CONNECTORS[job["Connector"]];
      if (!conn?.discover) throw new Error(`Connector ${job["Connector"]} does not support server pull — use agent-mediated batches`);
      await store.update(job._id, { "Status": "running", "Started At": job["Started At"] || new Date().toISOString(), "Attempts": String((parseInt(job["Attempts"] || "0", 10) || 0) + 1) });
      let checkpoint = parseJson(job["Checkpoint"], null);
      const scope = parseJson(job["Scope"], {});
      const size = Math.min(parseInt(job["Batch Size"] || "10", 10) || 10, MAX_RECORDS_PER_BATCH);
      for (let b = 0; b < MAX_BATCHES_PER_RUN; b++) {
        const page = await withRetry(() => conn.discover(scope, checkpoint, { batchSize: size, kineticRequest, auth }));
        const r = await processBatch(job, page.records, { checkpoint: page.checkpoint, done: page.done });
        job = r.job; checkpoint = page.checkpoint;
        if (page.done) return job;
      }
      await store.update(job._id, { "Status": "paused", "Summary": `Paused after ${MAX_BATCHES_PER_RUN} batches; run again to resume from the checkpoint.` });
      return { ...job, Status: "paused" };
    } catch (e) {
      const fresh = await store.byId("research-jobs", jobId);
      const errors = parseJson(fresh["Errors"], []); errors.push({ at: new Date().toISOString(), error: e.message });
      await store.update(fresh._id, { "Status": e.notConfigured ? "blocked" : "failed", "Errors": JSON.stringify(errors.slice(-25)) });
      throw e;
    } finally { running.delete(jobId); }
  }

  async function createJob({ title, jobType = "ingestion", connector, scope = {}, subjectType = "", subjectId = "", batchSize = 10 }) {
    if (jobType === "ingestion" && !CONNECTORS[connector]) throw Object.assign(new Error(`Unknown connector ${connector}`), { status: 400 });
    if (connector === "gmail" && !scope.query) throw Object.assign(new Error("Gmail jobs need a restricted query"), { status: 400 });
    const job = await store.create("research-jobs", {
      "Job ID": newId("research-jobs"), "Title": title, "Job Type": jobType, "Connector": connector || "", "Scope": JSON.stringify(scope),
      "Subject Type": subjectType, "Subject ID": subjectId, "Status": "queued", "Checkpoint": "", "Batch Size": String(Math.min(batchSize, 25)),
      "Items Discovered": "0", "Items Processed": "0", "Items Skipped": "0", "Items Failed": "0", "Errors": "[]",
      "Requested By": actor.label || actor.username, "Attempts": "0", "Record Status": "active", "Created Via": actor.type,
    });
    await services.audit("create", "job", job["Job ID"], { details: { connector, scope } });
    return job;
  }

  return { processRecord, processBatch, runPull, createJob, MAX_RECORDS_PER_BATCH };
}
