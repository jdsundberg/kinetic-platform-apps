/**
 * MfgDream — installer for the extension forms only (Quality/Shipping/Finance/EngChange).
 * Creates the 6 new forms, builds indexes, seeds from seed-data-ext.json.
 * Idempotent for forms/indexes; seeding is NOT idempotent — run once.
 */
import fs from "node:fs";
import https from "node:https";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const __dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = process.env.KINETIC_URL || "https://first.kinetics.com";
const AUTH = "Basic " + Buffer.from(`${process.env.KINETIC_USER || "john"}:${process.env.KINETIC_PASS || "john1"}`).toString("base64");
const NEW_FORMS = ["inspections", "nonconformances", "corrective-actions", "shipments", "invoices", "engineering-changes"];
const DO_SEED = process.argv.includes("--seed");

function req(method, apiPath, body) {
  return new Promise((resolve) => {
    const url = new URL(SERVER + "/app/api/v1" + apiPath);
    const r = https.request({ method, hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, headers: { Authorization: AUTH, "Content-Type": "application/json" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let data = {}; try { data = d ? JSON.parse(d) : {}; } catch { data = { raw: d }; } resolve({ status: res.statusCode, data }); });
    });
    r.on("error", (e) => resolve({ status: 0, data: { error: e.message } }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const log = (m) => console.log(m);
const SYS_IDX = [
  { name: "closedBy", parts: ["closedBy"], unique: false }, { name: "createdBy", parts: ["createdBy"], unique: false },
  { name: "handle", parts: ["handle"], unique: true }, { name: "submittedBy", parts: ["submittedBy"], unique: false },
  { name: "updatedBy", parts: ["updatedBy"], unique: false },
];
function buildPages(fields) {
  const elements = fields.map((f) => ({ type: "field", name: f.name, label: f.name, key: crypto.randomBytes(16).toString("hex"), dataType: "string", renderType: "text", enabled: true, visible: true, required: f.required || false, rows: f.rows || 1, constraints: [], events: [], renderAttributes: {}, defaultDataSource: "none", defaultValue: "", defaultResourceName: "", requiredMessage: "", omitWhenHidden: null, pattern: null }));
  elements.push({ type: "button", name: "Submit Button", label: "Submit", renderType: "submit-page", visible: true, enabled: true, renderAttributes: {} });
  return [{ name: "Page 1", type: "page", renderType: "submittable", elements, events: [] }];
}

async function main() {
  const appDef = JSON.parse(fs.readFileSync(path.join(__dir, "app.json"), "utf-8"));
  const forms = appDef.forms.filter((f) => NEW_FORMS.includes(f.slug));
  const kapp = appDef.slug;
  log(`\n=== Installing ${forms.length} extension forms on ${kapp} @ ${SERVER} ===\n`);

  for (const form of forms) {
    const fb = { slug: form.slug, name: form.name, status: "Active", pages: buildPages(form.fields), description: form.description, submissionLabelExpression: form.submissionLabelExpression };
    const r = await req("POST", `/kapps/${kapp}/forms`, fb);
    if (r.status < 300) log(`✓ Created form ${form.slug} (${form.fields.length} fields)`);
    else if (r.data?.errorKey === "uniqueness_violation") log(`• Form ${form.slug} already exists`);
    else log(`✗ FAILED form ${form.slug}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  for (const form of forms) {
    if (!form.indexes) continue;
    const idxDefs = [...SYS_IDX], custom = [];
    for (const p of (form.indexes.single || [])) { idxDefs.push({ parts: [p], unique: false }); custom.push(p); }
    for (const ps of (form.indexes.compound || [])) { idxDefs.push({ parts: ps, unique: false }); custom.push(ps.join(",")); }
    if (!custom.length) continue;
    log(`… Building ${custom.length} indexes on ${form.slug}`);
    const pr = await req("PUT", `/kapps/${kapp}/forms/${form.slug}`, { indexDefinitions: idxDefs });
    if (pr.status >= 300) { log(`  ✗ index PUT failed: ${pr.status} ${JSON.stringify(pr.data).slice(0, 200)}`); continue; }
    await req("POST", `/kapps/${kapp}/forms/${form.slug}/backgroundJobs`, { type: "Build Index", content: { indexes: custom } });
    for (let w = 0; w < 15; w++) {
      await new Promise((r) => setTimeout(r, 2000));
      const check = await req("GET", `/kapps/${kapp}/forms/${form.slug}?include=indexDefinitions`);
      const defs = (check.data?.form || check.data)?.indexDefinitions || [];
      if (!defs.filter((d) => d.status === "New" && custom.includes(d.parts.join(","))).length) break;
    }
    log(`  ✓ Indexes built on ${form.slug}`);
  }

  if (DO_SEED) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dir, "seed-data-ext.json"), "utf-8"));
    for (const slug of NEW_FORMS) {
      const records = seed[slug] || [];
      let ok = 0, fail = 0, firstErr = "";
      for (let i = 0; i < records.length; i += 10) {
        const results = await Promise.allSettled(records.slice(i, i + 10).map((values) => req("POST", `/kapps/${kapp}/forms/${slug}/submissions`, { values, coreState: "Submitted" })));
        for (const r of results) { if (r.status === "fulfilled" && r.value.status < 300) ok++; else { fail++; if (!firstErr) firstErr = r.status === "fulfilled" ? `${r.value.status} ${JSON.stringify(r.value.data).slice(0, 160)}` : String(r.reason); } }
      }
      log(`✓ Seeded ${slug}: ${ok}/${records.length}${fail ? ` (${fail} failed — ${firstErr})` : ""}`);
    }
  }
  log(`\n=== Done ===\n`);
}
main();
