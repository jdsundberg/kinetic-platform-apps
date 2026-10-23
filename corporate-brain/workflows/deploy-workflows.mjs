// Deploys Corporate Brain's Kinetic Task workflows (form-level).
//   KINETIC_URL=… KINETIC_USER=… KINETIC_PASS=… node apps/corporate-brain/workflows/deploy-workflows.mjs
// For each workflow: create it if missing → push the tree through the sanctioned
// skills/…/workflow-xml/scripts/put-workflow.mjs (validates first) → confirm the stored treeJson has
// nodes → re-apply event + filter (a tree-only PUT clears the filter) → read back and compare.
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUT_WORKFLOW = path.resolve(HERE, "../../../skills/skills/concepts/workflow-xml/scripts/put-workflow.mjs");
const BASE = process.env.KINETIC_URL.replace(/\/+$/, "");
const AUTH = "Basic " + Buffer.from(`${process.env.KINETIC_USER}:${process.env.KINETIC_PASS}`).toString("base64");
const KAPP = "corporate-brain";
const EVIDENCE_TYPES = "['fact','narrative','lesson','summary','interpretation']";

export const WORKFLOWS = [
  { form: "knowledge-entries", name: "Verification Guard", event: "Submission Updated", file: "verification-guard.xml",
    filter: `values('Review Status') == 'verified' && (!values('Verified By') || ((!values('Supporting Source IDs') || values('Supporting Source IDs') == '[]') && ${EVIDENCE_TYPES}.indexOf(values('Knowledge Type')) >= 0))` },
  { form: "knowledge-entries", name: "Contradiction Review", event: "Submission Submitted", file: "contradiction-review.xml",
    filter: `values('Review Status') == 'proposed' && !!values('Contradicts') && values('Contradicts') != '[]'` },
  { form: "research-jobs", name: "Ingestion Retry", event: "Submission Updated", file: "ingestion-retry.xml",
    filter: `values('Status') == 'failed' && values('Job Type') == 'ingestion' && parseInt(values('Attempts') || '0', 10) < 3` },
];

async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { Authorization: AUTH, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}

for (const w of WORKFLOWS) {
  const base = `/app/api/v1/kapps/${KAPP}/forms/${w.form}/workflows`;
  const list = await api("GET", base);
  let wf = (list.data.workflows || []).find(x => x.name === w.name);
  if (!wf) {
    const c = await api("POST", base, { name: w.name, event: w.event, type: "Tree", status: "Active", filter: w.filter });
    if (c.status >= 300) { console.error(`✗ create ${w.name}: ${JSON.stringify(c.data)}`); process.exitCode = 1; continue; }
    wf = c.data.workflow || c.data;
    console.log(`✓ created ${w.form} :: ${w.name} (${wf.id})`);
  }
  const put = spawnSync("node", [PUT_WORKFLOW, `${KAPP}/${w.form}/${wf.id}`, "--tree", path.join(HERE, w.file)], { encoding: "utf-8", env: process.env });
  if (put.status !== 0) { console.error(`✗ put ${w.name}:\n${put.stderr}${put.stdout}`); process.exitCode = 1; continue; }
  // the stored tree must really contain the nodes
  const tree = await api("GET", `/app/components/task/app/api/v2/trees/${encodeURIComponent(`Kinetic Request CE :: ${wf.id} :: ${w.name}`)}?include=treeJson`);
  const nodes = tree.data?.treeJson?.nodes?.length || 0;
  // re-apply event + filter, then read back
  await api("PUT", `${base}/${wf.id}`, { event: w.event, filter: w.filter, status: "Active" });
  const back = (await api("GET", `${base}/${wf.id}`)).data;
  const b = back.workflow || back;
  const okFilter = b.filter === w.filter && b.event === w.event;
  console.log(`${nodes >= 3 && okFilter ? "✓" : "✗"} ${KAPP}/${w.form} :: ${w.name} — stored nodes ${nodes}, event ${b.event}, filter ${okFilter ? "ok" : "MISMATCH: " + b.filter}`);
  if (!(nodes >= 3 && okFilter)) process.exitCode = 1;
}
