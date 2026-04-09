#!/usr/bin/env node
/**
 * Atlas Cassandra Scanner
 * Introspects a Cassandra cluster and populates Atlas data dictionary.
 *
 * Usage:
 *   node scan_cassandra.mjs \
 *     --host localhost --port 9042 \
 *     --user admin --pass secret \
 *     --datacenter datacenter1 \
 *     --keyspace my_keyspace \
 *     --atlas-url http://localhost:3008 \
 *     --atlas-user admin --atlas-pass secret
 */
import https from "node:https";
import http from "node:http";
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const SCANNER = "scan_cassandra.mjs";

/* ───── driver import ───── */
let cassandra;
try {
  cassandra = await import("cassandra-driver");
  // Handle both default and named exports
  if (cassandra.default) cassandra = cassandra.default;
} catch {
  console.error("Error: 'cassandra-driver' package required. Install with: npm install cassandra-driver");
  process.exit(1);
}

/* ───── arg parsing ───── */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const HOST = arg("host", "localhost");
const PORT = arg("port", "9042");
const USER = arg("user", "");
const PASS = arg("pass", "");
const DATACENTER = arg("datacenter", "datacenter1");
const KEYSPACE = arg("keyspace", "");
const ATLAS_URL = arg("atlas-url", "http://localhost:3008");
const ATLAS_USER = arg("atlas-user", "second_admin");
const ATLAS_PASS = arg("atlas-pass", "password2");

const ATLAS_AUTH = "Basic " + Buffer.from(`${ATLAS_USER}:${ATLAS_PASS}`).toString("base64");
const KAPP = "atlas";

const SYSTEM_KEYSPACES = new Set([
  "system", "system_auth", "system_schema",
  "system_distributed", "system_traces", "system_virtual_schema",
]);

/* ───── type mapping ───── */
function mapType(cqlType) {
  if (!cqlType) return "String";
  const t = cqlType.toLowerCase().replace(/<.*>/, "").replace(/frozen/, "").trim();
  switch (t) {
    case "text": case "varchar": case "ascii":
      return "String";
    case "int": case "bigint": case "smallint": case "tinyint": case "varint": case "counter":
      return "Integer";
    case "float": case "double": case "decimal":
      return "Decimal";
    case "boolean":
      return "Boolean";
    case "date":
      return "Date";
    case "timestamp":
      return "DateTime";
    case "blob":
      return "Binary";
    case "uuid": case "timeuuid":
      return "String";
    case "map": case "set": case "list": case "tuple": case "frozen":
      return "JSON";
    default:
      return "String";
  }
}

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

/* ───── scanner ───── */
async function main() {
  console.log("\n  ╔══════════════════════════════════════╗");
  console.log("  ║   Atlas Cassandra Scanner              ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log(`\n  Host:        ${HOST}:${PORT}`);
  console.log(`  Datacenter:  ${DATACENTER}`);
  console.log(`  Keyspace:    ${KEYSPACE || "(all)"}`);
  console.log(`  Atlas:       ${ATLAS_URL}\n`);

  const scanId = `SCAN-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const counts = { systems: 0, datasets: 0, fields: 0, relationships: 0, issues: 0 };

  // Verify Atlas connectivity
  console.log("  Verifying Atlas connectivity...");
  const atlasMe = await request(ATLAS_URL, "GET", "/app/api/v1/me", null, ATLAS_AUTH);
  if (atlasMe.status !== 200) {
    console.error(`  ✗ Atlas auth failed (${atlasMe.status})`);
    process.exit(1);
  }
  console.log(`  ✓ Atlas authenticated as: ${atlasMe.data.username || atlasMe.data.displayName}\n`);

  // Connect to Cassandra
  console.log("  Connecting to Cassandra...");
  const client = new cassandra.Client({
    contactPoints: [HOST],
    localDataCenter: DATACENTER,
    protocolOptions: { port: parseInt(PORT) },
    ...(USER ? { credentials: { username: USER, password: PASS } } : {}),
  });

  try {
    await client.connect();
  } catch (e) {
    console.error(`  ✗ Cassandra connection failed: ${e.message}`);
    process.exit(1);
  }
  console.log(`  ✓ Connected to Cassandra cluster\n`);

  // Discover keyspaces
  console.log("  Fetching keyspaces...");
  const ksResult = await client.execute("SELECT keyspace_name FROM system_schema.keyspaces");
  let keyspaces = ksResult.rows
    .map(r => r.keyspace_name)
    .filter(ks => !SYSTEM_KEYSPACES.has(ks));

  if (KEYSPACE) {
    keyspaces = keyspaces.filter(ks => ks === KEYSPACE);
    if (keyspaces.length === 0) {
      console.error(`  ✗ Keyspace '${KEYSPACE}' not found (or is a system keyspace)`);
      await client.shutdown();
      process.exit(1);
    }
  }

  console.log(`  Found ${keyspaces.length} keyspaces: ${keyspaces.join(", ")}\n`);

  // Create system record
  const sysName = `cassandra://${HOST}:${PORT}`;
  console.log(`  Creating system: ${sysName}`);
  await atlasPost("system", {
    Name: sysName,
    Description: `Apache Cassandra cluster at ${HOST}:${PORT}`,
    "System Type": "Database",
    Technology: "Apache Cassandra",
    Environment: "Production",
    Domain: "",
    Owner: "",
    Status: "Active",
    Tags: "cassandra,auto-scanned",
    "Connection Info": `cassandra://${HOST}:${PORT}/${DATACENTER}`,
  });
  counts.systems++;

  let totalTables = 0;

  // Scan each keyspace
  for (const ks of keyspaces) {
    console.log(`\n  ┌─ Keyspace: ${ks}`);

    // Fetch tables
    const tablesResult = await client.execute(
      "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?",
      [ks], { prepare: true }
    );
    const tables = tablesResult.rows.map(r => r.table_name);
    console.log(`  │  ${tables.length} tables`);

    for (const table of tables) {
      const dsName = `${ks}.${table}`;
      process.stdout.write(`  │  ├─ ${dsName}`);

      await atlasPost("dataset", {
        Name: dsName,
        Description: "",
        System: sysName,
        Domain: "",
        "Dataset Type": "Table",
        "Schema Name": ks,
        "Record Count": "",
        "Source of Truth": "No",
        Owner: "",
        Classification: "",
        Status: "Active",
        Tags: "cassandra,auto-scanned",
        Version: "1",
      });
      counts.datasets++;
      totalTables++;

      // Fetch columns
      const colsResult = await client.execute(
        "SELECT column_name, type, kind, position FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?",
        [ks, table], { prepare: true }
      );
      const columns = colsResult.rows;
      console.log(` (${columns.length} columns)`);

      // Fetch indexes for this table
      const idxResult = await client.execute(
        "SELECT index_name, options FROM system_schema.indexes WHERE keyspace_name = ? AND table_name = ?",
        [ks, table], { prepare: true }
      );
      const indexes = idxResult.rows;

      for (const col of columns) {
        const isPk = col.kind === "partition_key" || col.kind === "clustering";
        const nullable = isPk ? "No" : "Yes";
        let description = "";
        if (col.kind === "partition_key") description = "partition_key";
        else if (col.kind === "clustering") description = "clustering key";
        else if (col.kind === "static") description = "static column";

        await atlasPost("field", {
          Name: col.column_name,
          Description: description,
          Dataset: dsName,
          System: sysName,
          "Data Type": mapType(col.type),
          "Max Length": "",
          Nullable: nullable,
          "Primary Key": isPk ? "Yes" : "No",
          "Foreign Key Target": "",
          "Default Value": "",
          "Allowed Values": "",
          "Example Values": "",
          "Business Definition": "",
          "Glossary Term": "",
          Classification: "",
          Status: "Active",
          Tags: "cassandra,auto-scanned",
          "Sort Order": String(col.position ?? ""),
        });
        counts.fields++;

        // Detect FK references from column naming patterns
        const lname = col.column_name.toLowerCase();
        if (lname.endsWith("_id") || lname.endsWith("id") && lname !== "id" && lname.length > 2) {
          // Match *_id or *Id patterns
          const match = col.column_name.match(/^(.+?)(?:_[Ii][Dd]|Id)$/);
          if (match) {
            const target = match[1];
            await atlasPost("relationship", {
              Name: `${dsName}.${col.column_name} → ${target}`,
              "Relationship Type": "References",
              "Source Entity Type": "Field",
              "Source Entity": `${dsName}.${col.column_name}`,
              "Target Entity Type": "Dataset",
              "Target Entity": target,
              Confidence: "Auto",
              Description: "Auto-detected FK reference from column name",
              Status: "Active",
            });
            counts.relationships++;
          }
        }
      }
    }

    console.log(`  └  ✓ ${ks} complete`);
  }

  // Shutdown Cassandra client
  await client.shutdown();
  console.log(`\n  Cassandra connection closed.`);

  // Create scan-result
  const completedAt = new Date().toISOString();
  await atlasPost("scan-result", {
    "Scan ID": scanId,
    "Source Type": "Cassandra",
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
    Notes: `Scanner: ${SCANNER} (CLI) | Scanned ${keyspaces.length} keyspaces, ${totalTables} tables`,
  });

  // Change log
  await atlasPost("change-log", {
    "Entity Type": "Scan",
    "Entity ID": scanId,
    "Entity Name": `Cassandra scan: ${sysName}`,
    Action: "Scan Completed",
    "Changed By": USER || "anonymous",
    Timestamp: completedAt,
    Details: JSON.stringify(counts),
    Notes: `Scanner: ${SCANNER}`,
  });

  console.log("\n  ╔══════════════════════════════════════╗");
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
