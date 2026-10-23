/**
 * Kinetic connection settings for the CMDB scripts.
 *
 * Reads { server, user, pass } from cmdb/kinetic-connection.json, which git
 * ignores. Copy kinetic-connection.sample.json to start one. --config PATH
 * reads another file; --server / --user / --pass override single values.
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_FILE = path.join(DIR, "kinetic-connection.json");
const SAMPLE_FILE = path.join(DIR, "kinetic-connection.sample.json");

export function loadConnection(args = process.argv.slice(2)) {
  const opt = (name) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : undefined; };
  const file = opt("config") ? path.resolve(opt("config")) : DEFAULT_FILE;

  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, "utf-8")); }
    catch (e) { fail(`Could not read ${file}: ${e.message}`); }
  } else if (!(opt("server") && opt("user") && opt("pass"))) {
    fail(`No connection file at ${file}.\n  Create it from the sample and fill in your server, user and password:\n    cp ${SAMPLE_FILE} ${DEFAULT_FILE}`);
  }

  const conn = {
    server: opt("server") || cfg.server,
    user: opt("user") || cfg.user,
    pass: opt("pass") || cfg.pass,
  };
  const missing = Object.keys(conn).filter((k) => !conn[k]);
  if (missing.length) fail(`Missing ${missing.join(", ")} in ${file} (or pass --${missing[0]}).`);

  conn.auth = "Basic " + Buffer.from(`${conn.user}:${conn.pass}`).toString("base64");
  return conn;
}

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}
