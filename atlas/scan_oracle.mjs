#!/usr/bin/env node
/**
 * Atlas Oracle Database Scanner
 * Connects to an Oracle database, discovers its structure, and writes the
 * results to the Atlas data dictionary.
 *
 * Usage:
 *   node scan_oracle.mjs \
 *     --host mydbhost --port 1521 --user system --pass secret \
 *     --service ORCL --schema HR \
 *     --atlas-url http://localhost:3008 \
 *     --atlas-user admin --atlas-pass secret
 */
import https from "node:https";
import http from "node:http";
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/* ───── oracledb import ───── */
let oracledb;
try {
  oracledb = (await import("oracledb")).default;
} catch {
  console.error("  Error: 'oracledb' package required. Install with: npm install oracledb");
  process.exit(1);
}

/* ───── arg parsing ───── */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const DB_HOST = arg("host", "localhost");
const DB_PORT = arg("port", "1521");
const DB_USER = arg("user", "system");
const DB_PASS = arg("pass", "");
const DB_SERVICE = arg("service", "ORCL");
const DB_SCHEMA = arg("schema", "");
const ATLAS_URL = arg("atlas-url", "http://localhost:3008");
const ATLAS_USER = arg("atlas-user", "second_admin");
const ATLAS_PASS = arg("atlas-pass", "password2");

const ATLAS_AUTH = "Basic " + Buffer.from(`${ATLAS_USER}:${ATLAS_PASS}`).toString("base64");
const CONNECT_STRING = `${DB_HOST}:${DB_PORT}/${DB_SERVICE}`;
const SCANNER = "scan_oracle.mjs";

/* ───── Oracle type mapping ───── */
function mapOracleType(oraType) {
  if (!oraType) return "String";
  const t = oraType.toUpperCase();
  if (t === "VARCHAR2" || t === "NVARCHAR2" || t === "CHAR" || t === "NCHAR") return "String";
  if (t === "NUMBER" || t === "FLOAT" || t === "BINARY_FLOAT" || t === "BINARY_DOUBLE") return "Decimal";
  if (t === "DATE") return "Date";
  if (t.startsWith("TIMESTAMP")) return "DateTime";
  if (t === "CLOB" || t === "NCLOB" || t === "LONG") return "Text";
  if (t === "BLOB" || t === "RAW" || t === "LONG RAW") return "Binary";
  return "String";
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
  return request(ATLAS_URL, "POST", `/app/api/v1/kapps/atlas/forms/${formSlug}/submissions`, { values }, ATLAS_AUTH);
}

/* ───── Oracle query helpers ───── */
async function query(conn, sql, binds = {}) {
  const result = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return result.rows;
}

/* ───── system schema exclusion list ───── */
const SYSTEM_SCHEMAS = [
  "SYS", "SYSTEM", "OUTLN", "DIP", "ORACLE_OCM", "DBSNMP", "APPQOSSYS",
  "WMSYS", "EXFSYS", "CTXSYS", "XDB", "ORDDATA", "ORDSYS", "MDSYS",
  "OLAPSYS", "ANONYMOUS", "LBACSYS", "ORDPLUGINS", "SI_INFORMTN_SCHEMA",
  "SYSMAN", "MGMT_VIEW", "FLOWS_FILES", "APEX_040200", "APEX_PUBLIC_USER",
];

/* ───── scanner ───── */
async function main() {
  console.log("\n  +======================================+");
  console.log("  |   Atlas Oracle Database Scanner       |");
  console.log("  +======================================+");
  console.log(`\n  Oracle:  ${CONNECT_STRING}`);
  console.log(`  User:    ${DB_USER}`);
  console.log(`  Schema:  ${DB_SCHEMA || "(all non-system)"}`);
  console.log(`  Atlas:   ${ATLAS_URL}\n`);

  const scanId = `SCAN-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const counts = { systems: 0, datasets: 0, fields: 0, relationships: 0, issues: 0 };

  // Verify Atlas connectivity
  console.log("  Verifying Atlas connectivity...");
  const atlasMe = await request(ATLAS_URL, "GET", "/app/api/v1/me", null, ATLAS_AUTH);
  if (atlasMe.status !== 200) {
    console.error(`  x Atlas auth failed (${atlasMe.status})`);
    process.exit(1);
  }
  console.log(`  + Atlas authenticated as: ${atlasMe.data.username || atlasMe.data.displayName}`);

  // Connect to Oracle
  console.log("  Connecting to Oracle...");
  let conn;
  try {
    conn = await oracledb.getConnection({
      user: DB_USER,
      password: DB_PASS,
      connectString: CONNECT_STRING,
    });
  } catch (err) {
    console.error(`  x Oracle connection failed: ${err.message}`);
    process.exit(1);
  }
  console.log(`  + Connected to Oracle at ${CONNECT_STRING}\n`);

  // Create system record
  const systemName = `${DB_SERVICE}@${DB_HOST}:${DB_PORT}`;
  await atlasPost("system", {
    Name: systemName,
    Description: `Oracle database instance: ${CONNECT_STRING}`,
    "System Type": "Database",
    Technology: "Oracle",
    Environment: "Production",
    Domain: "",
    Owner: "",
    Status: "Active",
    Tags: "oracle,auto-scanned",
    "Connection Info": `oracle://${DB_HOST}:${DB_PORT}/${DB_SERVICE}`,
  });
  counts.systems++;
  console.log(`  + System: ${systemName}\n`);

  // Discover schemas
  let schemas;
  if (DB_SCHEMA) {
    schemas = DB_SCHEMA.split(",").map(s => s.trim().toUpperCase());
    console.log(`  Using specified schema(s): ${schemas.join(", ")}`);
  } else {
    const placeholders = SYSTEM_SCHEMAS.map((_, i) => `:s${i}`).join(",");
    const binds = {};
    SYSTEM_SCHEMAS.forEach((s, i) => { binds[`s${i}`] = s; });
    const rows = await query(
      conn,
      `SELECT DISTINCT owner FROM all_tables WHERE owner NOT IN (${placeholders}) ORDER BY owner`,
      binds,
    );
    schemas = rows.map(r => r.OWNER);
    console.log(`  Found ${schemas.length} schema(s): ${schemas.join(", ")}`);
  }
  console.log("");

  let tableCount = 0;

  for (const schema of schemas) {
    console.log(`  +-- Schema: ${schema}`);

    // Tables
    const tables = await query(
      conn,
      `SELECT table_name FROM all_tables WHERE owner = :schema ORDER BY table_name`,
      { schema },
    );

    // Views
    const views = await query(
      conn,
      `SELECT view_name FROM all_views WHERE owner = :schema ORDER BY view_name`,
      { schema },
    );

    const datasets = [
      ...tables.map(r => ({ name: r.TABLE_NAME, type: "Table" })),
      ...views.map(r => ({ name: r.VIEW_NAME, type: "View" })),
    ];

    console.log(`  |  ${tables.length} tables, ${views.length} views`);
    tableCount += tables.length + views.length;

    for (const ds of datasets) {
      const dsName = `${schema}.${ds.name}`;
      process.stdout.write(`  |  +-- ${dsName}`);

      await atlasPost("dataset", {
        Name: dsName,
        Description: "",
        System: systemName,
        Domain: "",
        "Dataset Type": ds.type,
        "Schema Name": schema,
        "Record Count": "",
        "Source of Truth": "No",
        Owner: "",
        Classification: "",
        Status: "Active",
        Tags: "oracle,auto-scanned",
        Version: "1",
      });
      counts.datasets++;

      // Columns
      const columns = await query(
        conn,
        `SELECT column_name, data_type, data_length, nullable, data_default, column_id
         FROM all_tab_columns
         WHERE owner = :schema AND table_name = :table
         ORDER BY column_id`,
        { schema, table: ds.name },
      );

      // Primary key columns
      const pkRows = await query(
        conn,
        `SELECT cols.column_name
         FROM all_constraints cons
         JOIN all_cons_columns cols
           ON cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner
         WHERE cons.constraint_type = 'P'
           AND cons.owner = :schema
           AND cons.table_name = :table`,
        { schema, table: ds.name },
      );
      const pkSet = new Set(pkRows.map(r => r.COLUMN_NAME));

      // Foreign keys
      const fkRows = await query(
        conn,
        `SELECT a.column_name,
                c_pk.owner AS target_schema,
                c_pk.table_name AS target_table,
                b.column_name AS target_column
         FROM all_cons_columns a
         JOIN all_constraints c
           ON a.constraint_name = c.constraint_name AND a.owner = c.owner
         JOIN all_constraints c_pk
           ON c.r_constraint_name = c_pk.constraint_name AND c.r_owner = c_pk.owner
         JOIN all_cons_columns b
           ON c_pk.constraint_name = b.constraint_name AND c_pk.owner = b.owner
         WHERE c.constraint_type = 'R'
           AND c.owner = :schema
           AND c.table_name = :table`,
        { schema, table: ds.name },
      );
      const fkMap = {};
      for (const fk of fkRows) {
        fkMap[fk.COLUMN_NAME] = {
          targetSchema: fk.TARGET_SCHEMA,
          targetTable: fk.TARGET_TABLE,
          targetColumn: fk.TARGET_COLUMN,
        };
      }

      console.log(` (${columns.length} cols)`);

      for (const col of columns) {
        const isPk = pkSet.has(col.COLUMN_NAME);
        const fk = fkMap[col.COLUMN_NAME];
        const fkTarget = fk ? `${fk.targetSchema}.${fk.targetTable}.${fk.targetColumn}` : "";

        await atlasPost("field", {
          Name: col.COLUMN_NAME,
          Description: "",
          Dataset: dsName,
          System: systemName,
          "Data Type": mapOracleType(col.DATA_TYPE),
          "Max Length": col.DATA_LENGTH != null ? String(col.DATA_LENGTH) : "",
          Nullable: col.NULLABLE === "Y" ? "Yes" : "No",
          "Primary Key": isPk ? "Yes" : "No",
          "Foreign Key Target": fkTarget,
          "Default Value": col.DATA_DEFAULT ? String(col.DATA_DEFAULT).trim() : "",
          "Allowed Values": "",
          "Example Values": "",
          "Business Definition": "",
          "Glossary Term": "",
          Classification: "",
          Status: "Active",
          Tags: "oracle,auto-scanned",
          "Sort Order": col.COLUMN_ID != null ? String(col.COLUMN_ID) : "",
        });
        counts.fields++;

        // Create relationship record for FK
        if (fk) {
          await atlasPost("relationship", {
            Name: `${dsName}.${col.COLUMN_NAME} -> ${fk.targetSchema}.${fk.targetTable}`,
            "Relationship Type": "PK-FK",
            "Source Entity Type": "Field",
            "Source Entity": `${dsName}.${col.COLUMN_NAME}`,
            "Target Entity Type": "Dataset",
            "Target Entity": `${fk.targetSchema}.${fk.targetTable}`,
            Confidence: "High",
            Description: `FK from ${dsName}.${col.COLUMN_NAME} to ${fk.targetSchema}.${fk.targetTable}.${fk.targetColumn}`,
            Status: "Active",
          });
          counts.relationships++;
        }
      }
    }

    console.log(`  +  + ${schema} complete\n`);
  }

  // Close Oracle connection
  try {
    await conn.close();
    console.log("  + Oracle connection closed");
  } catch (err) {
    console.error(`  x Error closing Oracle connection: ${err.message}`);
  }

  // Scan result
  const completedAt = new Date().toISOString();
  await atlasPost("scan-result", {
    "Scan ID": scanId,
    "Source Type": "Oracle",
    "Source Name": CONNECT_STRING,
    "Scan Status": "Completed",
    "Started At": startedAt,
    "Completed At": completedAt,
    "Systems Found": String(counts.systems),
    "Datasets Found": String(counts.datasets),
    "Fields Found": String(counts.fields),
    "Relationships Found": String(counts.relationships),
    "Issues Found": String(counts.issues),
    "Scanned By": DB_USER,
    Notes: `Scanner: ${SCANNER} (CLI) | Scanned ${schemas.length} schemas, ${tableCount} tables`,
  });

  // Change log
  await atlasPost("change-log", {
    "Entity Type": "Scan",
    "Entity ID": scanId,
    "Entity Name": `Oracle scan: ${CONNECT_STRING}`,
    Action: "Scan Completed",
    "Changed By": DB_USER,
    Timestamp: completedAt,
    Details: JSON.stringify(counts),
    Notes: `Scanner: ${SCANNER}`,
  });

  console.log("\n  +======================================+");
  console.log("  |   Scan Complete                       |");
  console.log("  +======================================+");
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
