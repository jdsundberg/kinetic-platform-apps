#!/usr/bin/env node
/**
 * CMDB direct installer.
 *
 *   node apps/cmdb/install.mjs [--server URL] [--user U] [--pass P] [--seed] [--reset]
 *
 * Defaults: ai-labs.kinopsdev.io / john / john7 / --seed=true
 *
 * Same install logic as base/server.mjs /api/appmgr/install/{slug} but
 * runs as a standalone script so we don't need to restart the launcher.
 */
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf("--" + name);
  if (i >= 0) return args[i + 1];
  return dflt;
}
const SERVER = arg("server", "https://ai-labs.kinopsdev.io");
const USER = arg("user", "john");
const PASS = arg("pass", "john7");
const DO_SEED = args.includes("--seed") || !args.includes("--no-seed");
const RESET = args.includes("--reset");
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const __dir = path.dirname(new URL(import.meta.url).pathname);
const APP_DEF = JSON.parse(fs.readFileSync(path.join(__dir, "app.json"), "utf-8"));
const SEED = fs.existsSync(path.join(__dir, "seed-data.json"))
  ? JSON.parse(fs.readFileSync(path.join(__dir, "seed-data.json"), "utf-8"))
  : null;

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`/app/api/v1${p}`, SERVER);
    const headers = { "Content-Type": "application/json", "Authorization": AUTH };
    const payload = body ? JSON.stringify(body) : null;
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
    const r = https.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}
function log(step, msg, tag = "") {
  const tags = { ok: "\x1b[32m✔\x1b[0m", warn: "\x1b[33m⚠\x1b[0m", fail: "\x1b[31m✗\x1b[0m", "": "·" };
  console.log(`${tags[tag] || tag}  [${step.padEnd(8)}] ${msg}`);
}

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

const SYS_IDX = [
  { name: "closedBy", parts: ["closedBy"], unique: false },
  { name: "createdBy", parts: ["createdBy"], unique: false },
  { name: "handle", parts: ["handle"], unique: true },
  { name: "submittedBy", parts: ["submittedBy"], unique: false },
  { name: "updatedBy", parts: ["updatedBy"], unique: false },
];

async function main() {
  const kappSlug = APP_DEF.slug;
  const kappName = APP_DEF.name;
  console.log(`\n  Installing ${kappName} → ${SERVER}\n`);

  if (RESET) {
    log("reset", `Deleting kapp ${kappSlug}...`);
    const dr = await req("DELETE", `/kapps/${kappSlug}`);
    if (dr.status < 300) log("reset", "Deleted", "ok");
    else log("reset", `Status ${dr.status}`, "warn");
  }

  // Create kapp
  log("kapp", `Creating kapp '${kappSlug}'...`);
  const kr = await req("POST", "/kapps", { name: kappName, slug: kappSlug, status: "Active" });
  if (kr.status < 300) log("kapp", `Created '${kappSlug}'`, "ok");
  else if (kr.data?.errorKey === "uniqueness_violation") log("kapp", "Kapp already exists, continuing", "warn");
  else { log("kapp", `FAILED status=${kr.status}: ${JSON.stringify(kr.data).slice(0, 200)}`, "fail"); process.exit(1); }

  // Create forms
  for (let i = 0; i < APP_DEF.forms.length; i++) {
    const form = APP_DEF.forms[i];
    log("form", `${i + 1}/${APP_DEF.forms.length}: ${form.slug} (${form.fields.length} fields)`);
    const fb = { slug: form.slug, name: form.name, status: "Active", pages: buildPages(form.fields) };
    if (form.description) fb.description = form.description;
    if (form.submissionLabelExpression) fb.submissionLabelExpression = form.submissionLabelExpression;
    const r = await req("POST", `/kapps/${kappSlug}/forms`, fb);
    if (r.status < 300) log("form", `Created ${form.slug}`, "ok");
    else if (r.data?.errorKey === "uniqueness_violation") log("form", `${form.slug} already exists`, "warn");
    else log("form", `FAILED ${form.slug}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`, "fail");
  }

  // Indexes
  for (const form of APP_DEF.forms) {
    if (!form.indexes) continue;
    const idxDefs = [...SYS_IDX];
    const custom = [];
    for (const p of (form.indexes.single || [])) { idxDefs.push({ parts: [p], unique: false }); custom.push(p); }
    for (const ps of (form.indexes.compound || [])) { idxDefs.push({ parts: ps, unique: false }); custom.push(ps.join(",")); }
    if (!custom.length) continue;
    log("index", `Building ${custom.length} indexes on ${form.slug}...`);
    await req("PUT", `/kapps/${kappSlug}/forms/${form.slug}`, { indexDefinitions: idxDefs });
    await req("POST", `/kapps/${kappSlug}/forms/${form.slug}/backgroundJobs`, { type: "Build Index", content: { indexes: custom } });
    for (let w = 0; w < 15; w++) {
      await new Promise(r => setTimeout(r, 2000));
      const check = await req("GET", `/kapps/${kappSlug}/forms/${form.slug}?include=indexDefinitions`);
      const defs = (check.data?.form || check.data)?.indexDefinitions || [];
      const pending = defs.filter(d => d.status === "New" && custom.includes(d.parts.join(",")));
      if (!pending.length) break;
    }
    log("index", `Built ${custom.length} indexes on ${form.slug}`, "ok");
  }

  // Seed
  if (DO_SEED && SEED) {
    let totalSeeded = 0;
    const formSlugs = Object.keys(SEED);
    for (const formSlug of formSlugs) {
      const records = SEED[formSlug];
      log("seed", `${formSlug}: 0/${records.length}`);
      let ok = 0;
      for (let i = 0; i < records.length; i += 10) {
        const batch = records.slice(i, i + 10);
        const results = await Promise.allSettled(batch.map(values =>
          req("POST", `/kapps/${kappSlug}/forms/${formSlug}/submissions`, { values, coreState: "Submitted" })
        ));
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.status < 300) ok++;
          else if (r.status === "fulfilled") {
            console.log(`    sample fail: ${r.value.status} ${JSON.stringify(r.value.data).slice(0, 200)}`);
          }
        }
      }
      totalSeeded += ok;
      log("seed", `${formSlug}: ${ok}/${records.length}`, ok === records.length ? "ok" : "warn");
    }
    log("done", `Seeded ${totalSeeded} total records`, "ok");
  }

  console.log(`\n  CMDB install complete. Open https://ai-labs.kinopsdev.io/app/space/${kappSlug} for raw view.\n`);
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
