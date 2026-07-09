/**
 * install.mjs — provision the Summit Ridge Roofing app on a Kinetic space.
 * Creates kapp, forms (with pages), search indexes (build + poll), and seeds data.
 *
 * Usage: node install.mjs <serverUrl> <user> <pass> [--seed] [--no-build-wait]
 * Pure Node.js built-ins. Mirrors admin_apps/app_manager install flow.
 */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const [, , SERVER, USER, PASS, ...flags] = process.argv;
if (!SERVER || !USER || !PASS) { console.error("Usage: node install.mjs <serverUrl> <user> <pass> [--seed]"); process.exit(1); }
const DO_SEED = flags.includes("--seed");
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const DIR = path.dirname(new URL(import.meta.url).pathname);
const appDef = JSON.parse(fs.readFileSync(path.join(DIR, "app.json"), "utf-8"));

const SYSTEM_INDEXES = [
  { name: "closedBy", parts: ["closedBy"], unique: false },
  { name: "createdBy", parts: ["createdBy"], unique: false },
  { name: "handle", parts: ["handle"], unique: true },
  { name: "submittedBy", parts: ["submittedBy"], unique: false },
  { name: "updatedBy", parts: ["updatedBy"], unique: false },
];

function buildPages(fields) {
  const elements = fields.map(f => ({
    type: "field", name: f.name, label: f.name,
    key: crypto.randomBytes(16).toString("hex"),
    dataType: "string", renderType: "text",
    enabled: true, visible: true,
    required: f.required || false, rows: f.rows || 1,
    constraints: [], events: [], renderAttributes: {},
    defaultDataSource: "none", defaultValue: "", defaultResourceName: "",
    requiredMessage: "", omitWhenHidden: null, pattern: null,
  }));
  elements.push({ type: "button", name: "Submit Button", label: "Submit", renderType: "submit-page", visible: true, enabled: true, renderAttributes: {} });
  return [{ name: "Page 1", type: "page", renderType: "submittable", elements, events: [] }];
}

function req(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${SERVER.replace(/\/+$/, "")}/app/api/v1${apiPath}`);
    const lib = u.protocol === "https:" ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const r = lib.request(u, {
      method, headers: { "Authorization": AUTH, "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let buf = ""; res.on("data", c => buf += c);
      res.on("end", () => { let j = null; try { j = buf ? JSON.parse(buf) : null; } catch {} resolve({ status: res.statusCode, data: j, raw: buf }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const kappSlug = appDef.slug;
  console.log(`\n→ Installing "${appDef.name}" (${kappSlug}) on ${SERVER}\n`);

  // 1. Kapp
  let r = await req("POST", "/kapps", { name: appDef.name, slug: kappSlug, status: "Active" });
  if (r.status < 300) console.log(`  ✓ kapp created: ${kappSlug}`);
  else if (r.data?.errorKey === "uniqueness_violation" || r.status === 409) console.log(`  • kapp ${kappSlug} already exists`);
  else { console.error(`  ✗ kapp failed: ${r.status} ${r.raw}`); process.exit(1); }

  // 2. Forms
  for (const form of appDef.forms) {
    const fb = { slug: form.slug, name: form.name, status: "Active", pages: buildPages(form.fields) };
    if (form.description) fb.description = form.description;
    if (form.submissionLabelExpression) fb.submissionLabelExpression = form.submissionLabelExpression;
    r = await req("POST", `/kapps/${kappSlug}/forms`, fb);
    if (r.status < 300) console.log(`  ✓ form: ${form.slug} (${form.fields.length} fields)`);
    else if (r.data?.errorKey === "uniqueness_violation") console.log(`  • form ${form.slug} already exists`);
    else console.log(`  ✗ form ${form.slug}: ${r.status} ${r.raw?.slice(0, 200)}`);
  }

  // 3. Indexes
  const buildJobs = []; // {form, indexes:[...]}
  for (const form of appDef.forms.filter(f => f.indexes)) {
    const defs = [...SYSTEM_INDEXES]; const custom = [];
    for (const p of (form.indexes.single || [])) { defs.push({ parts: [p], unique: false }); custom.push(p); }
    for (const parts of (form.indexes.compound || [])) { defs.push({ parts, unique: false }); custom.push(parts.join(",")); }
    r = await req("PUT", `/kapps/${kappSlug}/forms/${form.slug}`, { indexDefinitions: defs });
    if (r.status >= 300) { console.log(`  ✗ index defs ${form.slug}: ${r.status} ${r.raw?.slice(0,150)}`); continue; }
    if (custom.length) {
      r = await req("POST", `/kapps/${kappSlug}/forms/${form.slug}/backgroundJobs`, { type: "Build Index", content: { indexes: custom } });
      buildJobs.push({ form: form.slug, count: custom.length });
    }
    console.log(`  ✓ indexes: ${form.slug} (${custom.length} custom)`);
  }

  // 4. Poll index builds
  if (buildJobs.length && !flags.includes("--no-build-wait")) {
    process.stdout.write("  … waiting for index builds ");
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      let pending = 0;
      for (const j of buildJobs) {
        const jr = await req("GET", `/kapps/${kappSlug}/forms/${j.form}/backgroundJobs`, null);
        const jobs = jr.data?.backgroundJobs || [];
        if (jobs.some(x => x.status === "New" || x.status === "Running")) pending++;
      }
      process.stdout.write(".");
      if (pending === 0) break;
    }
    console.log(" done");
  }

  // 5. Seed
  if (DO_SEED) {
    const seedPath = path.join(DIR, "seed-data.json");
    if (!fs.existsSync(seedPath)) { console.log("  • no seed-data.json"); }
    else {
      const seed = JSON.parse(fs.readFileSync(seedPath, "utf-8"));
      for (const [formSlug, records] of Object.entries(seed)) {
        let ok = 0;
        for (let i = 0; i < records.length; i += 10) {
          const batch = records.slice(i, i + 10);
          const results = await Promise.allSettled(batch.map(values => req("POST", `/kapps/${kappSlug}/forms/${formSlug}/submissions`, { values, coreState: "Submitted" })));
          ok += results.filter(x => x.status === "fulfilled" && x.value.status < 300).length;
          const fail = results.find(x => x.status === "fulfilled" && x.value.status >= 300);
          if (fail) console.log(`    ⚠ ${formSlug} sample error: ${fail.value.status} ${fail.value.raw?.slice(0,160)}`);
        }
        console.log(`  ✓ seeded ${formSlug}: ${ok}/${records.length}`);
      }
    }
  }

  console.log(`\n✓ Done. App at: ${SERVER}/  (kapp: ${kappSlug})\n`);
}
main().catch(e => { console.error(e); process.exit(1); });
