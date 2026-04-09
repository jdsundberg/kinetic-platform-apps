# Atlas Scanners

Standalone CLI scripts that discover data structure from external systems and populate the Atlas data dictionary.

## Usage Pattern

All scanners follow the same pattern:

```bash
node scan_{type}.mjs --host <host> --port <port> --user <user> --pass <pass> \
  --atlas-url http://localhost:3008 --atlas-user second_admin --atlas-pass password2
```

Each scanner writes to Atlas via HTTP POST to the proxy server, creating:
- **System** — one per source instance
- **Dataset** — one per table/collection/form
- **Field** — one per column/field
- **Relationship** — one per FK or detected reference
- **Scan Result** — summary record with counts and timing
- **Change Log** — audit entry for the scan

## Scanners

### scan_kinetic.mjs — Kinetic Platform

No external dependencies. Introspects kapps, forms, and fields via the Kinetic REST API.

```bash
node scan_kinetic.mjs \
  --url https://second.jdsultra1.lan \
  --user second_admin --pass password2 \
  --atlas-url http://localhost:3008 \
  --atlas-user second_admin --atlas-pass password2
```

| Arg | Default | Description |
|-----|---------|-------------|
| `--url` | `https://second.jdsultra1.lan` | Source Kinetic Platform URL |
| `--user` | `second_admin` | Source credentials |
| `--pass` | `password2` | Source credentials |
| `--atlas-url` | `http://localhost:3008` | Atlas server URL |
| `--atlas-user` | `second_admin` | Atlas credentials |
| `--atlas-pass` | `password2` | Atlas credentials |

**Discovers**: Kapps → Forms → Fields. Detects FK references from field names ending in `_id` or ` id`.

---

### scan_postgres.mjs — PostgreSQL

Requires: `npm install pg`

```bash
node scan_postgres.mjs \
  --host localhost --port 5432 \
  --user postgres --pass secret \
  --database mydb --schema public \
  --atlas-url http://localhost:3008 \
  --atlas-user second_admin --atlas-pass password2
```

| Arg | Default | Description |
|-----|---------|-------------|
| `--host` | `localhost` | PostgreSQL host |
| `--port` | `5432` | PostgreSQL port |
| `--user` | `postgres` | Database user |
| `--pass` | `""` | Database password |
| `--database` | `postgres` | Database name |
| `--schema` | `""` (all) | Specific schema, or all non-system schemas |
| `--atlas-url` | `http://localhost:3008` | Atlas server URL |
| `--atlas-user` | `second_admin` | Atlas credentials |
| `--atlas-pass` | `password2` | Atlas credentials |

**Discovers**: Schemas → Tables/Views → Columns (via `information_schema`). Extracts PKs and FKs from constraint metadata. Maps PostgreSQL types to Atlas types (integer, varchar, timestamp, jsonb, etc.).

---

### scan_oracle.mjs — Oracle

Requires: `npm install oracledb`

```bash
node scan_oracle.mjs \
  --host dbhost --port 1521 \
  --user system --pass secret \
  --service ORCL --schema HR \
  --atlas-url http://localhost:3008 \
  --atlas-user second_admin --atlas-pass password2
```

| Arg | Default | Description |
|-----|---------|-------------|
| `--host` | `localhost` | Oracle host |
| `--port` | `1521` | Oracle port |
| `--user` | `system` | Database user |
| `--pass` | `""` | Database password |
| `--service` | `ORCL` | Oracle service name |
| `--schema` | `""` (all) | Specific schema, or all non-system schemas |
| `--atlas-url` | `http://localhost:3008` | Atlas server URL |
| `--atlas-user` | `second_admin` | Atlas credentials |
| `--atlas-pass` | `password2` | Atlas credentials |

**Discovers**: Schemas (owners) → Tables/Views → Columns (via `all_tables`, `all_tab_columns`). Extracts PKs and FKs from `all_constraints`/`all_cons_columns`. Maps Oracle types (VARCHAR2, NUMBER, DATE, CLOB, BLOB, etc.). Uses bind variables for all queries.

---

### scan_mongodb.mjs — MongoDB

Requires: `npm install mongodb`

```bash
node scan_mongodb.mjs \
  --host localhost --port 27017 \
  --user admin --pass secret \
  --database mydb --sample-size 100 \
  --atlas-url http://localhost:3008 \
  --atlas-user second_admin --atlas-pass password2
```

| Arg | Default | Description |
|-----|---------|-------------|
| `--host` | `localhost` | MongoDB host |
| `--port` | `27017` | MongoDB port |
| `--user` | `""` | MongoDB user (optional) |
| `--pass` | `""` | MongoDB password (optional) |
| `--database` | `""` (all) | Specific database, or all non-system databases |
| `--sample-size` | `100` | Documents to sample per collection |
| `--atlas-url` | `http://localhost:3008` | Atlas server URL |
| `--atlas-user` | `second_admin` | Atlas credentials |
| `--atlas-pass` | `password2` | Atlas credentials |

**Discovers**: Databases → Collections → Fields (by sampling documents). Infers schema from sampled documents — walks fields up to 2 levels deep with dot notation, tracks type frequency and nullability. Detects references from `*_id`/`*Id` field naming. Reports estimated document counts.

---

### scan_cassandra.mjs — Apache Cassandra

Requires: `npm install cassandra-driver`

```bash
node scan_cassandra.mjs \
  --host localhost --port 9042 \
  --user cassandra --pass cassandra \
  --datacenter datacenter1 --keyspace mykeyspace \
  --atlas-url http://localhost:3008 \
  --atlas-user second_admin --atlas-pass password2
```

| Arg | Default | Description |
|-----|---------|-------------|
| `--host` | `localhost` | Cassandra contact point |
| `--port` | `9042` | Native transport port |
| `--user` | `""` | Cassandra user (optional) |
| `--pass` | `""` | Cassandra password (optional) |
| `--datacenter` | `datacenter1` | Local datacenter name |
| `--keyspace` | `""` (all) | Specific keyspace, or all non-system keyspaces |
| `--atlas-url` | `http://localhost:3008` | Atlas server URL |
| `--atlas-user` | `second_admin` | Atlas credentials |
| `--atlas-pass` | `password2` | Atlas credentials |

**Discovers**: Keyspaces → Tables → Columns (via `system_schema` tables). Distinguishes column kinds: partition_key, clustering, regular, static. Maps CQL types (text, int, bigint, timestamp, uuid, map, set, list, etc.). Detects references from naming conventions.

---

### scan_couchdb.mjs — CouchDB

No external dependencies. Uses the CouchDB HTTP/JSON API directly.

```bash
node scan_couchdb.mjs \
  --host localhost --port 5984 \
  --user admin --pass secret \
  --database mydb --sample-size 50 \
  --atlas-url http://localhost:3008 \
  --atlas-user second_admin --atlas-pass password2
```

| Arg | Default | Description |
|-----|---------|-------------|
| `--host` | `localhost` | CouchDB host |
| `--port` | `5984` | CouchDB port |
| `--user` | `admin` | CouchDB user |
| `--pass` | `""` | CouchDB password |
| `--database` | `""` (all) | Specific database, or all non-system databases |
| `--sample-size` | `50` | Documents to sample per database |
| `--atlas-url` | `http://localhost:3008` | Atlas server URL |
| `--atlas-user` | `second_admin` | Atlas credentials |
| `--atlas-pass` | `password2` | Atlas credentials |

**Discovers**: Databases → Documents (sampled) → Fields. Infers schema from sampled documents — walks fields up to 2 levels deep, skips `_rev`, marks `_id` as PK. Reports document counts from DB info. Detects references from naming conventions. URL-encodes database names for special characters.

## Provenance Tracking

All scanners record:
- **Scanned By** — the username that ran the scan
- **Source Type** — the database/platform type (e.g., "PostgreSQL", "MongoDB")
- **Notes** — includes `Scanner: {script_name} (CLI)` to identify the tool and execution method

The in-app scanner (Admin tab → POST `/api/atlas/scan/kinetic`) records `Scanner: server.mjs (internal)` to distinguish from CLI runs.

## Adding New Scanners

To add a scanner for a new source type:

1. Copy `scan_kinetic.mjs` or `scan_couchdb.mjs` as a template
2. Implement the source-specific discovery logic
3. Write System, Dataset, Field, and Relationship records using `atlasPost()`
4. Set `Source Type` to your new type name
5. Record the scanner name in Notes: `Scanner: scan_{type}.mjs (CLI)`
6. Add the scanner to this file
