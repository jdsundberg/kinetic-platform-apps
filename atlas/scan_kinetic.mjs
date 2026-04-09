#!/usr/bin/env node
/**
 * Atlas Kinetic Platform Scanner
 * Introspects a Kinetic Platform instance and populates Atlas data dictionary.
 *
 * Usage:
 *   node scan_kinetic.mjs \
 *     --url https://source.example.com \
 *     --user admin --pass secret \
 *     --atlas-url http://localhost:3008 \
 *     --atlas-user admin --atlas-pass secret
 */
import https from "node:https";
import http from "node:http";
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/* ───── arg parsing ───── */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const SOURCE_URL = arg("url", "https://first.kinetics.com");
const SOURCE_USER = arg("user", "second_admin");
const SOURCE_PASS = arg("pass", "password2");
const ATLAS_URL = arg("atlas-url", "http://localhost:3008");
const ATLAS_USER = arg("atlas-user", "second_admin");
const ATLAS_PASS = arg("atlas-pass", "password2");

const SOURCE_AUTH = "Basic " + Buffer.from(`${SOURCE_USER}:${SOURCE_PASS}`).toString("base64");
const ATLAS_AUTH = "Basic " + Buffer.from(`${ATLAS_USER}:${ATLAS_PASS}`).toString("base64");

const KAPP = "atlas";

/* ───── HTTP helpers ───── */
function request(baseUrl, method, apiPath, body, authHeader) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, baseUrl);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const headers = { "Content-Type": "application/json" };
    if (authHeader) headers["Authorization"] = authHeader;
    const payload = body ? JSON.stringify(body) : null;
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    const req = lib.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sourceGet(path) {
  return request(SOURCE_URL, "GET", `/app/api/v1${path}`, null, SOURCE_AUTH);
}

function atlasPost(formSlug, values) {
  return request(ATLAS_URL, "POST", `/app/api/v1/kapps/${KAPP}/forms/${formSlug}/submissions`, { values }, ATLAS_AUTH);
}

/* ───── scanner ───── */
async function main() {
  console.log("\n  ╔══════════════════════════════════════╗");
  console.log("  ║   Atlas Kinetic Platform Scanner      ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log(`\n  Source:  ${SOURCE_URL}`);
  console.log(`  Atlas:   ${ATLAS_URL}`);
  console.log(`  Kapp:    ${KAPP}\n`);

  const scanId = `SCAN-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const counts = { systems: 0, datasets: 0, fields: 0, relationships: 0, issues: 0 };

  // Verify source connectivity
  console.log("  Verifying source connectivity...");
  const meResp = await sourceGet("/me");
  if (meResp.status !== 200) {
    console.error(`  ✗ Source auth failed (${meResp.status})`);
    process.exit(1);
  }
  console.log(`  ✓ Authenticated as: ${meResp.data.username || meResp.data.displayName}`);

  // Verify Atlas connectivity
  console.log("  Verifying Atlas connectivity...");
  const atlasMe = await request(ATLAS_URL, "GET", "/app/api/v1/me", null, ATLAS_AUTH);
  if (atlasMe.status !== 200) {
    console.error(`  ✗ Atlas auth failed (${atlasMe.status})`);
    process.exit(1);
  }
  console.log(`  ✓ Atlas authenticated as: ${atlasMe.data.username || atlasMe.data.displayName}\n`);

  // Fetch kapps
  console.log("  Fetching kapps...");
  const kappsResp = await sourceGet("/kapps");
  const kapps = kappsResp.data?.kapps || [];
  console.log(`  Found ${kapps.length} kapps\n`);

  for (const kapp of kapps) {
    const sysName = kapp.name || kapp.slug;
    console.log(`  ┌─ System: ${sysName} (${kapp.slug})`);

    // Create system record
    await atlasPost("system", {
      Name: sysName,
      Description: kapp.description || `Kinetic Kapp: ${kapp.slug}`,
      "System Type": "Platform",
      Technology: "Kinetic Platform",
      Environment: "Production",
      Domain: "",
      Owner: "",
      Status: "Active",
      Tags: "kinetic,auto-scanned",
      "Connection Info": SOURCE_URL,
    });
    counts.systems++;

    // Fetch forms
    const formsResp = await sourceGet(`/kapps/${kapp.slug}/forms`);
    const forms = formsResp.data?.forms || [];
    console.log(`  │  ${forms.length} forms`);

    for (const form of forms) {
      const dsName = form.name || form.slug;
      process.stdout.write(`  │  ├─ ${dsName}`);

      await atlasPost("dataset", {
        Name: dsName,
        Description: form.description || "",
        System: sysName,
        Domain: "",
        "Dataset Type": "Form",
        "Schema Name": kapp.slug,
        "Record Count": "",
        "Source of Truth": "No",
        Owner: "",
        Classification: "",
        Status: "Active",
        Tags: "kinetic,auto-scanned",
        Version: "1",
      });
      counts.datasets++;

      // Fetch form fields
      const formDetail = await sourceGet(`/kapps/${kapp.slug}/forms/${form.slug}?include=fields`);
      const formFields = formDetail.data?.form?.fields || [];
      console.log(` (${formFields.length} fields)`);

      for (const field of formFields) {
        await atlasPost("field", {
          Name: field.name,
          Description: "",
          Dataset: dsName,
          System: sysName,
          "Data Type": "String",
          "Max Length": "",
          Nullable: field.required ? "No" : "Yes",
          "Primary Key": "No",
          "Foreign Key Target": "",
          "Default Value": field.defaultValue || "",
          "Allowed Values": "",
          "Example Values": "",
          "Business Definition": "",
          "Glossary Term": "",
          Classification: "",
          Status: "Active",
          Tags: "kinetic,auto-scanned",
          "Sort Order": "",
        });
        counts.fields++;

        // Detect FK relationships from field names
        const lname = field.name.toLowerCase();
        if (lname.endsWith(" id") || lname.endsWith("_id")) {
          const target = field.name.replace(/[\s_][Ii][Dd]$/, "");
          if (target) {
            await atlasPost("relationship", {
              Name: `${dsName}.${field.name} → ${target}`,
              "Relationship Type": "References",
              "Source Entity Type": "Field",
              "Source Entity": `${dsName}.${field.name}`,
              "Target Entity Type": "Dataset",
              "Target Entity": target,
              Confidence: "Auto",
              Description: "Auto-detected FK reference from field name",
              Status: "Active",
            });
            counts.relationships++;
          }
        }
      }
    }

    console.log(`  └  ✓ ${sysName} complete\n`);
  }

  // Create scan-result
  const completedAt = new Date().toISOString();
  const scannerName = "scan_kinetic.mjs";
  await atlasPost("scan-result", {
    "Scan ID": scanId,
    "Source Type": "Kinetic Platform",
    "Source Name": SOURCE_URL,
    "Scan Status": "Completed",
    "Started At": startedAt,
    "Completed At": completedAt,
    "Systems Found": String(counts.systems),
    "Datasets Found": String(counts.datasets),
    "Fields Found": String(counts.fields),
    "Relationships Found": String(counts.relationships),
    "Issues Found": String(counts.issues),
    "Scanned By": SOURCE_USER,
    Notes: `Scanner: ${scannerName} (CLI) | Scanned ${kapps.length} kapps from ${SOURCE_URL}`,
  });

  // Change log
  await atlasPost("change-log", {
    "Entity Type": "Scan",
    "Entity ID": scanId,
    "Entity Name": `Kinetic scan: ${SOURCE_URL}`,
    Action: "Scan Completed",
    "Changed By": SOURCE_USER,
    Timestamp: completedAt,
    Details: JSON.stringify(counts),
    Notes: `Scanner: ${scannerName}`,
  });

  console.log("  ╔══════════════════════════════════════╗");
  console.log("  ║   Scan Complete                       ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log(`  Scan ID:       ${scanId}`);
  console.log(`  Systems:       ${counts.systems}`);
  console.log(`  Datasets:      ${counts.datasets}`);
  console.log(`  Fields:        ${counts.fields}`);
  console.log(`  Relationships: ${counts.relationships}`);
  console.log(`  Duration:      ${((new Date(completedAt) - new Date(startedAt)) / 1000).toFixed(1)}s\n`);
}

main().catch(e => {
  console.error(`  ✗ Scanner failed: ${e.message}`);
  process.exit(1);
});
