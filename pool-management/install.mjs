/**
 * Pool Management — standalone installer.
 * create kapp -> forms (with pages) -> build & poll indexes -> seed (with retry).
 * Usage: node install.mjs [--seed]
 */
import fs from "node:fs";
import https from "node:https";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const __dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = process.env.KINETIC_URL || "https://ai-labs.kinopsdev.io";
const USER = process.env.KINETIC_USER || "john";
const PASS = process.env.KINETIC_PASS || "john1";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const DO_SEED = process.argv.includes("--seed");

function kineticRequest(method, apiPath, body) {
  return new Promise((resolve) => {
    const url = new URL(SERVER + "/app/api/v1" + apiPath);
    const opts = { method, hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search,
      headers: { Authorization: AUTH, "Content-Type": "application/json" } };
    const r = https.request(opts, (res) => {
      let d = ""; res.on("data", c => (d += c));
      res.on("end", () => { let data = {}; try { data = d ? JSON.parse(d) : {}; } catch { data = { raw: d }; }
        resolve({ status: res.statusCode, data }); });
    });
    r.on("error", e => resolve({ status: 0, data: { error: e.message } }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const log = (m) => console.log(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SYS_IDX = [
  { name: "closedBy", parts: ["closedBy"], unique: false },
  { name: "createdBy", parts: ["createdBy"], unique: false },
  { name: "handle", parts: ["handle"], unique: true },
  { name: "submittedBy", parts: ["submittedBy"], unique: false },
  { name: "updatedBy", parts: ["updatedBy"], unique: false },
];
function buildPages(fields) {
  const elements = fields.map(f => ({
    type: "field", name: f.name, label: f.name, key: crypto.randomBytes(16).toString("hex"),
    dataType: "string", renderType: "text", enabled: true, visible: true,
    required: f.required || false, rows: f.rows || 1,
    constraints: [], events: [], renderAttributes: {},
    defaultDataSource: "none", defaultValue: "", defaultResourceName: "",
    requiredMessage: "", omitWhenHidden: null, pattern: null,
  }));
  elements.push({ type: "button", name: "Submit Button", label: "Submit", renderType: "submit-page", visible: true, enabled: true, renderAttributes: {} });
  return [{ name: "Page 1", type: "page", renderType: "submittable", elements, events: [] }];
}

async function postRecord(kappSlug, formSlug, values) {
  return kineticRequest("POST", `/kapps/${kappSlug}/forms/${formSlug}/submissions`, { values, coreState: "Submitted" });
}

async function main() {
  const appDef = JSON.parse(fs.readFileSync(path.join(__dir, "app.json"), "utf-8"));
  const kappSlug = appDef.slug;
  log(`\n=== Installing ${appDef.name} (${kappSlug}) on ${SERVER} ===\n`);

  const kr = await kineticRequest("POST", "/kapps", { name: appDef.name, slug: kappSlug, status: "Active" });
  if (kr.status < 300) log(`✓ Created kapp ${kappSlug}`);
  else if (kr.data?.errorKey === "uniqueness_violation") log(`• Kapp ${kappSlug} already exists`);
  else { log(`✗ Failed to create kapp: ${kr.status} ${JSON.stringify(kr.data).slice(0,200)}`); process.exit(1); }

  for (const form of appDef.forms) {
    const fb = { slug: form.slug, name: form.name, status: "Active", pages: buildPages(form.fields) };
    if (form.description) fb.description = form.description;
    if (form.submissionLabelExpression) fb.submissionLabelExpression = form.submissionLabelExpression;
    const r = await kineticRequest("POST", `/kapps/${kappSlug}/forms`, fb);
    if (r.status < 300) log(`✓ Created form ${form.slug} (${form.fields.length} fields)`);
    else if (r.data?.errorKey === "uniqueness_violation") log(`• Form ${form.slug} already exists`);
    else log(`✗ FAILED form ${form.slug}: ${r.status} ${JSON.stringify(r.data).slice(0,200)}`);
  }

  for (const form of appDef.forms) {
    if (!form.indexes) continue;
    const ix = form.indexes, idxDefs = [...SYS_IDX], custom = [];
    for (const p of (ix.single || [])) { idxDefs.push({ parts: [p], unique: false }); custom.push(p); }
    for (const ps of (ix.compound || [])) { idxDefs.push({ parts: ps, unique: false }); custom.push(ps.join(",")); }
    if (!custom.length) continue;
    log(`… Building ${custom.length} indexes on ${form.slug}`);
    const pr = await kineticRequest("PUT", `/kapps/${kappSlug}/forms/${form.slug}`, { indexDefinitions: idxDefs });
    if (pr.status >= 300) { log(`  ✗ index PUT failed: ${pr.status} ${JSON.stringify(pr.data).slice(0,200)}`); continue; }
    await kineticRequest("POST", `/kapps/${kappSlug}/forms/${form.slug}/backgroundJobs`, { type: "Build Index", content: { indexes: custom } });
    for (let w = 0; w < 15; w++) {
      await sleep(2000);
      const check = await kineticRequest("GET", `/kapps/${kappSlug}/forms/${form.slug}?include=indexDefinitions`);
      const defs = (check.data?.form || check.data)?.indexDefinitions || [];
      const pending = defs.filter(d => d.status === "New" && custom.includes(d.parts.join(",")));
      if (!pending.length) break;
    }
    log(`  ✓ Indexes built on ${form.slug}`);
  }

  if (DO_SEED) {
    const seedPath = path.join(__dir, "seed-data.json");
    if (!fs.existsSync(seedPath)) { log("• No seed-data.json (run: node gen-seed.mjs)"); }
    else {
      const seedData = JSON.parse(fs.readFileSync(seedPath, "utf-8"));
      for (const formSlug of Object.keys(seedData)) {
        const records = seedData[formSlug];
        let ok = 0; const failed = [];
        for (let i = 0; i < records.length; i += 10) {
          const batch = records.slice(i, i + 10);
          const results = await Promise.allSettled(batch.map(values => postRecord(kappSlug, formSlug, values)));
          results.forEach((r, j) => {
            if (r.status === "fulfilled" && r.value.status < 300) ok++;
            else failed.push(batch[j]);
          });
          if (i % 100 === 0) process.stdout.write(`\r  seeding ${formSlug}: ${ok}/${records.length}   `);
        }
        // sequential retry for handle-collision failures
        let retried = 0;
        for (const values of failed) {
          let done = false;
          for (let attempt = 0; attempt < 3 && !done; attempt++) {
            const r = await postRecord(kappSlug, formSlug, values);
            if (r.status < 300) { ok++; retried++; done = true; } else await sleep(150);
          }
        }
        process.stdout.write(`\r`);
        log(`✓ Seeded ${formSlug}: ${ok}/${records.length}${retried ? ` (${retried} recovered on retry)` : ""}${ok < records.length ? ` — ${records.length - ok} STILL FAILED` : ""}`);
      }
    }
  }
  log(`\n=== Done. ${SERVER}/app/#/${kappSlug} ===\n`);
}
main();
