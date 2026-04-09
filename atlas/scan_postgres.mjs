#!/usr/bin/env node
/**
 * Atlas PostgreSQL Scanner
 * Connects to a PostgreSQL database, discovers its structure, and writes
 * the results to the Atlas data dictionary.
 *
 * Usage:
 *   node scan_postgres.mjs \
 *     --host localhost --port 5432 \
 *     --user postgres --pass secret \
 *     --database mydb \
 *     --schema public \
 *     --atlas-url http://localhost:3008 \
 *     --atlas-user admin --atlas-pass secret
 */
import https from "node:https";
import http from "node:http";
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const SCANNER = "scan_postgres.mjs";

/* ───── pg driver import ───── */
let pg;
try {
  pg = (await import("pg")).default;
} catch {
  console.error("\n  Error: 'pg' package required. Install with: npm install pg\n");
  process.exit(1);
}

/* ───── arg parsing ───── */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const PG_HOST = arg("host", "localhost");
const PG_PORT = arg("port", "5432");
const PG_USER = arg("user", "postgres");
const PG_PASS = arg("pass", "");
const PG_DATABASE = arg("database", "postgres");
const PG_SCHEMA = arg("schema", "");
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

/* ───── data type mapping ───── */
function mapDataType(pgType) {
  const t = pgType.toLowerCase();
  if (t === "integer" || t === "int4" || t === "int2" || t === "int8"
      || t === "smallint" || t === "bigint") return "Integer";
  if (t === "boolean" || t === "bool") return "Boolean";
  if (t === "numeric" || t === "decimal" || t === "real"
      || t === "double precision" || t === "float4" || t === "float8") return "Decimal";
  if (t === "text") return "Text";
  if (t === "character varying" || t === "varchar" || t === "character"
      || t === "char" || t === "bpchar" || t === "name") return "String";
  if (t.startsWith("timestamp") || t === "date") return "DateTime";
  if (t.startsWith("time")) return "DateTime";
  if (t === "json" || t === "jsonb") return "JSON";
  if (t === "bytea") return "Binary";
  if (t === "uuid") return "String";
  if (t === "inet" || t === "cidr" || t === "macaddr") return "String";
  if (t === "xml") return "Text";
  if (t === "money") return "Decimal";
  if (t === "interval") return "String";
  if (t.endsWith("[]")) return "String";       // arrays
  if (t === "oid") return "Integer";
  if (t === "serial" || t === "bigserial" || t === "smallserial") return "Integer";
  if (t === "tsvector" || t === "tsquery") return "Text";
  return "String";
}

/* ───── scanner ───── */
async function main() {
  const connStr = `postgresql://${PG_HOST}:${PG_PORT}/${PG_DATABASE}`;
  const sysName = `${PG_DATABASE}@${PG_HOST}:${PG_PORT}`;

  console.log("\n  +======================================+");
  console.log("  |   Atlas PostgreSQL Scanner            |");
  console.log("  +======================================+");
  console.log(`\n  Host:      ${PG_HOST}:${PG_PORT}`);
  console.log(`  Database:  ${PG_DATABASE}`);
  console.log(`  Schema:    ${PG_SCHEMA || "(all non-system)"}`);
  console.log(`  Atlas:     ${ATLAS_URL}\n`);

  const scanId = `SCAN-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const counts = { systems: 0, datasets: 0, fields: 0, relationships: 0, issues: 0 };

  // Connect to PostgreSQL
  console.log("  Connecting to PostgreSQL...");
  const client = new pg.Client({
    host: PG_HOST,
    port: parseInt(PG_PORT, 10),
    user: PG_USER,
    password: PG_PASS,
    database: PG_DATABASE,
  });

  try {
    await client.connect();
  } catch (e) {
    console.error(`  x Connection failed: ${e.message}`);
    process.exit(1);
  }
  console.log(`  + Connected to ${PG_DATABASE} as ${PG_USER}`);

  // Verify Atlas connectivity
  console.log("  Verifying Atlas connectivity...");
  const atlasMe = await request(ATLAS_URL, "GET", "/app/api/v1/me", null, ATLAS_AUTH);
  if (atlasMe.status !== 200) {
    console.error(`  x Atlas auth failed (${atlasMe.status})`);
    await client.end();
    process.exit(1);
  }
  console.log(`  + Atlas authenticated as: ${atlasMe.data.username || atlasMe.data.displayName}\n`);

  // Query schemas
  let schemaFilter;
  if (PG_SCHEMA) {
    schemaFilter = [PG_SCHEMA];
  } else {
    const schemaRes = await client.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       ORDER BY schema_name`
    );
    schemaFilter = schemaRes.rows.map(r => r.schema_name);
  }
  console.log(`  Found ${schemaFilter.length} schema(s): ${schemaFilter.join(", ")}\n`);

  // Create system record
  console.log(`  Creating system: ${sysName}`);
  await atlasPost("system", {
    Name: sysName,
    Description: `PostgreSQL database: ${PG_DATABASE}`,
    "System Type": "Database",
    Technology: "PostgreSQL",
    Environment: "Production",
    Domain: "",
    Owner: "",
    Status: "Active",
    Tags: "postgresql,auto-scanned",
    "Connection Info": connStr,
  });
  counts.systems++;

  let totalTableCount = 0;

  for (const schema of schemaFilter) {
    console.log(`  +-- Schema: ${schema}`);

    // Query tables
    const tablesRes = await client.query(
      `SELECT table_name, table_type
       FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [schema]
    );
    const tables = tablesRes.rows;
    console.log(`  |  ${tables.length} tables/views`);
    totalTableCount += tables.length;

    for (const tbl of tables) {
      const dsType = tbl.table_type === "VIEW" ? "View" : "Table";
      const dsName = `${schema}.${tbl.table_name}`;
      process.stdout.write(`  |  +-- ${dsName} (${dsType})`);

      // Create dataset
      await atlasPost("dataset", {
        Name: dsName,
        Description: "",
        System: sysName,
        Domain: "",
        "Dataset Type": dsType,
        "Schema Name": schema,
        "Record Count": "",
        "Source of Truth": "",
        Owner: "",
        Classification: "",
        Status: "Active",
        Tags: "postgresql,auto-scanned",
        Version: "1",
      });
      counts.datasets++;

      // Query columns
      const colsRes = await client.query(
        `SELECT column_name, data_type, character_maximum_length,
                is_nullable, column_default, ordinal_position
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, tbl.table_name]
      );
      const columns = colsRes.rows;
      console.log(` (${columns.length} columns)`);

      // Query primary keys
      const pkRes = await client.query(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = $1
           AND tc.table_name = $2`,
        [schema, tbl.table_name]
      );
      const pkColumns = new Set(pkRes.rows.map(r => r.column_name));

      // Query foreign keys
      const fkRes = await client.query(
        `SELECT kcu.column_name,
                ccu.table_schema,
                ccu.table_name,
                ccu.column_name AS target_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = $1
           AND tc.table_name = $2`,
        [schema, tbl.table_name]
      );
      const fkMap = new Map();
      for (const fk of fkRes.rows) {
        fkMap.set(fk.column_name, {
          targetSchema: fk.table_schema,
          targetTable: fk.table_name,
          targetColumn: fk.target_column,
        });
      }

      // Create field records
      for (const col of columns) {
        const fkInfo = fkMap.get(col.column_name);
        const fkTarget = fkInfo
          ? `${fkInfo.targetSchema}.${fkInfo.targetTable}.${fkInfo.targetColumn}`
          : "";

        await atlasPost("field", {
          Name: col.column_name,
          Description: "",
          Dataset: dsName,
          System: sysName,
          "Data Type": mapDataType(col.data_type),
          "Max Length": col.character_maximum_length != null ? String(col.character_maximum_length) : "",
          Nullable: col.is_nullable,
          "Primary Key": pkColumns.has(col.column_name) ? "Yes" : "No",
          "Foreign Key Target": fkTarget,
          "Default Value": col.column_default || "",
          "Allowed Values": "",
          "Example Values": "",
          "Business Definition": "",
          "Glossary Term": "",
          Classification: "",
          Status: "Active",
          Tags: "postgresql,auto-scanned",
          "Sort Order": String(col.ordinal_position),
        });
        counts.fields++;
      }

      // Create relationship records for FKs
      for (const [colName, fk] of fkMap) {
        await atlasPost("relationship", {
          Name: `${dsName}.${colName} -> ${fk.targetSchema}.${fk.targetTable}`,
          "Relationship Type": "PK-FK",
          "Source Entity Type": "Field",
          "Source Entity": `${dsName}.${colName}`,
          "Target Entity Type": "Dataset",
          "Target Entity": `${fk.targetSchema}.${fk.targetTable}`,
          Confidence: "High",
          Description: `FK: ${colName} references ${fk.targetTable}.${fk.targetColumn}`,
          Status: "Active",
        });
        counts.relationships++;
      }
    }

    console.log(`  |  + ${schema} complete\n`);
  }

  // Disconnect from PostgreSQL
  await client.end();
  console.log("  Disconnected from PostgreSQL\n");

  // Create scan-result
  const completedAt = new Date().toISOString();
  await atlasPost("scan-result", {
    "Scan ID": scanId,
    "Source Type": "PostgreSQL",
    "Source Name": connStr,
    "Scan Status": "Completed",
    "Started At": startedAt,
    "Completed At": completedAt,
    "Systems Found": String(counts.systems),
    "Datasets Found": String(counts.datasets),
    "Fields Found": String(counts.fields),
    "Relationships Found": String(counts.relationships),
    "Issues Found": String(counts.issues),
    "Scanned By": PG_USER,
    Notes: `Scanner: ${SCANNER} (CLI) | Scanned ${schemaFilter.length} schemas, ${totalTableCount} tables`,
  });

  // Change log
  await atlasPost("change-log", {
    "Entity Type": "Scan",
    "Entity ID": scanId,
    "Entity Name": `PostgreSQL scan: ${connStr}`,
    Action: "Scan Completed",
    "Changed By": PG_USER,
    Timestamp: completedAt,
    Details: JSON.stringify(counts),
    Notes: `Scanner: ${SCANNER}`,
  });

  console.log("  +======================================+");
  console.log("  |   Scan Complete                       |");
  console.log("  +======================================+");
  console.log(`  Scan ID:       ${scanId}`);
  console.log(`  Systems:       ${counts.systems}`);
  console.log(`  Datasets:      ${counts.datasets}`);
  console.log(`  Fields:        ${counts.fields}`);
  console.log(`  Relationships: ${counts.relationships}`);
  console.log(`  Duration:      ${((new Date(completedAt) - new Date(startedAt)) / 1000).toFixed(1)}s\n`);
}

main().catch(async e => {
  console.error(`  x Scanner failed: ${e.message}`);
  process.exit(1);
});
