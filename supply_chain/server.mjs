/**
 * Supply Chain — Custom API Handler
 */

export const appId = "supply-chain";
export const apiPrefix = "/api/scr";
export const kapp = "supply-chain";

// ─── App-specific helpers ──────────────────────────────────────────────────

const vf = (s, f) => s.values?.[f] || "";
function nowISO() { return new Date().toISOString(); }
const ORDER_TRANSITIONS = {
  "Draft": ["Submitted"],
  "Submitted": ["Confirmed", "Cancelled"],
  "Confirmed": ["Shipped", "Cancelled"],
  "Shipped": ["Delivered"],
  "Delivered": [],
  "Cancelled": [],
};
const DISRUPTION_TRANSITIONS = {
  "Active": ["Monitoring", "Mitigated"],
  "Monitoring": ["Active", "Mitigated", "Resolved"],
  "Mitigated": ["Resolved", "Active"],
  "Resolved": [],
};
async function logActivity(auth, action, entityType, entityId, prev, next, performer, details) {
  const logs = await collect("activity-log", null, 1);
  const logId = `LOG-${String(logs.length + 1).padStart(4, "0")}`;
  await kineticRequest("POST", `/kapps/${KAPP}/forms/activity-log/submissions`, {
    values: {
      "Log ID": logId, "Entity Type": entityType, "Entity ID": entityId,
      Action: action, "Previous Value": prev, "New Value": next, "Performed By": performer,
      Timestamp: nowISO(), Details: details,
    },
  }, auth);
}

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }


  // 1. GET /api/scr/dashboard
  if (pathname === "/api/scr/dashboard" && req.method === "GET") {
    try {
      const [suppliers, orders, inventory, disruptions, alerts, shipments] = await Promise.all([
        collect("suppliers", `values[Status] = "Active"`, 4),
        collect("orders", null, 4),
        collect("inventory", null, 4),
        collect("disruptions", null, 4),
        collect("alerts", null, 4),
        collect("shipments", null, 4),
      ]);

      const activeSuppliers = suppliers.length;
      const openOrders = orders.filter(o => !["Delivered", "Cancelled"].includes(vf(o, "Status"))).length;
      const criticalShortages = inventory.filter(i => vf(i, "Status") === "Out of Stock").length;
      const lowStockItems = inventory.filter(i => vf(i, "Status") === "Low Stock").length;
      const activeDisruptions = disruptions.filter(d => vf(d, "Status") === "Active").length;

      // Fill rate: delivered / (delivered + cancelled)
      const delivered = orders.filter(o => vf(o, "Status") === "Delivered").length;
      const cancelled = orders.filter(o => vf(o, "Status") === "Cancelled").length;
      const fillRate = (delivered + cancelled) > 0 ? ((delivered / (delivered + cancelled)) * 100).toFixed(1) : "100.0";

      // Recent orders (newest first)
      const recentOrders = orders
        .sort((a, b) => (vf(b, "Order Date") || "").localeCompare(vf(a, "Order Date") || ""))
        .slice(0, 10)
        .map(o => ({
          id: o.id, orderId: vf(o, "Order ID"), supplier: vf(o, "Supplier Name"),
          total: vf(o, "Total Amount"), priority: vf(o, "Priority"), status: vf(o, "Status"),
          date: vf(o, "Order Date"), dept: vf(o, "Department"),
        }));

      // Active disruptions list
      const activeDisruptionList = disruptions
        .filter(d => vf(d, "Status") !== "Resolved")
        .slice(0, 10)
        .map(d => ({
          id: d.id, disruptionId: vf(d, "Disruption ID"), title: vf(d, "Title"),
          type: vf(d, "Disruption Type"), impact: vf(d, "Impact Level"), status: vf(d, "Status"),
          startDate: vf(d, "Start Date"),
        }));

      jsonResp(res, 200, {
        activeSuppliers, openOrders, criticalShortages, lowStockItems, activeDisruptions, fillRate,
        recentOrders, activeDisruptionList,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 2. GET /api/scr/supplier/:id/summary
  const supSumMatch = pathname.match(/^\/api\/scr\/supplier\/([^/]+)\/summary$/);
  if (supSumMatch && req.method === "GET") {
    const sid = decodeURIComponent(supSumMatch[1]);
    try {
      const [supArr, ordArr, prodArr] = await Promise.all([
        collect("suppliers", `values[Supplier ID] = "${sid}"`, 1),
        collect("orders", `values[Supplier ID] = "${sid}"`, 4),
        collect("products", null, 4),
      ]);
      if (supArr.length === 0) { jsonResp(res, 404, { error: "Supplier not found" }); return true; }
      const sup = supArr[0];
      const supName = vf(sup, "Supplier Name");

      // Products supplied by this supplier
      const supplierProducts = prodArr.filter(p => vf(p, "Primary Supplier") === supName);

      const m = (s) => ({ id: s.id, ...s.values });
      const totalOrders = ordArr.length;
      const deliveredOrders = ordArr.filter(o => vf(o, "Status") === "Delivered").length;
      const totalSpend = ordArr.reduce((sum, o) => sum + (parseFloat(vf(o, "Total Amount")) || 0), 0).toFixed(2);

      jsonResp(res, 200, {
        supplier: m(sup),
        orders: ordArr.slice(0, 20).map(o => ({ orderId: vf(o, "Order ID"), date: vf(o, "Order Date"), total: vf(o, "Total Amount"), status: vf(o, "Status"), priority: vf(o, "Priority") })),
        products: supplierProducts.map(p => ({ productId: vf(p, "Product ID"), name: vf(p, "Product Name"), category: vf(p, "Category"), cost: vf(p, "Unit Cost"), status: vf(p, "Status") })),
        stats: { totalOrders, deliveredOrders, totalSpend, onTimeRate: totalOrders > 0 ? ((deliveredOrders / totalOrders) * 100).toFixed(1) : "0" },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 3. GET /api/scr/stats/inventory
  if (pathname === "/api/scr/stats/inventory" && req.method === "GET") {
    try {
      const inventory = await collect("inventory", null, 4);
      const statusCounts = { "In Stock": 0, "Low Stock": 0, "Out of Stock": 0, "Expired": 0, "Quarantined": 0 };
      const now = new Date();
      let expiringIn30 = 0;
      const locationMap = {};

      for (const inv of inventory) {
        const st = vf(inv, "Status");
        if (st in statusCounts) statusCounts[st]++;

        const expDate = vf(inv, "Expiration Date");
        if (expDate) {
          const diff = (new Date(expDate).getTime() - now.getTime()) / 864e5;
          if (diff > 0 && diff <= 30) expiringIn30++;
        }

        const loc = vf(inv, "Location") || "Unknown";
        if (!locationMap[loc]) locationMap[loc] = { total: 0, lowStock: 0, outOfStock: 0 };
        locationMap[loc].total++;
        if (st === "Low Stock") locationMap[loc].lowStock++;
        if (st === "Out of Stock") locationMap[loc].outOfStock++;
      }

      // Par level compliance
      let atPar = 0, belowPar = 0;
      for (const inv of inventory) {
        const qoh = parseInt(vf(inv, "Quantity On Hand")) || 0;
        const par = parseInt(vf(inv, "Par Level")) || 0;
        if (par > 0) { if (qoh >= par) atPar++; else belowPar++; }
      }

      jsonResp(res, 200, {
        statusCounts, expiringIn30, locationMap,
        parCompliance: { atPar, belowPar, rate: (atPar + belowPar) > 0 ? ((atPar / (atPar + belowPar)) * 100).toFixed(1) : "0" },
        totalItems: inventory.length,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 4. GET /api/scr/stats/disruptions
  if (pathname === "/api/scr/stats/disruptions" && req.method === "GET") {
    try {
      const disruptions = await collect("disruptions", null, 4);
      const activeCount = disruptions.filter(d => vf(d, "Status") === "Active").length;
      const monitoringCount = disruptions.filter(d => vf(d, "Status") === "Monitoring").length;
      const mitigatedCount = disruptions.filter(d => vf(d, "Status") === "Mitigated").length;
      const resolvedCount = disruptions.filter(d => vf(d, "Status") === "Resolved").length;

      // Impact distribution
      const impactDist = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      for (const d of disruptions) {
        const imp = vf(d, "Impact Level");
        if (imp in impactDist) impactDist[imp]++;
      }

      // Type distribution
      const typeDist = {};
      for (const d of disruptions) {
        const t = vf(d, "Disruption Type") || "Unknown";
        typeDist[t] = (typeDist[t] || 0) + 1;
      }

      // Avg resolution time for resolved
      const resolved = disruptions.filter(d => vf(d, "Status") === "Resolved" && vf(d, "Start Date") && vf(d, "Resolution Date"));
      let avgResolution = 0;
      if (resolved.length > 0) {
        const totalDays = resolved.reduce((sum, d) => {
          const days = (new Date(vf(d, "Resolution Date")).getTime() - new Date(vf(d, "Start Date")).getTime()) / 864e5;
          return sum + Math.abs(days);
        }, 0);
        avgResolution = (totalDays / resolved.length).toFixed(1);
      }

      jsonResp(res, 200, {
        activeCount, monitoringCount, mitigatedCount, resolvedCount,
        impactDist, typeDist, avgResolution, total: disruptions.length,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 5. POST /api/scr/orders/:id/transition
  const ordTransMatch = pathname.match(/^\/api\/scr\/orders\/([^/]+)\/transition$/);
  if (ordTransMatch && req.method === "POST") {
    const oid = decodeURIComponent(ordTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const ords = await collect("orders", `values[Order ID] = "${oid}"`, 1);
      if (ords.length === 0) { jsonResp(res, 404, { error: "Order not found" }); return true; }
      const ord = ords[0];
      const current = vf(ord, "Status");
      const allowed = ORDER_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Delivered") updates["Delivery Date"] = new Date().toISOString().slice(0, 10);
      if (body.trackingNumber) updates["Tracking Number"] = body.trackingNumber;
      await kineticRequest("PUT", `/submissions/${ord.id}/values`, updates, auth);
      await logActivity(auth, "Status Changed", "Order", oid, current, newStatus, body.performer || "System",
        `Order ${oid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 6. POST /api/scr/disruptions/:id/transition
  const disTransMatch = pathname.match(/^\/api\/scr\/disruptions\/([^/]+)\/transition$/);
  if (disTransMatch && req.method === "POST") {
    const did = decodeURIComponent(disTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const diss = await collect("disruptions", `values[Disruption ID] = "${did}"`, 1);
      if (diss.length === 0) { jsonResp(res, 404, { error: "Disruption not found" }); return true; }
      const dis = diss[0];
      const current = vf(dis, "Status");
      const allowed = DISRUPTION_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Resolved") updates["Resolution Date"] = new Date().toISOString().slice(0, 10);
      if (body.mitigationPlan) updates["Mitigation Plan"] = body.mitigationPlan;
      await kineticRequest("PUT", `/submissions/${dis.id}/values`, updates, auth);
      await logActivity(auth, "Status Changed", "Disruption", did, current, newStatus, body.performer || "System",
        `Disruption ${did} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 7. GET /api/scr/report/:type
  const reportMatch = pathname.match(/^\/api\/scr\/report\/([a-z-]+)$/);
  if (reportMatch && req.method === "GET") {
    const type = reportMatch[1];
    try {
      if (type === "inventory") {
        const inventory = await collect("inventory", null, 4);
        jsonResp(res, 200, {
          report: "Inventory Report",
          items: inventory.map(i => ({
            inventoryId: vf(i, "Inventory ID"), productName: vf(i, "Product Name"), location: vf(i, "Location"),
            qoh: vf(i, "Quantity On Hand"), par: vf(i, "Par Level"), reorder: vf(i, "Reorder Point"),
            expiration: vf(i, "Expiration Date"), status: vf(i, "Status"),
          })),
        });
      } else if (type === "supplier-performance") {
        const [suppliers, orders] = await Promise.all([
          collect("suppliers", null, 4),
          collect("orders", null, 4),
        ]);
        const supMap = {};
        for (const s of suppliers) {
          supMap[vf(s, "Supplier Name")] = { name: vf(s, "Supplier Name"), type: vf(s, "Supplier Type"), reliability: vf(s, "Reliability Score"), risk: vf(s, "Risk Level"), status: vf(s, "Status"), orders: 0, delivered: 0, totalSpend: 0 };
        }
        for (const o of orders) {
          const sn = vf(o, "Supplier Name");
          if (supMap[sn]) {
            supMap[sn].orders++;
            if (vf(o, "Status") === "Delivered") supMap[sn].delivered++;
            supMap[sn].totalSpend += parseFloat(vf(o, "Total Amount")) || 0;
          }
        }
        jsonResp(res, 200, { report: "Supplier Performance", suppliers: Object.values(supMap).map(s => ({ ...s, totalSpend: s.totalSpend.toFixed(2) })) });
      } else if (type === "disruption") {
        const disruptions = await collect("disruptions", null, 4);
        jsonResp(res, 200, {
          report: "Disruption Report",
          items: disruptions.map(d => ({
            disruptionId: vf(d, "Disruption ID"), title: vf(d, "Title"), type: vf(d, "Disruption Type"),
            impact: vf(d, "Impact Level"), startDate: vf(d, "Start Date"), resolutionDate: vf(d, "Resolution Date"),
            status: vf(d, "Status"), affectedProducts: vf(d, "Affected Products"),
          })),
        });
      } else if (type === "order-summary") {
        const orders = await collect("orders", null, 4);
        jsonResp(res, 200, {
          report: "Order Summary",
          items: orders.map(o => ({
            orderId: vf(o, "Order ID"), supplier: vf(o, "Supplier Name"), date: vf(o, "Order Date"),
            total: vf(o, "Total Amount"), priority: vf(o, "Priority"), dept: vf(o, "Department"),
            status: vf(o, "Status"), delivery: vf(o, "Delivery Date"),
          })),
        });
      } else if (type === "cost-analysis") {
        const [orders, products] = await Promise.all([
          collect("orders", null, 4),
          collect("products", null, 4),
        ]);
        const byCat = {};
        for (const p of products) {
          const cat = vf(p, "Category") || "Unknown";
          if (!byCat[cat]) byCat[cat] = { count: 0, totalCost: 0 };
          byCat[cat].count++;
          byCat[cat].totalCost += parseFloat(vf(p, "Unit Cost")) || 0;
        }
        const byDept = {};
        for (const o of orders) {
          const dept = vf(o, "Department") || "Unknown";
          if (!byDept[dept]) byDept[dept] = { orders: 0, spend: 0 };
          byDept[dept].orders++;
          byDept[dept].spend += parseFloat(vf(o, "Total Amount")) || 0;
        }
        jsonResp(res, 200, {
          report: "Cost Analysis",
          byCategory: Object.entries(byCat).map(([cat, v]) => ({ category: cat, products: v.count, avgCost: (v.totalCost / v.count).toFixed(2) })),
          byDepartment: Object.entries(byDept).map(([dept, v]) => ({ department: dept, orders: v.orders, totalSpend: v.spend.toFixed(2) })),
        });
      } else if (type === "expiration") {
        const inventory = await collect("inventory", null, 4);
        const now = Date.now();
        const items = inventory
          .filter(i => vf(i, "Expiration Date"))
          .map(i => {
            const exp = vf(i, "Expiration Date");
            const daysLeft = Math.ceil((new Date(exp).getTime() - now) / 864e5);
            return { productName: vf(i, "Product Name"), location: vf(i, "Location"), lotNumber: vf(i, "Lot Number"), expirationDate: exp, daysLeft, status: vf(i, "Status"), qoh: vf(i, "Quantity On Hand") };
          })
          .sort((a, b) => a.daysLeft - b.daysLeft);
        jsonResp(res, 200, { report: "Expiration Report", items });
      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${type}` });
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 8. GET /api/scr/search?q=&type=
  if (pathname === "/api/scr/search" && req.method === "GET") {
    const parsedUrl = new URL(req.url, "http://localhost");
    const q = (parsedUrl.searchParams.get("q") || "").toLowerCase();
    const type = parsedUrl.searchParams.get("type") || "all";
    if (!q || q.length < 2) { jsonResp(res, 400, { error: "Query must be at least 2 characters" }); return true; }
    try {
      const results = [];
      const search = (arr, entityType, nameField, idField) => {
        for (const s of arr) {
          const name = (vf(s, nameField) || "").toLowerCase();
          const id = (vf(s, idField) || "").toLowerCase();
          if (name.includes(q) || id.includes(q)) {
            results.push({ id: s.id, entityType, entityId: vf(s, idField), name: vf(s, nameField), status: vf(s, "Status") });
          }
        }
      };
      if (type === "all" || type === "suppliers") {
        const sups = await collect("suppliers", null, 4);
        search(sups, "Supplier", "Supplier Name", "Supplier ID");
      }
      if (type === "all" || type === "products") {
        const prods = await collect("products", null, 4);
        search(prods, "Product", "Product Name", "Product ID");
      }
      if (type === "all" || type === "orders") {
        const ords = await collect("orders", null, 4);
        search(ords, "Order", "Supplier Name", "Order ID");
      }
      if (type === "all" || type === "disruptions") {
        const diss = await collect("disruptions", null, 4);
        search(diss, "Disruption", "Title", "Disruption ID");
      }
      jsonResp(res, 200, { query: q, type, results: results.slice(0, 50) });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}

// ─── Standalone mode ───────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const http = await import("node:http");
  const https = await import("node:https");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const PORT = process.env.PORT || 3099;
  const KINETIC = process.env.KINETIC_URL || "https://localhost";
  const __dir = path.dirname(new URL(import.meta.url).pathname);

  function kineticRequest(method, apiPath, body, authHeader) {
    return new Promise((resolve, reject) => {
      const url = new URL(`/app/api/v1${apiPath}`, KINETIC);
      const headers = { "Content-Type": "application/json" };
      if (authHeader) headers["Authorization"] = authHeader;
      const payload = body ? JSON.stringify(body) : null;
      if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
      const r = https.request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
          catch { resolve({ status: res.statusCode, data: text }); }
        });
      });
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  function jsonResp(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
    res.end(JSON.stringify(data));
  }

  function readBody(req) {
    return new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c).toString())); });
  }

  async function collectByQuery(kappSlug, formSlug, kql, authHeader, maxPages = 8) {
    const all = []; let lastCreatedAt = null;
    for (let i = 0; i < maxPages; i++) {
      let url = `/kapps/${kappSlug}/forms/${formSlug}/submissions?include=values,details&limit=25`;
      let q = kql || "";
      if (lastCreatedAt) q = (q ? "(" + q + ") AND " : "") + `createdAt < "${lastCreatedAt}"`;
      if (q) url += `&q=${encodeURIComponent(q)}`;
      const r = await kineticRequest("GET", url, null, authHeader);
      const subs = r.data?.submissions || [];
      all.push(...subs);
      if (subs.length > 0) lastCreatedAt = subs[subs.length - 1].createdAt;
      if (!r.data?.nextPageToken || subs.length < 25) break;
    }
    return all;
  }

  const helpers = {
    kineticRequest, jsonResp, readBody, collectByQuery,
    vf: (s, f) => s.values?.[f] || "",
  };

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }); res.end(); return; }
    if (pathname.startsWith(apiPrefix)) {
      const handled = await handleAPI(req, res, pathname, req.headers.authorization, helpers);
      if (handled) return;
    }
    if (pathname.startsWith("/app/")) {
      const url = new URL(req.url, KINETIC);
      const headers = { ...req.headers, host: url.host }; delete headers.origin; delete headers.referer;
      const body = await readBody(req);
      const pr = https.request(url, { method: req.method, headers }, (pres) => {
        res.writeHead(pres.statusCode, { ...pres.headers, "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
        pres.pipe(res);
      });
      pr.on("error", e => { res.writeHead(502); res.end(e.message); });
      if (body.length) pr.write(body);
      pr.end(); return;
    }
    let fp = pathname === "/" ? "/index.html" : pathname;
    fp = path.join(__dir, fp);
    try { const c = fs.readFileSync(fp); res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(fp)] || "application/octet-stream" }); res.end(c); }
    catch { res.writeHead(404); res.end("Not found"); }
  });

  server.listen(PORT, () => console.log(`\n  Supply Chain: http://localhost:${PORT}\n`));
}
