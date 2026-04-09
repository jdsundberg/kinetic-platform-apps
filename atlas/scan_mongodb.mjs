#!/usr/bin/env node
/**
 * Atlas MongoDB Scanner
 * Connects to a MongoDB instance, discovers its structure by sampling
 * documents, infers schemas, and populates Atlas data dictionary.
 *
 * Usage:
 *   node scan_mongodb.mjs \
 *     --host localhost --port 27017 \
 *     --user admin --pass secret \
 *     --database mydb \
 *     --sample-size 100 \
 *     --atlas-url http://localhost:3008 \
 *     --atlas-user admin --atlas-pass secret
 */
import https from "node:https";
import http from "node:http";
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

let MongoClient;
try {
  ({ MongoClient } = await import("mongodb"));
} catch {
  console.error("Error: 'mongodb' package required. Install with: npm install mongodb");
  process.exit(1);
}

const SCANNER = "scan_mongodb.mjs";

/* ───── arg parsing ───── */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const HOST = arg("host", "localhost");
const PORT = arg("port", "27017");
const USER = arg("user", "");
const PASS = arg("pass", "");
const DATABASE = arg("database", "");
const SAMPLE_SIZE = parseInt(arg("sample-size", "100"), 10);
const ATLAS_URL = arg("atlas-url", "http://localhost:3008");
const ATLAS_USER = arg("atlas-user", "second_admin");
const ATLAS_PASS = arg("atlas-pass", "password2");

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

function atlasPost(formSlug, values) {
  return request(ATLAS_URL, "POST", `/app/api/v1/kapps/${KAPP}/forms/${formSlug}/submissions`, { values }, ATLAS_AUTH);
}

/* ───── schema inference ───── */
const SYSTEM_DBS = new Set(["admin", "local", "config"]);

function mapBsonType(t) {
  switch (t) {
    case "string": return "String";
    case "number": return "Decimal";
    case "boolean": return "Boolean";
    case "object": return "JSON";
    case "array": return "JSON";
    case "date": return "DateTime";
    case "objectid": return "String";
    case "null": return "Unknown";
    default: return "String";
  }
}

function visitFields(obj, prefix, fields, depth) {
  if (depth > 2 || !obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!fields.has(path)) fields.set(path, { types: new Map(), seen: 0 });
    const info = fields.get(path);
    info.seen++;
    let t;
    if (val === null || val === undefined) {
      t = "null";
    } else if (Array.isArray(val)) {
      t = "array";
    } else if (val instanceof Date) {
      t = "date";
    } else if (val._bsontype === "ObjectId" || (val.constructor && val.constructor.name === "ObjectId")) {
      t = "objectid";
    } else {
      t = typeof val;
    }
    info.types.set(t, (info.types.get(t) || 0) + 1);
    if (t === "object") visitFields(val, path, fields, depth + 1);
  }
}

function inferSchema(docs) {
  const fields = new Map();
  for (const doc of docs) {
    visitFields(doc, "", fields, 0);
  }
  return [...fields.entries()].map(([path, info]) => {
    const topType = [...info.types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Unknown";
    return { name: path, type: mapBsonType(topType), nullable: info.seen < docs.length };
  });
}

function inferTarget(fieldName) {
  // "user_id" → "user", "userId" → "User", "company_id" → "company"
  let target = fieldName.replace(/_id$/i, "").replace(/Id$/, "");
  return target || null;
}

/* ───── scanner ───── */
async function main() {
  const connDisplay = `mongodb://${HOST}:${PORT}`;

  console.log("\n  ╔══════════════════════════════════════╗");
  console.log("  ║   Atlas MongoDB Scanner                ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log(`\n  Source:      ${connDisplay}`);
  console.log(`  Database:   ${DATABASE || "(all non-system)"}`);
  console.log(`  Sample:     ${SAMPLE_SIZE} docs per collection`);
  console.log(`  Atlas:      ${ATLAS_URL}`);
  console.log(`  Kapp:       ${KAPP}\n`);

  const scanId = `SCAN-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const counts = { systems: 0, datasets: 0, fields: 0, relationships: 0, issues: 0 };

  // Build connection URI
  let uri;
  if (USER && PASS) {
    uri = `mongodb://${encodeURIComponent(USER)}:${encodeURIComponent(PASS)}@${HOST}:${PORT}`;
  } else {
    uri = `mongodb://${HOST}:${PORT}`;
  }

  // Connect to MongoDB
  console.log("  Connecting to MongoDB...");
  let client;
  try {
    client = new MongoClient(uri);
    await client.connect();
  } catch (e) {
    console.error(`  x MongoDB connection failed: ${e.message}`);
    process.exit(1);
  }
  console.log(`  + Connected to ${connDisplay}`);

  // Verify Atlas connectivity
  console.log("  Verifying Atlas connectivity...");
  const atlasMe = await request(ATLAS_URL, "GET", "/app/api/v1/me", null, ATLAS_AUTH);
  if (atlasMe.status !== 200) {
    console.error(`  x Atlas auth failed (${atlasMe.status})`);
    await client.close();
    process.exit(1);
  }
  console.log(`  + Atlas authenticated as: ${atlasMe.data.username || atlasMe.data.displayName}\n`);

  // List databases
  let databases;
  if (DATABASE) {
    databases = [{ name: DATABASE }];
    console.log(`  Scanning specified database: ${DATABASE}\n`);
  } else {
    console.log("  Listing databases...");
    const dbList = await client.db().admin().listDatabases();
    databases = (dbList.databases || []).filter(d => !SYSTEM_DBS.has(d.name));
    console.log(`  Found ${databases.length} non-system databases\n`);
  }

  // Create system record
  const sysName = `mongodb://${HOST}:${PORT}`;
  console.log(`  Creating system record: ${sysName}`);
  await atlasPost("system", {
    Name: sysName,
    Description: `MongoDB instance at ${HOST}:${PORT}`,
    "System Type": "Database",
    Technology: "MongoDB",
    Environment: "Production",
    Domain: "",
    Owner: "",
    Status: "Active",
    Tags: "mongodb,auto-scanned",
    "Connection Info": `mongodb://${HOST}:${PORT}`,
  });
  counts.systems++;
  console.log("");

  let totalCollections = 0;

  for (const dbInfo of databases) {
    const dbName = dbInfo.name;
    const db = client.db(dbName);

    console.log(`  ┌─ Database: ${dbName}`);

    // List collections
    const collections = await db.listCollections().toArray();
    console.log(`  │  ${collections.length} collections`);

    for (const collInfo of collections) {
      const collName = collInfo.name;
      const collection = db.collection(collName);
      const dsName = `${dbName}.${collName}`;

      // Estimated document count
      let docCount = 0;
      try {
        docCount = await collection.estimatedDocumentCount();
      } catch { /* ignore */ }

      process.stdout.write(`  │  ├─ ${collName} (~${docCount} docs)`);

      // Create dataset record
      await atlasPost("dataset", {
        Name: dsName,
        Description: "",
        System: sysName,
        Domain: "",
        "Dataset Type": "Collection",
        "Schema Name": dbName,
        "Record Count": String(docCount),
        "Source of Truth": "",
        Owner: "",
        Classification: "",
        Status: "Active",
        Tags: "mongodb,auto-scanned",
        Version: "1",
      });
      counts.datasets++;
      totalCollections++;

      // Sample documents
      let docs = [];
      try {
        docs = await collection.find().limit(SAMPLE_SIZE).toArray();
      } catch { /* ignore */ }

      // Infer schema
      const schema = docs.length > 0 ? inferSchema(docs) : [];
      console.log(` (${schema.length} fields)`);

      for (const field of schema) {
        await atlasPost("field", {
          Name: field.name,
          Description: "",
          Dataset: dsName,
          System: sysName,
          "Data Type": field.type,
          "Max Length": "",
          Nullable: field.nullable ? "Yes" : "No",
          "Primary Key": field.name === "_id" ? "Yes" : "No",
          "Foreign Key Target": "",
          "Default Value": "",
          "Allowed Values": "",
          "Example Values": "",
          "Business Definition": "",
          "Glossary Term": "",
          Classification: "",
          Status: "Active",
          Tags: "mongodb,auto-scanned",
          "Sort Order": "",
        });
        counts.fields++;

        // Detect references: fields ending in _id or Id (but not "_id" itself)
        if (field.name !== "_id" && (field.name.endsWith("_id") || /[a-z]Id$/.test(field.name))) {
          const target = inferTarget(field.name);
          if (target) {
            await atlasPost("relationship", {
              Name: `${dsName}.${field.name} → ${target}`,
              "Relationship Type": "References",
              "Source Entity Type": "Field",
              "Source Entity": `${dsName}.${field.name}`,
              "Target Entity Type": "Dataset",
              "Target Entity": target,
              Confidence: "Auto",
              Description: "Auto-detected reference from field naming convention",
              Status: "Active",
            });
            counts.relationships++;
          }
        }
      }
    }

    console.log(`  └  + ${dbName} complete\n`);
  }

  // Close MongoDB connection
  await client.close();
  console.log("  MongoDB connection closed.\n");

  // Create scan-result
  const completedAt = new Date().toISOString();
  await atlasPost("scan-result", {
    "Scan ID": scanId,
    "Source Type": "MongoDB",
    "Source Name": sysName,
    "Scan Status": "Completed",
    "Started At": startedAt,
    "Completed At": completedAt,
    "Systems Found": String(counts.systems),
    "Datasets Found": String(counts.datasets),
    "Fields Found": String(counts.fields),
    "Relationships Found": String(counts.relationships),
    "Issues Found": String(counts.issues),
    "Scanned By": USER || "anonymous",
    Notes: `Scanner: ${SCANNER} (CLI) | Scanned ${databases.length} databases, ${totalCollections} collections, sampled ${SAMPLE_SIZE} docs per collection`,
  });

  // Change log
  await atlasPost("change-log", {
    "Entity Type": "Scan",
    "Entity ID": scanId,
    "Entity Name": `MongoDB scan: ${sysName}`,
    Action: "Scan Completed",
    "Changed By": USER || "anonymous",
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
  console.log(`  Duration:      ${((new Date(completedAt) - new Date(startedAt)) / 1000).toFixed(1)}s\n`);
}

main().catch(e => {
  console.error(`  x Scanner failed: ${e.message}`);
  process.exit(1);
});
