/**
 * Pool Management — Custom API Handler
 * Fleet-wide aggregation (pools, customers, visits, chemistry) + per-pool history.
 */
export const appId = "pool-management";
export const apiPrefix = "/api/pools";
export const kapp = "pool-management";

const OPEN_VISIT = new Set(["Scheduled", "In Progress"]);
function num(x) { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; }
function avg(a) { return a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : 0; }
function inc(o, k) { const key = k || "—"; o[key] = (o[key] || 0) + 1; }

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, jsonResp, vf } = helpers;
  async function collect(formSlug, kql, maxPages = 8) { return collectByQuery(kapp, formSlug, kql, auth, maxPages); }

  // GET /api/pools/dashboard
  if (pathname === "/api/pools/dashboard" && req.method === "GET") {
    try {
      const [customers, pools, visits, tests, employees] = await Promise.all([
        collect("customers", null, 25),
        collect("pools", null, 25),
        collect("service-visits", null, 16),
        collect("water-tests", null, 20),
        collect("employees", null, 2),
      ]);

      const poolsByCity = {}, poolsByStatus = {}, heating = {}, skimmersByCity = {};
      let totalSkimmers = 0;
      for (const p of pools) {
        const city = vf(p, "City");
        inc(poolsByCity, city);
        inc(poolsByStatus, vf(p, "Status"));
        inc(heating, vf(p, "Heating Manufacturer") || "None");
        const sk = num(vf(p, "Skimmer Count"));
        totalSkimmers += sk;
        skimmersByCity[city || "—"] = (skimmersByCity[city || "—"] || 0) + sk;
      }

      const svcType = {}, empWork = {};
      let scheduled = 0, completed = 0, repairs = 0;
      for (const v of visits) {
        inc(svcType, vf(v, "Service Type"));
        const st = vf(v, "Status");
        if (OPEN_VISIT.has(st)) scheduled++;
        if (st === "Completed") completed++;
        if (vf(v, "Service Type") === "Repair") repairs++;
        const e = vf(v, "Employee");
        if (e) inc(empWork, e);
      }

      const phs = [], balance = {};
      for (const t of tests) {
        const r = vf(t, "Result") || "—";
        inc(balance, r);
        const ph = num(vf(t, "pH"));
        if (ph) phs.push(ph);
      }
      const balancedPct = tests.length ? Math.round(((balance["Balanced"] || 0) / tests.length) * 100) : 0;

      const needsRepairList = pools.filter(p => vf(p, "Status") === "Needs Repair").slice(0, 14).map(p => ({
        id: p.id, poolId: vf(p, "Pool Id"), customer: vf(p, "Customer Name"), city: vf(p, "City"),
        type: vf(p, "Pool Type"), heating: vf(p, "Heating Manufacturer"), assigned: vf(p, "Assigned Employee"),
      }));

      const recentTests = [...tests].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 8).map(t => ({
        poolId: vf(t, "Pool Id"), customer: vf(t, "Customer Name"), date: vf(t, "Date"),
        ph: vf(t, "pH"), chlorine: vf(t, "Free Chlorine"), result: vf(t, "Result"), chemicals: vf(t, "Chemicals Added"),
      }));

      jsonResp(res, 200, {
        kpis: {
          customers: customers.length,
          activeCustomers: customers.filter(c => vf(c, "Status") === "Active").length,
          pools: pools.length,
          activePools: pools.filter(p => vf(p, "Status") === "Active").length,
          needsRepair: pools.filter(p => vf(p, "Status") === "Needs Repair").length,
          employees: employees.length,
          totalSkimmers,
          scheduled, completed, repairs,
          balancedPct,
          avgPh: avg(phs),
          tests: tests.length,
        },
        poolsByCity, poolsByStatus, heating, skimmersByCity, svcType, balance,
        empWork, needsRepairList, recentTests,
      });
      return true;
    } catch (e) { jsonResp(res, 500, { error: String(e?.message || e) }); return true; }
  }

  // GET /api/pools/pool-detail?poolId=P-00001 — visits + chemistry history for one pool
  if (pathname === "/api/pools/pool-detail" && req.method === "GET") {
    try {
      const u = new URL(req.url, "http://x");
      const poolId = u.searchParams.get("poolId");
      if (!poolId) { jsonResp(res, 400, { error: "poolId required" }); return true; }
      const [visits, tests] = await Promise.all([
        collect("service-visits", `values[Pool Id] = "${poolId}"`, 6),
        collect("water-tests", `values[Pool Id] = "${poolId}"`, 6),
      ]);
      const sorted = [...tests].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      jsonResp(res, 200, {
        visits: visits.map(v => ({ id: v.id, visitId: vf(v, "Visit Id"), date: vf(v, "Date"), type: vf(v, "Service Type"), employee: vf(v, "Employee"), status: vf(v, "Status"), notes: vf(v, "Notes") })),
        tests: sorted.map(t => ({ id: t.id, testId: vf(t, "Test Id"), date: vf(t, "Date"), ph: vf(t, "pH"), chlorine: vf(t, "Free Chlorine"), alkalinity: vf(t, "Total Alkalinity"), result: vf(t, "Result"), chemicals: vf(t, "Chemicals Added") })),
        visitCount: visits.length, testCount: tests.length,
        balanced: tests.filter(t => vf(t, "Result") === "Balanced").length,
      });
      return true;
    } catch (e) { jsonResp(res, 500, { error: String(e?.message || e) }); return true; }
  }

  // GET /api/pools/options — employees for dropdowns (customers/pools are searched on demand)
  if (pathname === "/api/pools/options" && req.method === "GET") {
    try {
      const employees = await collect("employees", null, 2);
      jsonResp(res, 200, {
        employees: employees.filter(e => vf(e, "Status") !== "Inactive").map(e => ({ name: vf(e, "Name"), role: vf(e, "Role") })),
      });
      return true;
    } catch (e) { jsonResp(res, 500, { error: String(e?.message || e) }); return true; }
  }

  return false;
}
