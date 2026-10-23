/**
 * Deploy a BillysBoatWorks workflow tree.
 *   1. ensure the form workflow record exists (Core API)
 *   2. convert the validated treeXml -> treeJson
 *   3. PUT treeJson via the TASK API (Core-API treeXml PUT returns 200 but stores zero nodes)
 *   4. read it back and refuse to report success unless nodes/connectors survived
 * Usage: node deploy.mjs <form> <xmlFile> "<workflow name>" "<event>"
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = process.env.KINETIC_URL || "https://ai-labs.kinopsdev.io";
const AUTH = "Basic " + Buffer.from(`${process.env.KINETIC_USER || "john"}:${process.env.KINETIC_PASS || ""}`).toString("base64");
const KAPP = "billys";
const [form, xmlFile, wfName, wfEvent] = process.argv.slice(2);
if (!form || !xmlFile || !wfName || !wfEvent) { console.error("usage: deploy.mjs <form> <xml> <name> <event>"); process.exit(1); }

const api = async (p, method = "GET", body) => {
  const r = await fetch(SERVER + p, {
    method, headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let d = {}; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t.slice(0, 300) }; }
  return { status: r.status, data: d };
};

/* ── treeXml -> treeJson ── */
const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
function xmlToTreeJson(xml) {
  const nodes = [], connectors = [];
  // anchor on a word start: a bare /id="/ also matches definition_id=" and dependsOnId=",
  // which silently gave every node its definitionId as its id
  const attr = (a, n) => (new RegExp(`(?:^|\\s)${n}="([^"]*)"`).exec(a) || [, ""])[1];
  // <dependents> contains nested <task> elements, so a non-greedy match to the first
  // </task> truncates the node body. Walk tags and track depth instead.
  const tagRe = /<task(\s[^>]*)?>|<\/task>/g;
  let m, depth = 0, openAttrs = null, bodyStart = 0;
  while ((m = tagRe.exec(xml)) !== null) {
    const isOpen = !m[0].startsWith("</");
    if (isOpen) {
      if (depth === 0) { openAttrs = m[1] || ""; bodyStart = m.index + m[0].length; }
      depth++;
      continue;
    }
    depth--;
    if (depth !== 0) continue;
    const a = openAttrs, body = xml.slice(bodyStart, m.index);
    if (!/definition_id="/.test(a)) continue;      // skip dependent <task> refs
    const id = attr(a, "id");
    const params = [];
    // require whitespace after the tag name: /<parameter[^>]*>/ also matches the
    // <parameters> container ([^>]* = "s"), which swallowed the first real parameter
    const pRe = /<parameter\s([^>]*)>([\s\S]*?)<\/parameter>/g;
    let pm;
    while ((pm = pRe.exec(body)) !== null) {
      const pa = pm[1];
      params.push({ dependsOnId: attr(pa, "dependsOnId"), dependsOnValue: attr(pa, "dependsOnValue"),
        description: "", id: attr(pa, "id"), label: attr(pa, "label"), menu: attr(pa, "menu"),
        value: dec(pm[2]), required: attr(pa, "required") === "true" });
    }
    const txt = (t) => (new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(body) || [, ""])[1].trim();
    const deps = [];
    const depBlock = /<dependents>([\s\S]*?)<\/dependents>/.exec(body);
    if (depBlock) {
      const dRe = /<task([^>]*)>([^<]+)<\/task>/g;
      let dm;
      while ((dm = dRe.exec(depBlock[1])) !== null) {
        const d = { label: dec(attr(dm[1], "label")), type: attr(dm[1], "type") || "Complete",
          value: dec(attr(dm[1], "value")), content: dm[2].trim() };
        deps.push(d);
        connectors.push({ from: id, to: d.content, label: d.label, value: d.value, type: d.type });
      }
    }
    nodes.push({
      configured: true,
      defers: txt("defers") === "true",
      deferrable: txt("deferrable") === "true",
      visible: txt("visible") !== "false",
      name: attr(a, "name"),
      messages: [],
      dependents: deps.length ? { task: deps } : "",
      id,
      position: { x: +attr(a, "x") || 0, y: +attr(a, "y") || 0 },
      version: 1,
      parameters: params,
      definitionId: attr(a, "definition_id"),
    });
  }
  const lastId = Math.max(0, ...nodes.map(n => +((/_(\d+)$/.exec(n.id) || [, 0])[1])));
  const name = (/<taskTree[\s\S]*?<name>([\s\S]*?)<\/name>/.exec(xml) || [, wfName])[1].trim();
  const notes = (/<notes>([\s\S]*?)<\/notes>/.exec(xml) || [, ""])[1].trim();
  // tree-level `version` is a STRING on the engine ("1"); a number throws
  // java.lang.Long cannot be cast to java.lang.String. node.version stays an int.
  return { builderVersion: "", schemaVersion: "1.0", version: "1", processOwnerEmail: "",
    lastId, name, notes, connectors, nodes };
}

const xml = fs.readFileSync(path.resolve(__dir, xmlFile), "utf8");
const treeJson = xmlToTreeJson(xml);
console.log(`parsed ${treeJson.nodes.length} nodes, ${treeJson.connectors.length} connectors`);

// 1. find or create the workflow record
let list = await api(`/app/api/v1/kapps/${KAPP}/forms/${form}/workflows`);
let wf = (list.data.workflows || []).find(w => w.name === wfName && w.event === wfEvent);
if (!wf) {
  const c = await api(`/app/api/v1/kapps/${KAPP}/forms/${form}/workflows`, "POST",
    { name: wfName, event: wfEvent, status: "Active", filter: "" });
  if (c.status >= 300) { console.error("create failed:", c.status, JSON.stringify(c.data).slice(0, 300)); process.exit(1); }
  wf = c.data.workflow || c.data;
  console.log(`created workflow record ${wf.id}`);
} else console.log(`reusing workflow record ${wf.id}`);

const title = `Kinetic Request CE :: ${wf.id} :: ${wfName}`;
const enc = encodeURIComponent(title);

// 2. PUT the tree content through the TASK API
const cur = await api(`/app/components/task/app/api/v2/trees/${enc}`);
const versionId = (cur.data.tree || cur.data || {}).versionId;
const put = await api(`/app/components/task/app/api/v2/trees/${enc}`, "PUT", { treeJson, versionId });
console.log(`task-api PUT: ${put.status}`);
if (put.status >= 300) { console.error(JSON.stringify(put.data).slice(0, 400)); process.exit(1); }

// 3. read back — a 200 that stored nothing is the failure mode this guards against
const back = await api(`/app/components/task/app/api/v2/trees/${enc}?include=treeJson`);
let tj = (back.data.tree || back.data).treeJson;
if (typeof tj === "string") tj = JSON.parse(tj);
const n = (tj?.nodes || []).length, c2 = (tj?.connectors || []).length;
console.log(`stored: ${n} nodes, ${c2} connectors`);
if (n !== treeJson.nodes.length || c2 !== treeJson.connectors.length) {
  console.error(`✗ MISMATCH — sent ${treeJson.nodes.length}/${treeJson.connectors.length}, stored ${n}/${c2}`);
  process.exit(1);
}
console.log(`✓ ${title}`);
