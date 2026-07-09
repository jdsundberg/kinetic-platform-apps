/**
 * put-trees.mjs — persist CPQ workflow trees via the Task API treeJson PUT
 * (reliable path; Core-API treeXml PUT stores empty nodes on this engine).
 * Reads trees.json (produced by gen-trees.mjs). GETs each tree's current
 * versionId, then PUTs {treeJson, versionId}.
 *
 * Run gen-trees.mjs AND validate each *.xml with validate-workflow.mjs first.
 * Usage: KINETIC_URL=.. KINETIC_USER=.. KINETIC_PASS=.. node put-trees.mjs
 */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const KINETIC = process.env.KINETIC_URL || "https://ai-labs.kinopsdev.io";
const AUTH = "Basic " + Buffer.from(`${process.env.KINETIC_USER || "john"}:${process.env.KINETIC_PASS || ""}`).toString("base64");
const T = "/app/components/task/app/api/v2";

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(p, KINETIC);
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(url, { method, headers: { Authorization: AUTH, "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
      const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => { const s = Buffer.concat(c).toString(); try { resolve({ status: res.statusCode, data: JSON.parse(s) }); } catch { resolve({ status: res.statusCode, data: s }); } });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

const trees = JSON.parse(fs.readFileSync(path.join(DIR, "trees.json"), "utf-8"));
for (const t of trees) {
  const enc = encodeURIComponent(t.title);
  const cur = await req("GET", `${T}/trees/${enc}?include=treeJson`);
  if (cur.status >= 300) { console.error(`✗ GET ${t.name}: ${cur.status} ${JSON.stringify(cur.data).slice(0,160)}`); continue; }
  const versionId = String(cur.data.versionId ?? "1");
  const put = await req("PUT", `${T}/trees/${enc}`, { treeJson: t.treeJson, versionId });
  if (put.status >= 300) { console.error(`✗ PUT ${t.name}: ${put.status} ${JSON.stringify(put.data).slice(0,200)}`); continue; }
  // verify nodes landed
  const chk = await req("GET", `${T}/trees/${enc}?include=treeJson`);
  const n = (chk.data.treeJson?.nodes || []).length, c = (chk.data.treeJson?.connectors || []).length;
  console.log(`✓ ${t.name}: PUT ok (was v${versionId} → v${put.data.versionId}); stored ${n} nodes, ${c} connectors`);
}
