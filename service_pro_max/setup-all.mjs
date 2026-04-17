/**
 * Setup fields, indexes, and seed data for ServiceProMax
 * Usage: node setup-all.mjs [--seed]
 */
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const SERVER = "https://first.kinetics.com";
const AUTH = "Basic " + Buffer.from("john:john1").toString("base64");
const KAPP = "service-pro-max";
const doSeed = process.argv.includes("--seed");

function req(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER + "/app/api/v1" + apiPath);
    const opts = { method, hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, headers: { Authorization: AUTH, "Content-Type": "application/json" } };
    const r = https.request(opts, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode} ${method} ${apiPath}: ${d.slice(0, 300)}`));
        else resolve(d ? JSON.parse(d) : {});
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function uuid() { return crypto.randomUUID().replace(/-/g, ''); }

const SYS_INDEXES = [
  { name: "closedBy", parts: ["closedBy"], unique: false },
  { name: "createdBy", parts: ["createdBy"], unique: false },
  { name: "handle", parts: ["handle"], unique: true },
  { name: "submittedBy", parts: ["submittedBy"], unique: false },
  { name: "updatedBy", parts: ["updatedBy"], unique: false },
];

function idx(parts) {
  return { name: parts.join(","), parts, unique: false };
}

const appJson = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "app.json"), "utf8"));

function buildFormBody(formDef) {
  // Build fields with all required properties
  const fields = formDef.fields.map(f => ({
    type: "field",
    name: f.name,
    label: f.name,
    key: uuid(),
    renderType: "text",
    dataType: "string",
    required: f.required || false,
    enabled: true,
    visible: true,
    rows: f.rows || 1,
    defaultValue: null,
    defaultResourceName: null,
    defaultDataSource: "none",
    requiredMessage: null,
    omitWhenHidden: null,
    pattern: null,
    constraints: [],
    events: [],
    renderAttributes: {},
  }));

  // Build page with elements referencing the fields
  const page = {
    name: "Page 1",
    type: "page",
    renderType: "submittable",
    advanceCondition: null,
    displayCondition: null,
    events: [],
    elements: fields.map(f => ({
      type: "field",
      name: f.name,
      label: f.label,
      key: f.key,
      renderType: f.renderType,
      dataType: f.dataType,
      required: f.required,
      enabled: true,
      visible: true,
      rows: f.rows,
      defaultValue: null,
      defaultResourceName: null,
      defaultDataSource: "none",
      requiredMessage: null,
      omitWhenHidden: null,
      pattern: null,
      constraints: [],
      events: [],
      renderAttributes: {},
    })),
  };

  return {
    fields,
    pages: [page],
    submissionLabelExpression: formDef.submissionLabelExpression || null,
  };
}

async function setupFields() {
  console.log("=== Setting up fields for", appJson.forms.length, "forms ===");
  for (const form of appJson.forms) {
    const body = buildFormBody(form);
    try {
      await req("PUT", `/kapps/${KAPP}/forms/${form.slug}`, body);
      console.log(`  ${form.slug}: ${form.fields.length} fields`);
    } catch (e) {
      console.error(`  ${form.slug}: ERROR - ${e.message}`);
    }
  }
}

async function setupIndexes() {
  console.log("\n=== Setting up indexes ===");
  for (const form of appJson.forms) {
    if (!form.indexes) { console.log(`  ${form.slug}: no indexes`); continue; }
    const defs = [...SYS_INDEXES];
    for (const s of form.indexes.single || []) defs.push(idx([s]));
    for (const c of form.indexes.compound || []) defs.push(idx(c));
    try {
      await req("PUT", `/kapps/${KAPP}/forms/${form.slug}`, { indexDefinitions: defs });
      console.log(`  ${form.slug}: ${defs.length - 5} custom indexes`);
    } catch (e) { console.error(`  ${form.slug}: INDEX ERROR - ${e.message}`); }
  }

  console.log("\nTriggering index builds...");
  for (const form of appJson.forms) {
    if (!form.indexes) continue;
    try {
      // Collect all custom index names for this form
      const indexNames = [];
      for (const s of (form.indexes.single || [])) indexNames.push(s);
      for (const c of (form.indexes.compound || [])) indexNames.push(c.join(","));
      await req("POST", `/kapps/${KAPP}/forms/${form.slug}/backgroundJobs`, { type: "Build Index", content: { indexes: indexNames } });
      console.log(`  ${form.slug}: build started`);
    } catch (e) { console.error(`  ${form.slug}: build error - ${e.message}`); }
  }

  console.log("Waiting 10s for index builds...");
  await new Promise(r => setTimeout(r, 10000));
}

async function seedData() {
  const seedFile = path.join(import.meta.dirname, "seed-data.json");
  if (!fs.existsSync(seedFile)) { console.log("No seed-data.json"); return; }
  const seedData = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  console.log("\n=== Seeding data ===");

  for (const [formSlug, records] of Object.entries(seedData)) {
    process.stdout.write(`  ${formSlug}: ${records.length} records... `);
    let ok = 0, fail = 0;
    for (let i = 0; i < records.length; i += 5) {
      const batch = records.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(rec => req("POST", `/kapps/${KAPP}/forms/${formSlug}/submissions?completed=true`, { values: rec }))
      );
      ok += results.filter(r => r.status === "fulfilled").length;
      const failures = results.filter(r => r.status === "rejected");
      fail += failures.length;
      if (failures.length > 0 && fail <= 2) {
        for (const f of failures) console.error(`\n    SEED ERROR: ${f.reason.message}`);
      }
    }
    console.log(`${ok} ok, ${fail} failed`);
  }
}

async function main() {
  try {
    await setupFields();
    await setupIndexes();
    if (doSeed) await seedData();
    else console.log("\nSkip seed (use --seed)");
    console.log("\nDone!");
  } catch (e) { console.error("Fatal:", e); process.exit(1); }
}

main();
