/**
 * Setup indexes and seed data for ServiceProMax
 * Usage: node setup-indexes.mjs [--seed]
 */
import https from "node:https";
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
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode} ${method} ${apiPath}: ${d.slice(0, 200)}`));
        else resolve(d ? JSON.parse(d) : {});
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// System indexes that are always present
const SYS = [
  { name: "closedBy", parts: ["closedBy"], unique: false },
  { name: "createdBy", parts: ["createdBy"], unique: false },
  { name: "handle", parts: ["handle"], unique: true },
  { name: "submittedBy", parts: ["submittedBy"], unique: false },
  { name: "updatedBy", parts: ["updatedBy"], unique: false },
];

function idx(parts) {
  const name = parts.join(",");
  return { name, parts, unique: false };
}

// Read app.json to get index definitions
const appJson = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "app.json"), "utf8"));

async function setupIndexes() {
  console.log("Setting up indexes for", appJson.forms.length, "forms...");
  for (const form of appJson.forms) {
    if (!form.indexes) { console.log(`  ${form.slug}: no indexes defined`); continue; }
    const defs = [...SYS];
    for (const s of form.indexes.single || []) defs.push(idx([s]));
    for (const c of form.indexes.compound || []) defs.push(idx(c));
    try {
      await req("PUT", `/kapps/${KAPP}/forms/${form.slug}`, { indexDefinitions: defs });
      console.log(`  ${form.slug}: ${defs.length - 5} custom indexes defined`);
    } catch (e) { console.error(`  ${form.slug}: ERROR - ${e.message}`); }
  }

  // Trigger index builds for all forms
  console.log("\nTriggering index builds...");
  for (const form of appJson.forms) {
    if (!form.indexes) continue;
    try {
      await req("POST", `/kapps/${KAPP}/forms/${form.slug}/backgroundJobs`, { type: "index" });
      console.log(`  ${form.slug}: build triggered`);
    } catch (e) { console.error(`  ${form.slug}: build error - ${e.message}`); }
  }

  // Wait for builds
  console.log("\nWaiting for index builds to complete...");
  await new Promise(r => setTimeout(r, 5000));
  console.log("Index setup complete.");
}

async function seedData() {
  const seedFile = path.join(import.meta.dirname, "seed-data.json");
  if (!fs.existsSync(seedFile)) { console.log("No seed-data.json found"); return; }
  const seedData = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  console.log("\nSeeding data...");

  for (const [formSlug, records] of Object.entries(seedData)) {
    console.log(`  ${formSlug}: ${records.length} records`);
    // Batch in groups of 5 for speed
    for (let i = 0; i < records.length; i += 5) {
      const batch = records.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(rec => req("POST", `/kapps/${KAPP}/forms/${formSlug}/submissions?completed=true`, { values: rec }))
      );
      const failed = results.filter(r => r.status === "rejected");
      if (failed.length > 0) {
        for (const f of failed) console.error(`    ERROR: ${f.reason.message}`);
      }
    }
    console.log(`    done`);
  }
  console.log("\nSeed data complete.");
}

async function main() {
  try {
    await setupIndexes();
    if (doSeed) await seedData();
    else console.log("\nSkipping seed data (use --seed flag to seed)");
    console.log("\nDone!");
  } catch (e) { console.error("Fatal error:", e); process.exit(1); }
}

main();
