#!/usr/bin/env node
/**
 * Atlas CouchDB Scanner
 * Connects to a CouchDB instance via its HTTP API, discovers databases and
 * document structure by sampling, and writes the results to Atlas.
 *
 * Usage:
 *   node scan_couchdb.mjs \
 *     --host localhost --port 5984 \
 *     --user admin --pass secret \
 *     --database mydb \
 *     --sample-size 50 \
 *     --atlas-url http://localhost:3008 \
 *     --atlas-user admin --atlas-pass secret
 */
import https from "node:https";
import http from "node:http";
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const SCANNER = "scan_couchdb.mjs";

/* ───── arg parsing ───── */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const COUCH_HOST = arg("host", "localhost");
const COUCH_PORT = arg("port", "5984");
const COUCH_USER = arg("user", "admin");
const COUCH_PASS = arg("pass", "");
const DATABASE = arg("database", "");
const SAMPLE_SIZE = parseInt(arg("sample-size", "50"), 10);
const ATLAS_URL = arg("atlas-url", "http://localhost:3008");
const ATLAS_USER = arg("atlas-user", "second_admin");
const ATLAS_PASS = arg("atlas-pass", "password2");

const COUCH_URL = `http://${COUCH_HOST}:${COUCH_PORT}`;
const COUCH_AUTH = COUCH_USER
  ? "Basic " + Buffer.from(`${COUCH_USER}:${COUCH_PASS}`).toString("base64")
  : null;
const ATLAS_AUTH = "Basic " + Buffer.from(`${ATLAS_USER}:${ATLAS_PASS}`).toString("base64");

const KAPP = "atlas";

/* ───── system DBs to skip ───── */
const SYSTEM_DBS = new Set(["_replicator", "_users", "_global_changes"]);

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

function couchRequest(method, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, COUCH_URL);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const headers = { "Content-Type": "application/json" };
    if (COUCH_AUTH) headers["Authorization"] = COUCH_AUTH;
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
    req.end();
  });
}

function atlasPost(formSlug, values) {
  return request(ATLAS_URL, "POST", `/app/api/v1/kapps/${KAPP}/forms/${formSlug}/submissions`, { values }, ATLAS_AUTH);
}

/* ───── schema inference ───── */
function visitFields(obj, prefix, fields, depth) {
  if (depth > 2) return;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const jsType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

    if (!fields.has(path)) {
      fields.set(path, { types: new Map(), seen: 0 });
    }
    const info = fields.get(path);
    info.seen++;
    info.types.set(jsType, (info.types.get(jsType) || 0) + 1);

    if (jsType === "object" && depth < 2) {
      visitFields(value, path, fields, depth + 1);
    }
  }
}

function mapType(jsType) {
  switch (jsType) {
    case "string": return "String";
    case "number": return "Decimal";
    case "boolean": return "Boolean";
    case "object": return "JSON";
    case "array": return "JSON";
    default: return "Unknown";
  }
}

function inferSchema(docs) {
  const fields = new Map();
  for (const doc of docs) {
    visitFields(doc, "", fields, 0);
  }
  return [...fields.entries()]
    .filter(([path]) => path !== "_rev")
    .map(([path, info]) => {
      const topType = [...info.types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Unknown";
      return {
        name: path,
        type: mapType(topType),
        nullable: info.seen < docs.length,
        isPK: path === "_id",
      };
    });
}

/* ───── scanner ───── */
async function main() {
  console.log("\n  ╔══════════════════════════════════════╗");
  console.log("  ║   Atlas CouchDB Scanner               ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log(`\n  Source:      ${COUCH_URL}`);
  console.log(`  Atlas:       ${ATLAS_URL}`);
  console.log(`  Database:    ${DATABASE || "(all non-system)"}`);
  console.log(`  Sample size: ${SAMPLE_SIZE}\n`);

  const scanId = `SCAN-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const counts = { systems: 0, datasets: 0, fields: 0, relationships: 0, issues: 0 };

  // Verify CouchDB connectivity
  console.log("  Verifying CouchDB connectivity...");
  let welcomeResp;
  try {
    welcomeResp = await couchRequest("GET", "/");
  } catch (e) {
    console.error(`  x CouchDB connection failed: ${e.message}`);
    process.exit(1);
  }
  if (welcomeResp.status !== 200 || !welcomeResp.data?.couchdb) {
    console.error(`  x CouchDB connection failed (${welcomeResp.status})`);
    process.exit(1);
  }
  const couchVersion = welcomeResp.data.version || "unknown";
  console.log(`  + Connected to Apache CouchDB ${couchVersion}`);

  // Verify Atlas connectivity
  console.log("  Verifying Atlas connectivity...");
  const atlasMe = await request(ATLAS_URL, "GET", "/app/api/v1/me", null, ATLAS_AUTH);
  if (atlasMe.status !== 200) {
    console.error(`  x Atlas auth failed (${atlasMe.status})`);
    process.exit(1);
  }
  console.log(`  + Atlas authenticated as: ${atlasMe.data.username || atlasMe.data.displayName}\n`);

  // List databases
  let databases = [];
  if (DATABASE) {
    databases = [DATABASE];
    console.log(`  Scanning single database: ${DATABASE}`);
  } else {
    console.log("  Fetching database list...");
    const dbResp = await couchRequest("GET", "/_all_dbs");
    if (dbResp.status !== 200 || !Array.isArray(dbResp.data)) {
      console.error(`  x Failed to list databases (${dbResp.status})`);
      process.exit(1);
    }
    databases = dbResp.data.filter(
      (db) => !db.startsWith("_") && !SYSTEM_DBS.has(db)
    );
    console.log(`  Found ${databases.length} user databases\n`);
  }

  if (databases.length === 0) {
    console.log("  No databases to scan.\n");
    return;
  }

  // Create system record
  const sysName = `couchdb://${COUCH_HOST}:${COUCH_PORT}`;
  console.log(`  Creating system: ${sysName}`);
  await atlasPost("system", {
    Name: sysName,
    Description: `Apache CouchDB instance at ${COUCH_HOST}:${COUCH_PORT}`,
    "System Type": "Database",
    Technology: `Apache CouchDB ${couchVersion}`,
    Environment: "Production",
    Domain: "",
    Owner: "",
    Status: "Active",
    Tags: "couchdb,auto-scanned",
    "Connection Info": `http://${COUCH_HOST}:${COUCH_PORT}`,
  });
  counts.systems++;
  console.log(`  + System record created\n`);

  // Scan each database
  for (const db of databases) {
    const encodedDb = encodeURIComponent(db);
    console.log(`  ┌─ Database: ${db}`);

    // Get database info
    const dbInfoResp = await couchRequest("GET", `/${encodedDb}`);
    if (dbInfoResp.status !== 200) {
      console.log(`  │  x Failed to get info (${dbInfoResp.status}), skipping`);
      console.log(`  └  x ${db} skipped\n`);
      counts.issues++;
      continue;
    }
    const dbInfo = dbInfoResp.data;
    const docCount = dbInfo.doc_count || 0;
    const diskSize = dbInfo.disk_size || dbInfo.sizes?.file || 0;
    console.log(`  │  ${docCount} documents, ${(diskSize / 1024 / 1024).toFixed(1)} MB`);

    // Create dataset record
    const dsName = db;
    await atlasPost("dataset", {
      Name: dsName,
      Description: `CouchDB database: ${db}`,
      System: sysName,
      Domain: "",
      "Dataset Type": "Collection",
      "Schema Name": "(document store)",
      "Record Count": String(docCount),
      "Source of Truth": "No",
      Owner: "",
      Classification: "",
      Status: "Active",
      Tags: "couchdb,auto-scanned",
      Version: "1",
    });
    counts.datasets++;

    // Sample documents
    if (docCount === 0) {
      console.log(`  │  (empty database, no fields to infer)`);
      console.log(`  └  + ${db} complete\n`);
      continue;
    }

    const docsResp = await couchRequest(
      "GET",
      `/${encodedDb}/_all_docs?include_docs=true&limit=${SAMPLE_SIZE}`
    );
    if (docsResp.status !== 200 || !docsResp.data?.rows) {
      console.log(`  │  x Failed to sample documents (${docsResp.status})`);
      console.log(`  └  x ${db} partial\n`);
      counts.issues++;
      continue;
    }

    const docs = docsResp.data.rows
      .map((r) => r.doc)
      .filter((d) => d && !d._id.startsWith("_design/"));

    if (docs.length === 0) {
      console.log(`  │  (no user documents found in sample)`);
      console.log(`  └  + ${db} complete\n`);
      continue;
    }

    console.log(`  │  Sampled ${docs.length} documents`);

    // Infer schema
    const schema = inferSchema(docs);
    console.log(`  │  Inferred ${schema.length} fields`);

    // Create field records
    for (const field of schema) {
      await atlasPost("field", {
        Name: field.name,
        Description: "",
        Dataset: dsName,
        System: sysName,
        "Data Type": field.type,
        "Max Length": "",
        Nullable: field.nullable ? "Yes" : "No",
        "Primary Key": field.isPK ? "Yes" : "No",
        "Foreign Key Target": "",
        "Default Value": "",
        "Allowed Values": "",
        "Example Values": "",
        "Business Definition": "",
        "Glossary Term": "",
        Classification: "",
        Status: "Active",
        Tags: "couchdb,auto-scanned",
        "Sort Order": "",
      });
      counts.fields++;

      // Detect references: fields named *_id or *Id (excluding _id, _rev)
      if (field.name !== "_id" && field.name !== "_rev") {
        const match = field.name.match(/^(.+?)([_]id|Id)$/);
        if (match) {
          const target = match[1];
          await atlasPost("relationship", {
            Name: `${dsName}.${field.name} -> ${target}`,
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

    console.log(`  └  + ${db} complete\n`);
  }

  // Create scan-result
  const completedAt = new Date().toISOString();
  await atlasPost("scan-result", {
    "Scan ID": scanId,
    "Source Type": "CouchDB",
    "Source Name": sysName,
    "Scan Status": "Completed",
    "Started At": startedAt,
    "Completed At": completedAt,
    "Systems Found": String(counts.systems),
    "Datasets Found": String(counts.datasets),
    "Fields Found": String(counts.fields),
    "Relationships Found": String(counts.relationships),
    "Issues Found": String(counts.issues),
    "Scanned By": COUCH_USER,
    Notes: `Scanner: ${SCANNER} (CLI) | Scanned ${databases.length} databases, sampled ${SAMPLE_SIZE} docs per database`,
  });

  // Change log
  await atlasPost("change-log", {
    "Entity Type": "Scan",
    "Entity ID": scanId,
    "Entity Name": `CouchDB scan: ${sysName}`,
    Action: "Scan Completed",
    "Changed By": COUCH_USER,
    Timestamp: completedAt,
    Details: JSON.stringify(counts),
    Notes: `Scanner: ${SCANNER}`,
  });

  console.log("  ╔══════════════════════════════════════╗");
  console.log("  ║   Scan Complete                       ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log(`  Scan ID:       ${scanId}`);
  console.log(`  Systems:       ${counts.systems}`);
  console.log(`  Datasets:      ${counts.datasets}`);
  console.log(`  Fields:        ${counts.fields}`);
  console.log(`  Relationships: ${counts.relationships}`);
  console.log(`  Issues:        ${counts.issues}`);
  console.log(`  Duration:      ${((new Date(completedAt) - new Date(startedAt)) / 1000).toFixed(1)}s\n`);
}

main().catch((e) => {
  console.error(`  x Scanner failed: ${e.message}`);
  process.exit(1);
});
