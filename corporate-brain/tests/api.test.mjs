// API integration tests against a live Kinetic space (drives server.mjs through the launcher's helper contract).
//   KINETIC_URL=… KINETIC_USER=<admin> KINETIC_PASS=… node apps/corporate-brain/tests/api.test.mjs
// Covers: ingestion idempotency + change/delete detection, evidence/provenance rules, review flow,
// server-pull connector (GitHub, public repo), notes, historian citations, and permissions with two
// temporary non-admin users (a member and an outsider). Everything it creates is removed at the end.
import crypto from "crypto";
import { call, basic, kineticRequest } from "./harness.mjs";
import { sourceIdFor } from "../lib/core.mjs";

const stamp = Date.now().toString(36).toUpperCase();
const ADMIN = basic();
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const created = { users: [], companyId: null, jobIds: [], sales: [] };   // sales: [form, idField, id, knowledgeId]

async function cleanup() {
  const del = async (form, q) => {
    for (let i = 0; i < 20; i++) {
      const r = await kineticRequest("GET", `/kapps/corporate-brain/forms/${form}/submissions?limit=25&q=${encodeURIComponent(q)}`, null, ADMIN);
      const subs = r.data.submissions || []; if (!subs.length) break;
      for (const s of subs) await kineticRequest("DELETE", `/submissions/${s.id}`, null, ADMIN);
    }
  };
  if (created.companyId) {
    for (const f of ["sources", "knowledge-entries", "historical-events", "communications"]) await del(f, `values[Company ID] = "${created.companyId}"`);
    await del("relationships", `values[To ID] = "${created.companyId}"`);
    await del("companies", `values[Company ID] = "${created.companyId}"`);
  }
  for (const j of created.jobIds) { await del("sources", `values[Ingest Job ID] = "${j}"`); await del("knowledge-entries", `values[Job ID] = "${j}"`); await del("research-jobs", `values[Job ID] = "${j}"`); }
  for (const [form, idField, id, kid] of created.sales) {
    await del(form, `values[${idField}] = "${id}"`);
    if (kid) await del("knowledge-entries", `values[Knowledge ID] = "${kid}"`);
    if (form === "deals") await del("deal-pricing", `values[Deal ID] = "${id}"`);
  }
  for (const u of created.users) await kineticRequest("DELETE", `/users/${encodeURIComponent(u)}`, null, ADMIN);
}

try {
  // ── setup: test company ──
  const co = await call("POST", "/entities/companies", { values: { Name: `TEST Corp ${stamp}` } });
  check("create company (status defaults to Unknown, not invented)", co.status === 201 && co.body.item["Customer Status"] === "Unknown", `status ${co.status}`);
  const CO = created.companyId = co.body.item["Company ID"];
  const dup = await call("POST", "/entities/companies", { values: { Name: `TEST Corp ${stamp}` } });
  check("duplicate company name is refused", dup.status === 409);

  // ── ingestion idempotency ──
  const job = (await call("POST", "/jobs", { connector: "google-drive", title: `TEST ingest ${stamp}`, subjectType: "company", subjectId: CO })).body.job;
  created.jobIds.push(job["Job ID"]);
  const rec = { system: "google-drive", originalId: `test-${stamp}-AbC`, sourceType: "document", title: `TEST Corp License Agreement 01JAN20`, date: "2020-01-02", url: "https://example.invalid/doc", excerpt: "test", contentHash: "h1", accessScope: "internal", participants: [], companyHints: [] };
  const b1 = await call("POST", `/jobs/${job["Job ID"]}/batch`, { records: [rec] }, { agent: "test-agent" });
  check("first ingestion creates the source", b1.body.results?.[0]?.outcome === "created", JSON.stringify(b1.body.results?.[0] || b1.body));
  check("rule-based extraction proposed a fact and an event", b1.body.results?.[0]?.proposed === 1 && b1.body.results?.[0]?.events === 1);
  const b2 = await call("POST", `/jobs/${job["Job ID"]}/batch`, { records: [rec] }, { agent: "test-agent" });
  check("re-ingesting the same record is skipped", b2.body.results?.[0]?.outcome === "skipped");
  const lower = await call("POST", `/jobs/${job["Job ID"]}/batch`, { records: [{ ...rec, originalId: rec.originalId.toLowerCase() }] }, { agent: "test-agent" });
  check("an ID differing only in case is a different source (no case-insensitive collision)", lower.body.results?.[0]?.outcome === "created");
  const SID = sourceIdFor("google-drive", rec.originalId);
  const kn = (await call("GET", `/entities/knowledge-entries?companyId=${CO}&kind=fact`)).body.items.find(k => k["Supporting Source IDs"].includes(SID));
  check("proposed knowledge cites the source", !!kn && kn["Review Status"] === "proposed");

  // ── review flow & provenance ──
  const agentApprove = await call("POST", `/knowledge/${kn["Knowledge ID"]}/review`, { action: "approve" }, { agent: "test-agent" });
  check("an agent cannot verify knowledge", agentApprove.status === 400 || agentApprove.status === 403, `status ${agentApprove.status}`);
  const rejNoComment = await call("POST", `/knowledge/${kn["Knowledge ID"]}/review`, { action: "reject" });
  check("rejecting requires a comment", rejNoComment.status === 400);
  const approve = await call("POST", `/knowledge/${kn["Knowledge ID"]}/review`, { action: "approve", comment: "test" });
  check("a human reviewer can verify", approve.status === 200 && approve.body.entry["Review Status"] === "verified" && !!approve.body.entry["Verified By"]);
  await sleep(2500);
  const ev = (await call("GET", `/entities/historical-events?companyId=${CO}`)).body.items.find(e => e["Knowledge ID"] === kn["Knowledge ID"]);
  check("event backed by the knowledge became verified", ev?.["Verification Status"] === "verified");
  const editVerified = await call("PUT", `/entities/historical-events/${ev._id}`, { values: { Title: "rewritten history" } });
  check("verified events are not overwritten", editVerified.status === 409);
  const detail = await call("GET", `/knowledge/${kn["Knowledge ID"]}`);
  check("knowledge detail returns sources + audit trail", detail.body.sources?.[0]?.["Source ID"] === SID && detail.body.audit?.some(a => a.Action === "review:approve"));
  const badCite = await call("POST", "/entities/knowledge-entries", { values: { knowledgeType: "fact", title: "x", statement: "y", sourceIds: ["SR-DOESNOTEXIST"], companyId: CO } });
  check("citing a non-existent source is refused", badCite.status === 400);
  const protectedEdit = await call("PUT", `/entities/knowledge-entries/${kn._id}`, { values: { "Review Status": "proposed", "Verified By": "mallory" } });
  check("review fields cannot be edited directly", protectedEdit.body.unchanged === true || (protectedEdit.body.item && protectedEdit.body.item["Review Status"] === "verified"));

  // contradiction routing through the app path (?completed=true → Submission Submitted → Task workflow)
  const contra = await call("POST", "/entities/knowledge-entries", { values: { knowledgeType: "claim", title: `TEST contradicting claim ${stamp}`, statement: "The agreement was signed in 2019, not 2020.", sourceIds: [SID], companyId: CO, contradicts: [kn["Knowledge ID"]] } });
  let contraStatus = "";
  for (let i = 0; i < 15; i++) { await sleep(3000); contraStatus = (await call("GET", `/knowledge/${contra.body.item["Knowledge ID"]}`)).body.entry["Review Status"]; if (contraStatus !== "proposed") break; }
  check("contradicting proposal is routed to disputed by the Task workflow", contraStatus === "disputed", contraStatus);
  const original = (await call("GET", `/knowledge/${kn["Knowledge ID"]}`)).body;
  check("the original claim is kept and linked, not overwritten", original.entry.Contradicts.includes(contra.body.item["Knowledge ID"]) && original.entry["Review Status"] === "verified");

  // ── change and deletion upstream ──
  const changed = await call("POST", `/jobs/${job["Job ID"]}/batch`, { records: [{ ...rec, contentHash: "h2" }] }, { agent: "test-agent" });
  check("changed original is updated, not duplicated", changed.body.results?.[0]?.outcome === "updated");
  const afterChange = (await call("GET", `/knowledge/${kn["Knowledge ID"]}`)).body.entry;
  check("verified knowledge citing a changed source is flagged (disputed)", afterChange["Review Status"] === "disputed", afterChange["Review Status"]);
  const deleted = await call("POST", `/jobs/${job["Job ID"]}/batch`, { records: [{ system: "google-drive", originalId: rec.originalId, deleted: true }], done: true }, { agent: "test-agent" });
  const srcAfter = (await call("GET", `/sources/${SID}`)).body.source;
  check("deleted original is marked, excerpt removed, record kept for provenance", deleted.body.results?.[0]?.outcome === "updated" && srcAfter["Processing Status"] === "source-deleted" && !srcAfter.Excerpt);
  const jobAfter = (await call("GET", `/jobs/${job["Job ID"]}`)).body.job;
  check("job counters and completion are tracked", jobAfter.Status === "completed" && +jobAfter["Items Skipped"] >= 1 && +jobAfter["Items Processed"] >= 3, `${jobAfter.Status} p=${jobAfter["Items Processed"]} s=${jobAfter["Items Skipped"]}`);
  const tooBig = await call("POST", `/jobs/${job["Job ID"]}/batch`, { records: Array.from({ length: 26 }, (_, i) => ({ ...rec, originalId: "x" + i })) });
  check("batches over 25 records are refused", tooBig.status === 400 || tooBig.status === 409);
  const gmailNoQuery = await call("POST", "/jobs", { connector: "gmail", title: "whole mailbox" });
  check("Gmail job without a restricted query is refused", gmailNoQuery.status === 400);

  // ── server-pull connector: GitHub public repo (bounded to one page of 5) ──
  const gh = (await call("POST", "/jobs", { connector: "github", title: `TEST github ${stamp}`, scope: { repo: "kineticdata/kinetic-sdk-rb", maxPages: 1 }, batchSize: 5, subjectType: "company", subjectId: CO })).body.job;
  created.jobIds.push(gh["Job ID"]);
  const run = await call("POST", `/jobs/${gh["Job ID"]}/run`);
  let ghJob;
  for (let i = 0; i < 30; i++) { await sleep(3000); ghJob = (await call("GET", `/jobs/${gh["Job ID"]}`)).body.job; if (["completed", "failed", "paused"].includes(ghJob.Status)) break; }
  check("GitHub pull job runs in the background and completes", run.status === 202 && ghJob.Status === "completed" && +ghJob["Items Processed"] === 5, `${ghJob.Status} processed=${ghJob["Items Processed"]} errors=${ghJob.Errors}`);
  const gh2 = (await call("POST", "/jobs", { connector: "github", title: `TEST github again ${stamp}`, scope: { repo: "kineticdata/kinetic-sdk-rb", maxPages: 1 }, batchSize: 5, subjectType: "company", subjectId: CO })).body.job;
  created.jobIds.push(gh2["Job ID"]);
  await call("POST", `/jobs/${gh2["Job ID"]}/run`);
  for (let i = 0; i < 30; i++) { await sleep(3000); ghJob = (await call("GET", `/jobs/${gh2["Job ID"]}`)).body.job; if (["completed", "failed"].includes(ghJob.Status)) break; }
  check("a second job over the same scope skips already-ingested records", ghJob.Status === "completed" && +ghJob["Items Skipped"] === 5 && +ghJob["Items Processed"] === 0, `skipped=${ghJob["Items Skipped"]} processed=${ghJob["Items Processed"]}`);
  const again = await call("POST", `/jobs/${gh["Job ID"]}/retry`);
  check("a completed job can be re-queued (resumes from its checkpoint)", again.status === 200 && again.body.job.Status === "queued");

  // ── notes & historian ──
  const note = await call("POST", "/notes", { title: `TEST recollection ${stamp}`, content: "I remember the first call was in spring.", companyId: CO, recalledBy: "test-person" });
  if (note.body.job) created.jobIds.push(note.body.job);   // each note gets its own manual job
  check("interview note becomes a source + proposed recollection", note.status === 201 && note.body.knowledge?.["Knowledge Type"] === "recollection");
  const ask = await call("POST", "/historian/ask", { question: `Tell me everything we know about TEST Corp ${stamp}`, narrative: false });
  const allCites = ask.body.sections?.flatMap(s => s.items).every(i => i.citations?.length > 0);
  check("historian finds the subject and every finding carries citations", ask.body.subject?.id === CO && allCites);
  check("historian separates verified from unverified", ask.body.sections?.some(s => /Unverified/.test(s.title)));
  const search = await call("GET", `/search?q=${encodeURIComponent("TEST Corp " + stamp)}&types=company`);
  check("search by company name", search.body.hits?.some(h => h.id === CO));
  const sdate = await call("GET", `/search?types=event&companyId=${CO}&from=2019&to=2020`);
  check("search with company + date range filters", sdate.status === 200 && sdate.body.hits.every(h => h.date >= "2019" && h.date <= "2020-99"));

  // ── permissions with real non-admin users ──
  const pw = crypto.randomBytes(12).toString("base64url") + "a1!";
  for (const [u, team] of [[`cb-test-member-${stamp}`.toLowerCase(), "Corporate Brain::Members"], [`cb-test-outsider-${stamp}`.toLowerCase(), null]]) {
    const r = await kineticRequest("POST", "/users", { username: u, displayName: u, email: `${u}@example.invalid`, password: pw, enabled: true, spaceAdmin: false }, ADMIN);
    if (r.status < 300) created.users.push(u);
    if (team) await kineticRequest("POST", "/memberships", { team: { name: team }, user: { username: u } }, ADMIN);
  }
  const [MEMBER, OUTSIDER] = created.users;
  const outsiderStats = await call("GET", "/stats", null, { auth: basic(OUTSIDER, pw) });
  check("non-members are refused by the app", outsiderStats.status === 403);
  const outsiderCore = await kineticRequest("GET", `/kapps/corporate-brain/forms/companies/submissions?limit=5&include=values`, null, basic(OUTSIDER, pw));
  check("non-members are refused by Kinetic itself (direct Core API)", outsiderCore.status >= 400 || (outsiderCore.data.submissions || []).length === 0, `status ${outsiderCore.status}, ${(outsiderCore.data.submissions || []).length} rows`);
  const memberStats = await call("GET", "/stats", null, { auth: basic(MEMBER, pw) });
  check("members can use the app", memberStats.status === 200, `status ${memberStats.status} ${JSON.stringify(memberStats.body ?? "").slice(0, 200)}`);
  // Kinetic refuses a query when 10+ matching rows fail Submission Access; members' source queries must be scoped
  const memberGmail = await call("GET", "/entities/sources?system=gmail", null, { auth: basic(MEMBER, pw) });
  check("members can list sources even when many are restricted", memberGmail.status === 200 && memberGmail.body.items.every(x => x["Access Scope"] !== "restricted"), `status ${memberGmail.status}`);
  const restricted = await call("POST", "/notes", { title: `TEST restricted ${stamp}`, content: "sensitive", companyId: CO, restricted: true, propose: false });
  if (restricted.body.job) created.jobIds.push(restricted.body.job);
  const memberSees = await call("GET", `/sources/${restricted.body.sourceId}`, null, { auth: basic(MEMBER, pw) });
  check("restricted sources are hidden from non-reviewers (Kinetic policy)", memberSees.status === 404, `status ${memberSees.status}`);
  const memberReview = await call("POST", `/knowledge/${note.body.knowledge["Knowledge ID"]}/review`, { action: "approve" }, { auth: basic(MEMBER, pw) });
  check("members cannot approve knowledge", memberReview.status === 403);
  const memberResearch = await call("POST", `/knowledge/${note.body.knowledge["Knowledge ID"]}/review`, { action: "research", comment: "who else was there?" }, { auth: basic(MEMBER, pw) });
  check("members can request further research (tracked as a research job)", memberResearch.status === 200 && memberResearch.body.requested === true, `status ${memberResearch.status} ${memberResearch.body.error || ""}`);
  if (memberResearch.body.job) created.jobIds.push(memberResearch.body.job["Job ID"]);
  const memberDirect = await kineticRequest("PUT", `/submissions/${kn._id}`, { values: { "Review Status": "verified" } }, basic(MEMBER, pw));
  check("members cannot change reviewed knowledge through the Core API", memberDirect.status === 403 || memberDirect.status === 401, `status ${memberDirect.status}`);
  const memberAudit = await kineticRequest("GET", `/kapps/corporate-brain/forms/audit-log/submissions?limit=1&include=values`, null, basic(MEMBER, pw));
  const auditRow = memberAudit.data.submissions?.[0];
  if (auditRow) {
    const tamper = await kineticRequest("PUT", `/submissions/${auditRow.id}`, { values: { Comment: "tampered" } }, basic(MEMBER, pw));
    check("audit log is append-only for members", tamper.status === 403 || tamper.status === 401, `status ${tamper.status}`);
  }

  // ── sales lens ──
  const mkSales = async (kind, values, sourceIds, auth = ADMIN) => {
    const r = await call("POST", `/sales/${kind}`, { values, sourceIds }, { auth });
    const form = { deal: "deals", principle: "sales-principles", objection: "sales-objections" }[kind];
    const idField = { deal: "Deal ID", principle: "Principle ID", objection: "Objection ID" }[kind];
    if (r.body?.item) created.sales.push([form, idField, r.body.item[idField], r.body.knowledge?.["Knowledge ID"]]);
    return r;
  };
  const d1 = await mkSales("deal", { Title: `TEST deal one ${stamp}`, "Company ID": CO, "Deal Date": "2010-05", Outcome: "walked-away", "Outcome Reason": "Would not change the support model" }, [SID]);
  check("a sales record is created with a proposed review entry (Lens sales)", d1.status === 201 && d1.body.item["Verification Status"] === "proposed" && d1.body.knowledge?.Lens === "sales" && d1.body.knowledge?.["Subject Type"] === "deal" && d1.body.knowledge?.["Knowledge ID"] === d1.body.item["Knowledge ID"], `status ${d1.status} ${d1.body.error || ""}`);
  check("the review entry states the deal's outcome and reason", /Outcome: walked-away/.test(d1.body.knowledge?.Statement || "") && /support model/.test(d1.body.knowledge?.Statement || ""));
  const badSrc = await mkSales("deal", { Title: `TEST deal bad source ${stamp}` }, ["SR-DOESNOTEXIST0000000"]);
  check("a sales record citing a missing source creates nothing", badSrc.status === 400 && !badSrc.body.item);
  const d2 = await mkSales("deal", { Title: `TEST deal two ${stamp}`, "Company ID": CO, Outcome: "won" }, [SID]);
  const D1 = d1.body.item["Deal ID"], D2 = d2.body.item["Deal ID"];
  const p1 = await mkSales("principle", { Title: `TEST principle ${stamp}`, Statement: "We would rather walk than change the support model", "Deal IDs": D1 }, [SID]);
  const P = p1.body.item, PK = p1.body.knowledge?.["Knowledge ID"];
  check("principle created with its deal list stored as a JSON list", p1.status === 201 && JSON.parse(P["Deal IDs"]).length === 1, `status ${p1.status} ${p1.body.error || ""}`);
  const early = await call("POST", `/knowledge/${PK}/review`, { action: "approve" });
  check("a principle with one deal cannot be verified (needs 2)", early.status === 400 && /at least 2 linked deals/.test(early.body.error || ""), `status ${early.status} ${early.body.error || ""}`);
  const edit = await call("PUT", `/entities/sales-principles/${P._id}`, { values: { "Deal IDs": `${D1}, ${D2}` } });
  check("editing the deal list normalizes it", edit.status === 200 && JSON.parse(edit.body.item["Deal IDs"]).length === 2, `status ${edit.status}`);
  const pkAfter = (await call("GET", `/knowledge/${PK}`)).body.entry;
  check("an edit while under review refreshes the review entry's statement", (pkAfter?.Statement || "").includes(D2));
  const agentOk = await call("POST", `/knowledge/${PK}/review`, { action: "approve" }, { agent: "test-agent" });
  check("an agent cannot verify a sales principle", agentOk.status === 400 || agentOk.status === 403);
  const ok2 = await call("POST", `/knowledge/${PK}/review`, { action: "approve", comment: "test" });
  const pDetail = await call("GET", `/sales/principle/${P["Principle ID"]}`);
  check("with two deals a reviewer can verify; the principle's status follows", ok2.status === 200 && pDetail.body.item?.["Verification Status"] === "verified" && pDetail.body.deals.length === 2, `status ${ok2.status} ${ok2.body.error || ""}`);
  const dDetail = await call("GET", `/sales/deal/${D1}`);
  check("a deal shows the principles that cite it", dDetail.status === 200 && dDetail.body.principles.some(x => x["Principle ID"] === P["Principle ID"]));
  const queue = await call("GET", `/review-queue?lens=sales&status=proposed`);
  check("the sales review queue lists only sales entries", queue.status === 200 && queue.body.items.length > 0 && queue.body.items.every(k => k.Lens === "sales"));
  const listed = await call("GET", `/entities/deals?status=proposed&outcome=won`);
  check("deals filter by status + outcome", listed.status === 200 && listed.body.items.every(x => x.Outcome === "won" && x["Verification Status"] === "proposed") && listed.body.items.some(x => x["Deal ID"] === D2), `status ${listed.status} ${listed.body.error || ""}`);
  const sum = await call("GET", `/sales/summary?fresh=1`);
  check("sales summary counts each record type", sum.status === 200 && Object.keys(sum.body.kinds).length === 6 && sum.body.pricing === true);
  const tl = await call("GET", `/sales/pricing-timeline`);
  check("pricing timeline responds", tl.status === 200 && Array.isArray(tl.body.items));
  const genericPricing = await call("GET", `/entities/deal-pricing`);
  check("deal pricing is not reachable through the generic entity API", genericPricing.status === 404);
  const price = await call("POST", `/sales/deal/${D1}/pricing`, { values: { "Quoted Price": "50000", "Final Price": "42000", Currency: "USD", Discount: "16%" } });
  const withPrice = await call("GET", `/sales/deal/${D1}`);
  check("a reviewer records and sees deal prices", price.status === 200 && withPrice.body.pricing?.[0]?.["Final Price"] === "42000", `status ${price.status} ${price.body.error || ""}`);
  const auditPrice = await kineticRequest("GET", `/kapps/corporate-brain/forms/audit-log/submissions?limit=5&include=values&q=${encodeURIComponent(`values[Entity ID] = "${price.body.item?.["Deal Pricing ID"]}"`)}`, null, ADMIN);
  check("prices are not copied into the (member-readable) audit log", (auditPrice.data.submissions || []).length > 0 && (auditPrice.data.submissions || []).every(a => !/42000|50000/.test(a.values.Details || "")));
  // pricing visibility: a plain member vs a member of Corporate Brain::Sales
  const salesUser = `cb-test-sales-${stamp}`.toLowerCase();
  if ((await kineticRequest("POST", "/users", { username: salesUser, displayName: salesUser, email: `${salesUser}@example.invalid`, password: pw, enabled: true, spaceAdmin: false }, ADMIN)).status < 300) created.users.push(salesUser);
  for (const team of ["Corporate Brain::Members", "Corporate Brain::Sales"]) await kineticRequest("POST", "/memberships", { team: { name: team }, user: { username: salesUser } }, ADMIN);
  const mDeal = await call("GET", `/sales/deal/${D1}`, null, { auth: basic(MEMBER, pw) });
  check("a member without a pricing team sees the deal but not its prices", mDeal.status === 200 && mDeal.body.canSeePricing === false && !mDeal.body.pricing, `status ${mDeal.status}`);
  const mPost = await call("POST", `/sales/deal/${D1}/pricing`, { values: { "Final Price": "1" } }, { auth: basic(MEMBER, pw) });
  check("a member without a pricing team cannot record prices", mPost.status === 403);
  const mCore = await kineticRequest("GET", `/kapps/corporate-brain/forms/deal-pricing/submissions?limit=5&include=values&q=${encodeURIComponent(`values[Deal ID] = "${D1}"`)}`, null, basic(MEMBER, pw));
  check("Kinetic itself hides deal prices from a plain member (direct Core API)", mCore.status >= 400 || (mCore.data.submissions || []).length === 0, `status ${mCore.status}, ${(mCore.data.submissions || []).length} rows`);
  const sDeal = await call("GET", `/sales/deal/${D1}`, null, { auth: basic(salesUser, pw) });
  check("a member of Corporate Brain::Sales sees deal prices", sDeal.status === 200 && sDeal.body.canSeePricing === true && sDeal.body.pricing?.[0]?.["Final Price"] === "42000", `status ${sDeal.status} ${sDeal.body.error || ""}`);
  const mEdit = await call("PUT", `/entities/sales-principles/${P._id}`, { values: { Statement: "changed" } }, { auth: basic(MEMBER, pw) });
  check("members cannot change a verified sales principle", mEdit.status === 403, `status ${mEdit.status}`);
  const mEditCore = await kineticRequest("PUT", `/submissions/${P._id}`, { values: { Statement: "changed" } }, basic(MEMBER, pw));
  check("…nor through the Core API (CB Sales Modification)", mEditCore.status === 403 || mEditCore.status === 401, `status ${mEditCore.status}`);
  const mObj = await mkSales("objection", { Title: `TEST objection ${stamp}`, Objection: "Renewal pricing is shocking", Category: "renewal" }, [], basic(MEMBER, pw));
  const mObjEdit = mObj.body.item ? await kineticRequest("PUT", `/submissions/${mObj.body.item._id}`, { values: { Responses: "Showed the 3-year plan" } }, basic(MEMBER, pw)) : { status: 0 };
  check("members can propose and edit their own sales records while under review", mObj.status === 201 && mObjEdit.status < 300, `create ${mObj.status} ${mObj.body.error || ""}, edit ${mObjEdit.status}`);
} catch (e) {
  fail++; console.log("✗ unexpected error:", e.stack || e.message);
} finally {
  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed (test data and users removed)`);
  process.exitCode = fail ? 1 : 0;
}
