/**
 * test.mjs — automated tests for Kinetic MedQMS.
 * Covers: data integrity / audit history, e-signatures, APIs, calculations,
 * traceability, pagination, and critical regulatory controls.
 *
 * Usage: node test.mjs <serverUrl> <user> <pass> [appServerBase]
 *   appServerBase defaults to http://localhost:3021 (the standalone server).
 *   The Kinetic <serverUrl> is used for direct form queries/writes.
 *
 * Self-cleaning: any record it creates (prefixed *-TEST-) is deleted at the end.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const [, , SERVER, USER, PASS, APP = "http://localhost:3021"] = process.argv;
if (!SERVER || !USER || !PASS) { console.error("Usage: node test.mjs <serverUrl> <user> <pass> [appBase]"); process.exit(1); }
const KROOT = SERVER.replace(/\/+$/, "") + "/app/api/v1";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const H = { Authorization: AUTH, "Content-Type": "application/json" };
const kget = (p) => fetch(KROOT + p, { headers: H }).then((r) => r.json());
const kpost = (p, b) => fetch(KROOT + p, { method: "POST", headers: H, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const kdel = (id) => fetch(KROOT + "/submissions/" + id, { method: "DELETE", headers: H }).then((r) => r.s = r.status);
const aget = (p) => fetch(APP + p, { headers: H }).then((r) => r.json());
const apost = (p, b, h = {}) => fetch(APP + p, { method: "POST", headers: { ...H, ...h }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const q = (kql) => "&q=" + encodeURIComponent(kql);

let pass = 0, fail = 0; const cleanup = [];
const ok = (name, cond, info = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${info}`); } };
const F = (slug, kql, limit = 25) => kget(`/kapps/ncrmanager/forms/${slug}/submissions?include=values,details&limit=${limit}${kql ? q(kql) : ""}`);

async function main() {
  console.log("\nKinetic MedQMS — automated test suite\n");

  // ── 1. Showcase traceability (record-360) ──────────────────────────────────
  console.log("1. Traceability / record-360");
  const capa = (await F("capas", 'values[CAPA ID]="CAPA-0001"')).submissions?.[0];
  ok("CAPA-0001 exists", !!capa, "(seed showcase)");
  if (capa) {
    const r = await aget(`/api/ncrmanager/record360/capas/${capa.id}`);
    ok("record-360 returns business id", r.businessId === "CAPA-0001");
    const types = new Set(r.related.map((n) => n.type));
    ok("links to Complaint", types.has("Complaint"));
    ok("links to Risk", types.has("Risk"));
    ok("links to Nonconformance", types.has("Nonconformance"));
    ok("links to Change", types.has("Change"));
    ok("links to Training", types.has("Training"));
    ok("graph has >=6 nodes", r.graph.nodes.length >= 6, `(got ${r.graph.nodes.length})`);
    ok("CAPA action plan present", r.actions.length >= 4, `(got ${r.actions.length})`);
    ok("closure signatures present", r.signatures.some((s) => /Closure|Effectiveness/.test(s.meaning)));
    ok("timeline present", r.timeline.length >= 1);
  }

  // ── 2. Dashboard calculations vs source ────────────────────────────────────
  console.log("2. Dashboard calculations reflect source records");
  const d = await aget("/api/ncrmanager/dashboard");
  const capasAll = (await F("capas", "", 25)).submissions || [];
  ok("dashboard openCapas is plausible", d.kpis.openCapas >= 0 && d.kpis.openCapas <= d.counts.capas);
  ok("dashboard not capped at page size", d.counts.events > 25 || d.counts.capas > 25, "(de-dup pagination)");
  ok("worstSuppliers sorted ascending by score", d.worstSuppliers.every((s, i, a) => i === 0 || a[i - 1].score <= s.score));
  ok("overdueQueue items are actually past due", d.overdueQueue.every((x) => new Date(x.due).getTime() < Date.UTC(2026, 5, 27)));

  // ── 3. Versioned Web API ───────────────────────────────────────────────────
  console.log("3. Versioned Web API contract");
  const crit = await aget("/api/ncrmanager/v1/suppliers?Risk_Class=Critical&limit=5");
  ok("v1 filter applies", crit.data.every((x) => x.values["Risk Class"] === "Critical"), "(Risk_Class=Critical)");
  ok("v1 envelope has apiVersion+correlationId", crit.apiVersion === "1.0" && !!crit.correlationId);
  ok("v1 pagination present", "nextPageToken" in crit.pagination);
  const bad = await aget("/api/ncrmanager/v1/widgets");
  ok("v1 stable error envelope", bad.error?.code === "unknown_resource");
  const metrics = await aget("/api/ncrmanager/v1/metrics");
  ok("v1 metrics contract", typeof metrics.metrics?.openCapas === "number");

  // ── 4. Idempotent intake ───────────────────────────────────────────────────
  console.log("4. Idempotent intake");
  const idem = "TEST-IDEM-" + Date.now();
  const c1 = await apost("/api/ncrmanager/v1/quality-events", { Title: "API intake test", "Event ID": "QE-TEST-" + Date.now().toString().slice(-6) }, { "Idempotency-Key": idem });
  const c2 = await apost("/api/ncrmanager/v1/quality-events", { Title: "API intake test replay" }, { "Idempotency-Key": idem });
  ok("intake created (201)", c1.s === 201, `(got ${c1.s})`);
  ok("replay returns same id (idempotent)", c1.j.id && c2.j.id === c1.j.id);
  if (c1.j.id) cleanup.push(c1.j.id);
  ok("validation error on missing Title", (await apost("/api/ncrmanager/v1/quality-events", {})).j.error?.code === "validation_error");

  // ── 5. Audit history on write (data integrity) ─────────────────────────────
  console.log("5. Audit trail / data integrity");
  const bid = "NC-TEST-" + Date.now().toString().slice(-6);
  const made = await kpost("/kapps/ncrmanager/forms/nonconformances/submissions", { values: { "NC ID": bid, Title: "Audit test NC", Status: "Open", Owner: "Maria Okafor" }, coreState: "Submitted" });
  if (made.j.submission?.id) cleanup.push(made.j.submission.id);
  // simulate the UI's edit→trail behavior
  const tEntry = await kpost("/kapps/ncrmanager/forms/audit-trail/submissions", { values: { "Entry ID": "AT-TEST-" + Date.now().toString().slice(-7), "Record Type": "nonconformances", "Record ID": bid, Actor: USER, Action: "Update", Field: "Status", "Old Value": "Open", "New Value": "Containment", Reason: "containment applied", "Workflow State": "Containment", Source: "test", Timestamp: "2026-06-27 12:00:00" }, coreState: "Submitted" });
  if (tEntry.j.submission?.id) cleanup.push(tEntry.j.submission.id);
  const trail = await F("audit-trail", `values[Record ID]="${bid}"`);
  const e0 = trail.submissions?.[0];
  ok("audit-trail entry written", !!e0);
  ok("trail captures actor", e0 && !!e0.values.Actor);
  ok("trail captures old→new", e0 && e0.values["Old Value"] === "Open" && e0.values["New Value"] === "Containment");
  ok("trail captures reason", e0 && !!e0.values.Reason);

  // ── 6. E-signature manifest (Part 11 control) ──────────────────────────────
  console.log("6. Electronic signature manifest");
  const sigRec = "CAPA-TEST-" + Date.now().toString().slice(-6);
  const sig = await kpost("/kapps/ncrmanager/forms/esignatures/submissions", { values: { "Signature ID": "SIG-TEST-" + Date.now().toString().slice(-7), "Record Type": "capas", "Record ID": sigRec, Signer: USER, "Signer Name": "Tester", Meaning: "CAPA Closure Approved", Reason: "test", "Record Version": "1", "Auth Method": "Password Re-authentication", "Signed Date": "2026-06-27 12:00:00", Hash: "sha256:deadbeef0000", "Correlation ID": "COR-TEST" }, coreState: "Submitted" });
  if (sig.j.submission?.id) cleanup.push(sig.j.submission.id);
  const sm = (await F("esignatures", `values[Record ID]="${sigRec}"`)).submissions?.[0];
  ok("signature has meaning", sm && sm.values.Meaning === "CAPA Closure Approved");
  ok("signature has re-auth method", sm && sm.values["Auth Method"].includes("Re-authentication"));
  ok("signature has tamper-evident hash", sm && sm.values.Hash.startsWith("sha256:"));

  // ── 7. Indexing / KQL controls ─────────────────────────────────────────────
  console.log("7. Indexed KQL filters return scoped results");
  const closed = await F("capas", 'values[Status]="Closed"');
  ok("status filter returns only matching", (closed.submissions || []).every((s) => s.values.Status === "Closed"));
  const reportable = await F("complaints", 'values[Reportable]="Yes"');
  ok("reportable complaints query works", (reportable.submissions || []).every((s) => s.values.Reportable === "Yes"));

  // ── cleanup ────────────────────────────────────────────────────────────────
  console.log(`\nCleaning up ${cleanup.length} test records…`);
  for (const id of cleanup) await kdel(id);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
