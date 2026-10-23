/**
 * deploy-trees.mjs — idempotently register + persist the trees in trees.json (from gen-trees.mjs).
 *   WebAPI:  Core POST /kapps/{k}/webApis  → Task POST/PUT tree "Kinetic Request CE :: WebApis > {k} :: {slug}"
 *   Event:   Core POST /kapps/{k}/forms/{f}/workflows {name,event} → Task PUT {treeJson, versionId} on
 *            "Kinetic Request CE :: {workflowId} :: {name}"   (treeJson, never Core treeXml — see workflow-xml skill)
 * Verifies every tree by reading it back and comparing node/connector counts.
 * PRECONDITION: node workflows/gen-trees.mjs && validate-workflow.mjs on every *.xml (the repo's mandatory gate).
 */
import fs from "node:fs";
import path from "node:path";
import { core, task, KAPP, ok } from "../deploy/lib.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const trees = JSON.parse(fs.readFileSync(path.join(DIR, "trees.json"), "utf-8"));
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

for (const t of trees) {
  if (only.length && !only.includes(t.file)) continue;
  let title;
  if (t.kind === "webapi") {
    let r = await core("POST", `/kapps/${KAPP}/webApis`, { slug: t.slug, method: "POST" });
    if (!ok(r) && !/unique|exist/i.test(JSON.stringify(r.data))) { console.log(`✗ webApi ${t.slug} ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); continue; }
    const sp = await core("PUT", `/kapps/${KAPP}/webApis/${t.slug}`, { slug: t.slug, method: "POST", securityPolicies: [{ endpoint: "Execution", name: "NOC Integration" }] });
    console.log(`${ok(sp) ? "✓" : "✗"} webApi ${t.slug} security policy Execution=NOC Integration ${ok(sp) ? "" : sp.status + " " + JSON.stringify(sp.data).slice(0, 200)}`);
    title = `Kinetic Request CE :: WebApis > ${KAPP} :: ${t.slug}`;
    const cur = await task("GET", `/trees/${encodeURIComponent(title)}`);
    if (cur.status === 404) {
      r = await task("POST", "/trees", { sourceName: "Kinetic Request CE", sourceGroup: `WebApis > ${KAPP}`, name: t.slug, type: "Tree", status: "Active", treeJson: t.treeJson });
      if (!ok(r)) { console.log(`✗ create tree ${t.slug} ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); continue; }
    }
  } else {
    const list = await core("GET", `/kapps/${KAPP}/forms/${t.form}/workflows`);
    let wf = (list.data.workflows || []).find((w) => w.name === t.name);
    if (!wf) {
      const r = await core("POST", `/kapps/${KAPP}/forms/${t.form}/workflows`, { name: t.name, event: t.event, type: "Tree", status: "Active" });
      if (!ok(r)) { console.log(`✗ workflow ${t.name} ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); continue; }
      wf = r.data.workflow || r.data;
    }
    title = `Kinetic Request CE :: ${wf.id} :: ${t.name}`;
  }
  const enc = encodeURIComponent(title);
  const cur = await task("GET", `/trees/${enc}?include=treeJson`);
  if (!ok(cur)) { console.log(`✗ GET ${title} ${cur.status} ${JSON.stringify(cur.data).slice(0, 200)}`); continue; }
  const put = await task("PUT", `/trees/${enc}`, { treeJson: t.treeJson, versionId: String(cur.data.versionId ?? "0") });
  if (!ok(put)) { console.log(`✗ PUT ${title} ${put.status} ${JSON.stringify(put.data).slice(0, 300)}`); continue; }
  const chk = await task("GET", `/trees/${enc}?include=treeJson`);
  const n = chk.data.treeJson?.nodes?.length || 0, c = chk.data.treeJson?.connectors?.length || 0;
  const wantN = t.treeJson.nodes.length, wantC = t.treeJson.connectors.length;
  console.log(`${n === wantN && c === wantC ? "✓" : "✗"} ${title}  nodes ${n}/${wantN} connectors ${c}/${wantC}  status=${chk.data.status}`);
}
