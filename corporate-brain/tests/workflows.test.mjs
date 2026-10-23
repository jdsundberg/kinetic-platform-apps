// Live tests for the Kinetic Task governance workflows (needs a deployed kapp + workflows).
//   KINETIC_URL=… KINETIC_USER=… KINETIC_PASS=… node apps/corporate-brain/tests/workflows.test.mjs
// Creates clearly-labelled TEST records, checks each workflow's effect, then deletes the test records
// (audit-log rows written by the workflows are kept: the log is append-only).
const BASE = process.env.KINETIC_URL.replace(/\/+$/, "");
const AUTH = "Basic " + Buffer.from(`${process.env.KINETIC_USER}:${process.env.KINETIC_PASS}`).toString("base64");
const F = (form) => `/app/api/v1/kapps/corporate-brain/forms/${form}/submissions`;
async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { Authorization: AUTH, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(subId, pred, secs = 60) {
  for (let i = 0; i < secs / 3; i++) {
    const s = (await api("GET", `/app/api/v1/submissions/${subId}?include=values`)).data.submission;
    if (pred(s.values)) return s.values;
    await sleep(3000);
  }
  return (await api("GET", `/app/api/v1/submissions/${subId}?include=values`)).data.submission.values;
}
let pass = 0, fail = 0; const cleanup = [];
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`); };
const stamp = Date.now().toString(36).toUpperCase();

try {
  // 1. Verification Guard: a direct Core API write that marks a sourceless fact verified with no verifier
  const k = await api("POST", F("knowledge-entries"), { coreState: "Submitted", values: { "Knowledge ID": `KN-TEST${stamp}`, "Knowledge Type": "fact", Title: "TEST — guard bypass attempt", Statement: "Test record", "Supporting Source IDs": "[]", "Review Status": "proposed", "Review History": "[]", "Record Status": "test", "Created Via": "test" } });
  cleanup.push(k.data.submission.id);
  await api("PUT", `/app/api/v1/submissions/${k.data.submission.id}`, { values: { "Review Status": "verified" } });
  const g = await waitFor(k.data.submission.id, v => v["Review Status"] !== "verified");
  check("Verification Guard reverts a bypass verification", g["Review Status"] === "needs-research", `status now ${g["Review Status"]}`);
  check("Verification Guard appends review history", /guard-revert/.test(g["Review History"] || ""));

  // 2. Contradiction Review: a new proposal that contradicts another entry is routed to disputed
  const c = await api("POST", F("knowledge-entries"), { coreState: "Submitted", values: { "Knowledge ID": `KN-TESTC${stamp}`, "Knowledge Type": "claim", Title: "TEST — contradicting claim", Statement: "Test record", "Supporting Source IDs": "[]", Contradicts: JSON.stringify([`KN-TEST${stamp}`]), "Review Status": "proposed", "Review History": "[]", "Record Status": "test", "Created Via": "test" } });
  cleanup.push(c.data.submission.id);
  const cv = await waitFor(c.data.submission.id, v => v["Review Status"] !== "proposed");
  check("Contradiction Review routes contradicting proposals to disputed", cv["Review Status"] === "disputed", `status now ${cv["Review Status"]}`);

  // 3. Ingestion Retry: a failed ingestion job with attempts < 3 is re-queued
  const j = await api("POST", F("research-jobs"), { coreState: "Submitted", values: { "Job ID": `JB-TEST${stamp}`, Title: "TEST — retry", "Job Type": "ingestion", Connector: "github", Status: "running", Attempts: "1", "Record Status": "test" } });
  cleanup.push(j.data.submission.id);
  await api("PUT", `/app/api/v1/submissions/${j.data.submission.id}`, { values: { Status: "failed" } });
  const jv = await waitFor(j.data.submission.id, v => v.Status !== "failed");
  check("Ingestion Retry re-queues a failed job", jv.Status === "queued", `status now ${jv.Status}`);
  const j3 = await api("POST", F("research-jobs"), { coreState: "Submitted", values: { "Job ID": `JB-TEST3${stamp}`, Title: "TEST — no retry", "Job Type": "ingestion", Connector: "github", Status: "running", Attempts: "3", "Record Status": "test" } });
  cleanup.push(j3.data.submission.id);
  await api("PUT", `/app/api/v1/submissions/${j3.data.submission.id}`, { values: { Status: "failed" } });
  await sleep(15000);
  const j3v = (await api("GET", `/app/api/v1/submissions/${j3.data.submission.id}?include=values`)).data.submission.values;
  check("Ingestion Retry leaves a job failed after 3 attempts", j3v.Status === "failed");

  // audit rows written by the workflows
  const a = await api("GET", `${F("audit-log")}?include=values&limit=25&q=${encodeURIComponent(`values[Entity ID] = "KN-TEST${stamp}"`)}`);
  check("Workflow wrote an audit-log entry", (a.data.submissions || []).some(s => s.values.Action === "guard:verification-reverted"));
} finally {
  for (const id of cleanup) await api("DELETE", `/app/api/v1/submissions/${id}`);
  console.log(`\n${pass} passed, ${fail} failed (test records removed)`);
  process.exitCode = fail ? 1 : 0;
}
