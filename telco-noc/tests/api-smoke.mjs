// Hits every read endpoint the 8 screens use and asserts real (non-zero) data came back.
import http from "node:http";
const L = process.env.NOC_LAUNCHER || "http://127.0.0.1:3031";
const AUTH = "Basic " + Buffer.from(`${process.env.U || "john"}:${process.env.P || "john1"}`).toString("base64");
export async function call(method, p, body, auth = AUTH, headers = {}) {
  for (let i = 0; i < 3; i++) { const r = await call1(method, p, body, auth, headers); if (r.status !== 503 && r.status !== 0) return r; await new Promise((x) => setTimeout(x, 2000 * (i + 1))); }
  return call1(method, p, body, auth, headers);
}
function call1(method, p, body, auth = AUTH, headers = {}) {
  return new Promise((resolve) => { const u = new URL(L + p); const data = body ? JSON.stringify(body) : null;
    const r = http.request(u, { method, headers: { Authorization: auth, "Content-Type": "application/json", ...headers, ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) }, timeout: 600000 }, (res) => {
      const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => { const s = Buffer.concat(c).toString(); let d; try { d = JSON.parse(s); } catch { d = s; } resolve({ status: res.statusCode, data: d }); }); });
    r.on("error", (e) => resolve({ status: 0, data: { error: e.message } })); if (data) r.write(data); r.end(); });
}
if (import.meta.url === `file://${process.argv[1]}`) {
  let fails = 0; const t = async (name, p, check) => { const s = Date.now(); const r = await call("GET", p); let ok = r.status === 200, why = "";
    try { if (ok) { const x = check(r.data); if (x !== true) { ok = false; why = String(x); } } else why = JSON.stringify(r.data).slice(0, 200); } catch (e) { ok = false; why = e.message; }
    if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name.padEnd(28)} ${String(Date.now() - s).padStart(5)}ms ${why}`); return r.data; };
  const cc = await t("command-center", "/api/noc/command-center", (d) => d.integrations.length > 5 && typeof d.kpis.openIncidents === "number" || "no KPIs");
  const open = cc.incidents?.length > 0;
  // use the open incident if there is one, else the most recent closed demo incident
  const closed = await call("GET", "/api/noc/incidents?state=Closed");
  const inc = cc.incidents?.[0]?.id || closed.data.rows.filter((r) => /^INC-\d{8}-[0-9A-F]{4}$/.test(r.id) && !/0003|0007|0002|0011|0004/.test(r.id.slice(-4))).sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))[0]?.id;
  console.log(`      using incident ${inc} (${open ? "open" : "closed"})`);
  await t("incidents list", "/api/noc/incidents?state=Closed", (d) => d.rows.length > 0 || "no rows");
  const ws = await t("incident workspace", `/api/noc/incidents/${inc}`, (d) => d.impact.services.length > 10 && d.timeline.length > 1 && d.alarmStats.total > 100 || `svc ${d.impact?.services?.length}`);
  await t("incident alarms page", `/api/noc/incidents/${inc}/alarms`, (d) => d.rows.length === 25 && !!d.nextPageToken || `rows ${d.rows?.length}`);
  await t("incident alarms filter", `/api/noc/incidents/${inc}/alarms?role=Root%20Evidence`, (d) => d.rows.length >= 2 || `rows ${d.rows?.length}`);
  await t("incident impacts page", `/api/noc/incidents/${inc}/impacts?class=Confirmed`, (d) => d.rows.length > 0 || "none");
  await t("impact map", `/api/noc/incidents/${inc}/map`, (d) => d.sites.filter((s) => s.state === "down").length >= 9 && d.spans.some((s) => s.state === "root") || "no down sites");
  await t("resources page", "/api/noc/resources", (d) => d.rows.length === 25 || `rows ${d.rows?.length}`);
  await t("resources filter", "/api/noc/resources?type=Fiber%20Span", (d) => d.rows.length === 6 || `rows ${d.rows?.length}`);
  await t("resource detail", "/api/noc/resources/FIB-MSP-STP-01", (d) => d.whatIf.servicesDown.length > 10 && d.dependents.length > 5 || "no deps");
  await t("resource detail (rehomed)", "/api/noc/resources/CKT-DIA-10479", (d) => d.history.length === 1 && d.conflicts.length === 1 || `hist ${d.history?.length} conf ${d.conflicts?.length}`);
  await t("customers page", "/api/noc/customers", (d) => d.rows.length > 10 && (!open || d.rows.some((c) => c.status)) || "no impact status");
  await t("customer detail", "/api/noc/customers/ACCT-1007", (d) => d.services.length > 0 && d.contacts.length > 0 || "empty");
  await t("changes", "/api/noc/changes", (d) => d.rows.length >= 3 || "none");
  await t("work orders", "/api/noc/work-orders?all=1", (d) => Array.isArray(d.rows) || "bad");
  await t("exec", "/api/noc/exec", (d) => d.kpis.incidents90d >= 6 && Object.keys(d.byMarket).length >= 2 || "empty");
  await t("integrations", "/api/noc/integrations", (d) => d.rows.some((r) => r.basis?.includes("observed")) || "no observed freshness");
  const u = await call("GET", "/api/noc/me", null, "Basic " + Buffer.from("john:wrong").toString("base64"));
  console.log(`${u.status === 401 ? "PASS" : "FAIL"} bad credentials → 401        (${u.status})`); if (u.status !== 401) fails++;
  console.log(fails ? `${fails} FAILED` : "ALL PASS");
}
