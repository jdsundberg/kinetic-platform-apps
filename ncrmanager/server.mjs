/**
 * Kinetic MedQMS — Custom API Handler (read-side aggregation + traceability + WebAPI).
 *
 * Endpoints (auto-mounted by apps/base/server.mjs under /api/ncrmanager):
 *   GET  /dashboard                      Executive QMS rollup across all modules
 *   GET  /mywork?user=                   Personal queue: assigned, overdue, signatures due, escalations
 *   GET  /record360/:form/:subId         Record-360: related records, relationship graph, timeline, e-sigs
 *   GET  /v1/quality-events|capas|complaints|suppliers   Versioned WebAPI (paginated, filterable)
 *   GET  /v1/metrics                     Versioned WebAPI metrics contract
 *   POST /v1/quality-events              Versioned intake (idempotent)
 *
 * No business-process logic lives here. Workflow routing/escalation/effectiveness
 * are Kinetic Task trees; this server only reads + rolls up governed submissions.
 *
 * Also runs STANDALONE on its own port (3021) when executed directly:
 *   PORT=3021 KINETIC_URL=https://ai-labs.kinopsdev.io node server.mjs
 */
export const appId = "ncrmanager";
export const apiPrefix = "/api/ncrmanager";
export const kapp = "ncrmanager";

// ── tiny utils ────────────────────────────────────────────────────────────────
const TODAY = new Date("2026-06-27T00:00:00Z").getTime();
const DAY = 86400000;
const num = (v) => { if (v == null) return 0; const n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
const daysUntil = (s) => { const t = new Date(s).getTime(); return isNaN(t) ? null : Math.round((t - TODAY) / DAY); };
const daysSince = (s) => { const d = daysUntil(s); return d == null ? null : -d; };
const isOverdue = (due) => { const d = daysUntil(due); return d != null && d < 0; };

// id-prefix → form metadata (for traceability resolution)
const PREFIX_MAP = {
  QE: { form: "quality-events", idField: "Event ID", label: "Quality Event" },
  NC: { form: "nonconformances", idField: "NC ID", label: "Nonconformance" },
  CAPA: { form: "capas", idField: "CAPA ID", label: "CAPA" },
  CMP: { form: "complaints", idField: "Complaint ID", label: "Complaint" },
  RSK: { form: "risks", idField: "Risk ID", label: "Risk" },
  CHG: { form: "change-requests", idField: "Change ID", label: "Change" },
  SCAR: { form: "scars", idField: "SCAR ID", label: "SCAR" },
  AUD: { form: "audits", idField: "Audit ID", label: "Audit" },
  FND: { form: "audit-findings", idField: "Finding ID", label: "Finding" },
  DOC: { form: "documents", idField: "Document ID", label: "Document" },
  PRD: { form: "products", idField: "Product ID", label: "Product" },
  SUP: { form: "suppliers", idField: "Supplier ID", label: "Supplier" },
  EQP: { form: "equipment", idField: "Equipment ID", label: "Equipment" },
  TRN: { form: "training-records", idField: "Training ID", label: "Training" },
  SITE: { form: "sites", idField: "Site ID", label: "Site" },
  MR: { form: "mgmt-reviews", idField: "Review ID", label: "Management Review" },
};
// fields on each form that may reference another record's business ID
const LINK_FIELDS = {
  "quality-events": ["Linked CAPA", "Linked NC", "Linked Complaint", "Product", "Supplier"],
  "nonconformances": ["Source Event", "Linked CAPA", "Linked Complaint", "Product"],
  "capas": ["Source Event", "Linked NC", "Linked Complaint", "Linked Risk", "Linked Change", "Linked SCAR", "Product", "Supplier"],
  "capa-actions": ["CAPA ID"],
  "complaints": ["Linked CAPA", "Linked Risk", "Linked Event", "Product", "Duplicate Of"],
  "audit-findings": ["Audit ID", "Linked CAPA", "Supplier"],
  "change-requests": ["Linked CAPA", "Linked Product", "Document"],
  "training-records": ["Linked CAPA", "Linked Change", "Document"],
  "scars": ["Source Event", "Linked CAPA", "Supplier"],
  "risks": ["Linked CAPA", "Linked Complaint", "Product"],
  "audits": ["Supplier"],
};
// reverse-scan these forms for references; capa-actions are rendered separately (not graph nodes)
const RELATED_FORMS = Object.keys(LINK_FIELDS).filter((f) => f !== "capa-actions");
// link fields that store a composite "ID - Name" value → id-prefix they hold.
// These need `=*` (starts-with) matching instead of exact `=` in the reverse scan.
const COMPOSITE_LINK = new Map([["Product", "PRD"], ["Linked Product", "PRD"], ["Supplier", "SUP"]]);
const firstToken = (val) => { const m = String(val || "").match(/^[A-Z]{2,4}-[0-9A-Za-z-]+/); return m ? m[0] : null; };

// ── simple 5-min cache for the heavy dashboard ────────────────────────────────
const _cache = new Map();
const _inflight = new Map();
async function cached(key, ttl, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  if (_inflight.has(key)) return _inflight.get(key);
  const p = (async () => { const v = await fn(); _cache.set(key, { t: Date.now(), v }); _inflight.delete(key); return v; })();
  _inflight.set(key, p); return p;
}

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, vf, readBody } = helpers;
  const KAPP = kapp;
  const collect = (formSlug, kql, maxPages = 12) => collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  const P = pathname.replace(apiPrefix, "") || "/";
  const url = new URL(req.url, "http://localhost");
  const qp = (k) => url.searchParams.get(k);
  const corrId = req.headers["x-correlation-id"] || `COR-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const apiErr = (status, code, message) => jsonResp(res, status, { error: { code, message, correlationId: corrId } });
  const cnt = (arr, pred) => arr.filter(pred).length;
  const groupBy = (rows, field) => { const m = {}; rows.forEach((r) => { const k = vf(r, field) || "—"; m[k] = (m[k] || 0) + 1; }); return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count); };

  try {
    // ════════════════════════════════════════════════════════════════════════
    // GET /dashboard — executive QMS rollup
    // ════════════════════════════════════════════════════════════════════════
    if (P === "/dashboard" && req.method === "GET") {
      const data = await cached("dashboard", 5 * 60 * 1000, async () => {
        const [events, ncs, capas, complaints, audits, findings, docs, changes, training, scars, suppliers, risks, equipment] = await Promise.all([
          collect("quality-events"), collect("nonconformances"), collect("capas"), collect("complaints"),
          collect("audits"), collect("audit-findings"), collect("documents"), collect("change-requests"),
          collect("training-records"), collect("scars"), collect("suppliers"), collect("risks"), collect("equipment"),
        ]);
        const openCapas = capas.filter((c) => vf(c, "Status") !== "Closed");
        const openEvents = events.filter((e) => !["Closed", "Rejected"].includes(vf(e, "Status")));
        const openComplaints = complaints.filter((c) => vf(c, "Status") !== "Closed");
        const openNcs = ncs.filter((n) => vf(n, "Status") !== "Closed");

        // CAPA aging buckets (open CAPAs by age since opened)
        const capaAging = [["0-30d", 0], ["31-60d", 0], ["61-90d", 0], ["90d+", 0]];
        let cycleSum = 0, cycleN = 0;
        capas.forEach((c) => {
          if (vf(c, "Status") === "Closed") { const op = daysSince(vf(c, "Opened Date")), cl = daysSince(vf(c, "Closed Date")); if (op != null && cl != null) { cycleSum += (op - cl); cycleN++; } }
          else { const a = daysSince(vf(c, "Opened Date")) || 0; if (a <= 30) capaAging[0][1]++; else if (a <= 60) capaAging[1][1]++; else if (a <= 90) capaAging[2][1]++; else capaAging[3][1]++; }
        });
        const effFailed = capas.filter((c) => vf(c, "Effectiveness Result") === "Failed").length;
        const reopened = capas.filter((c) => vf(c, "Reopened") === "Yes").length;

        // supplier scorecards
        const supplierScores = suppliers.map((s) => ({
          id: s.id, sid: vf(s, "Supplier ID"), name: vf(s, "Name"), risk: vf(s, "Risk Class"), approval: vf(s, "Approval Status"),
          score: num(vf(s, "Score")), onTime: num(vf(s, "On Time Pct")), ppm: num(vf(s, "PPM Defect")), openScars: num(vf(s, "Open SCARs")),
        })).sort((a, b) => a.score - b.score);

        // training compliance
        const trainTotal = training.length;
        const trainOverdue = training.filter((t) => vf(t, "Status") === "Overdue" || (vf(t, "Status") !== "Completed" && isOverdue(vf(t, "Due Date")))).length;
        const trainDone = training.filter((t) => vf(t, "Status") === "Completed").length;

        // calibration compliance
        const calOverdue = equipment.filter((e) => isOverdue(vf(e, "Calibration Due"))).length;
        const oot = equipment.filter((e) => vf(e, "Out Of Tolerance") === "Yes").length;

        return {
          generatedAt: new Date(TODAY).toISOString().slice(0, 10),
          kpis: {
            openEvents: openEvents.length, overdueEvents: cnt(openEvents, (e) => isOverdue(vf(e, "Due Date"))),
            openCapas: openCapas.length, overdueCapas: cnt(openCapas, (c) => isOverdue(vf(c, "Due Date"))),
            openNcs: openNcs.length, openComplaints: openComplaints.length,
            reportableOpen: cnt(openComplaints, (c) => vf(c, "Reportable") === "Yes"),
            regOverdue: cnt(complaints, (c) => vf(c, "Reportable") === "Yes" && vf(c, "Status") !== "Closed" && isOverdue(vf(c, "Regulatory Due Date"))),
            openScars: cnt(scars, (s) => !["Closed", "Accepted"].includes(vf(s, "Status"))),
            escalatedScars: cnt(scars, (s) => vf(s, "Escalated") === "Yes"),
            openFindings: cnt(findings, (f) => vf(f, "Status") !== "Closed"),
            majorFindings: cnt(findings, (f) => vf(f, "Classification") === "Major" && vf(f, "Status") !== "Closed"),
            docsReviewOverdue: cnt(docs, (d) => vf(d, "Status") === "Effective" && isOverdue(vf(d, "Review Due Date"))),
            openChanges: cnt(changes, (c) => !["Closed", "Rejected"].includes(vf(c, "Status"))),
            trainOverdue, trainCompliance: trainTotal ? Math.round((trainTotal - trainOverdue) / trainTotal * 100) : 100,
            calOverdue, oot, calCompliance: equipment.length ? Math.round((equipment.length - calOverdue) / equipment.length * 100) : 100,
            effFailed, reopened, avgCapaCycle: cycleN ? Math.round(cycleSum / cycleN) : 0,
            highRisks: cnt(risks, (r) => vf(r, "Risk Level") === "High" && vf(r, "Status") !== "Controlled"),
          },
          capaAging: capaAging.map(([bucket, count]) => ({ bucket, count })),
          eventsByType: groupBy(openEvents, "Type"),
          eventsBySite: groupBy(openEvents, "Site"),
          capaByStatus: groupBy(openCapas, "Status"),
          capaBySource: groupBy(capas, "Source"),
          complaintsByProduct: groupBy(complaints, "Product").slice(0, 8),
          findingsByClass: groupBy(findings, "Classification"),
          risksByLevel: groupBy(risks, "Risk Level"),
          worstSuppliers: supplierScores.slice(0, 8),
          supplierRisk: groupBy(suppliers, "Risk Class"),
          overdueQueue: [...openCapas.filter((c) => isOverdue(vf(c, "Due Date"))).map((c) => ({ type: "CAPA", form: "capas", id: c.id, bid: vf(c, "CAPA ID"), title: vf(c, "Title"), owner: vf(c, "Owner"), due: vf(c, "Due Date"), overdue: -daysUntil(vf(c, "Due Date")) })),
          ...openEvents.filter((e) => isOverdue(vf(e, "Due Date"))).map((e) => ({ type: "Event", form: "quality-events", id: e.id, bid: vf(e, "Event ID"), title: vf(e, "Title"), owner: vf(e, "Owner"), due: vf(e, "Due Date"), overdue: -daysUntil(vf(e, "Due Date")) }))]
            .sort((a, b) => b.overdue - a.overdue).slice(0, 12),
          counts: { events: events.length, ncs: ncs.length, capas: capas.length, complaints: complaints.length, audits: audits.length, findings: findings.length, docs: docs.length, changes: changes.length, training: training.length, scars: scars.length, suppliers: suppliers.length, risks: risks.length, equipment: equipment.length },
        };
      });
      return jsonResp(res, 200, data), true;
    }

    // ════════════════════════════════════════════════════════════════════════
    // GET /mywork?user=NAME — personal queue
    // ════════════════════════════════════════════════════════════════════════
    if (P === "/mywork" && req.method === "GET") {
      const user = qp("user") || "";
      const esc = (s) => String(s).replace(/"/g, '\\"');
      const ownerQ = user ? `values[Owner]="${esc(user)}"` : "";
      const [capas, events, ncs, complaints, findings, changes, scars] = await Promise.all([
        collect("capas", ownerQ), collect("quality-events", ownerQ), collect("nonconformances", ownerQ),
        collect("complaints", ownerQ), collect("audit-findings", ownerQ), collect("change-requests", ownerQ), collect("scars", ownerQ),
      ]);
      const mk = (form, type, idF, titleF, rows) => rows.filter((r) => !["Closed", "Rejected", "Accepted"].includes(vf(r, "Status")))
        .map((r) => ({ form, type, id: r.id, bid: vf(r, idF), title: vf(r, titleF), status: vf(r, "Status"), due: vf(r, "Due Date") || vf(r, "Regulatory Due Date") || vf(r, "Response Due Date"), overdue: isOverdue(vf(r, "Due Date") || vf(r, "Regulatory Due Date") || vf(r, "Response Due Date")) }));
      const all = [
        ...mk("capas", "CAPA", "CAPA ID", "Title", capas),
        ...mk("quality-events", "Event", "Event ID", "Title", events),
        ...mk("nonconformances", "NC", "NC ID", "Title", ncs),
        ...mk("complaints", "Complaint", "Complaint ID", "Title", complaints),
        ...mk("audit-findings", "Finding", "Finding ID", "Title", findings),
        ...mk("change-requests", "Change", "Change ID", "Title", changes),
        ...mk("scars", "SCAR", "SCAR ID", "Title", scars),
      ];
      return jsonResp(res, 200, {
        user, total: all.length, overdue: all.filter((a) => a.overdue),
        work: all.sort((a, b) => (b.overdue - a.overdue) || String(a.due).localeCompare(String(b.due))),
        byType: Object.entries(all.reduce((m, a) => ((m[a.type] = (m[a.type] || 0) + 1), m), {})).map(([type, count]) => ({ type, count })),
      }), true;
    }

    // ════════════════════════════════════════════════════════════════════════
    // GET /record360/:form/:subId — traceability for one record
    // ════════════════════════════════════════════════════════════════════════
    const r360 = P.match(/^\/record360\/([^/]+)\/(.+)$/);
    if (r360 && req.method === "GET") {
      const form = decodeURIComponent(r360[1]), subId = decodeURIComponent(r360[2]);
      const r = await kineticRequest("GET", `/submissions/${subId}?include=values,form`, null, auth);
      const rec = r.data?.submission;
      if (!rec) return apiErr(404, "not_found", "Record not found"), true;
      const meta = Object.values(PREFIX_MAP).find((m) => m.form === form) || { idField: Object.keys(rec.values || {})[0], label: form };
      const bid = vf(rec, meta.idField);
      const esc = (s) => String(s).replace(/"/g, '\\"');

      const nodes = new Map(), edges = [];
      const addNode = (id, type, label, status, f, sub) => { if (id && !nodes.has(id)) nodes.set(id, { id, type, label, status, form: f, subId: sub }); };
      addNode(bid, meta.label, vf(rec, "Title") || bid, vf(rec, "Status"), form, subId);

      // outgoing references from this record
      const outgoing = [];
      Object.entries(rec.values || {}).forEach(([fld, val]) => {
        const tok = firstToken(val);
        if (tok && PREFIX_MAP[tok.split("-")[0]] && tok !== bid) outgoing.push({ field: fld, ref: tok });
      });

      // reverse scan: which records reference this bid.
      // One INDEXED lookup per (form, link field) — NOT an unfiltered full-form scan.
      // Clean-ID fields use `=` (equality, pagination-safe). Composite "ID - Name" fields
      // (Product/Supplier/Linked Product) use `=*` + orderBy, and only when the clicked
      // record's id-prefix can actually match that field's entity type.
      const bidPrefix = String(bid).split("-")[0];
      const revLookup = async (f, field) => {
        try {
          if (COMPOSITE_LINK.has(field)) {
            if (COMPOSITE_LINK.get(field) !== bidPrefix) return [];        // e.g. Product only holds PRD-*
            const q = encodeURIComponent(`values[${field}] =* "${esc(bid)}"`);
            const ob = encodeURIComponent(`values[${field}]`);
            const r = await kineticRequest("GET", `/kapps/${KAPP}/forms/${f}/submissions?include=values,details&limit=100&q=${q}&orderBy=${ob}`, null, auth);
            return r.data?.submissions || [];
          }
          return await collect(f, `values[${field}]="${esc(bid)}"`, 2);
        } catch { return []; }
      };
      const revPairs = [];
      for (const f of RELATED_FORMS) for (const field of (LINK_FIELDS[f] || [])) revPairs.push({ f, field });
      const revRows = await Promise.all(revPairs.map(({ f, field }) => revLookup(f, field).then((rows) => ({ f, field, rows }))));
      revRows.forEach(({ f, field, rows }) => {
        const m = Object.values(PREFIX_MAP).find((x) => x.form === f) || { idField: "", label: f };
        rows.forEach((row) => {
          const rid = vf(row, m.idField) || row.id;
          if (rid === bid) return;
          addNode(rid, m.label, vf(row, "Title") || rid, vf(row, "Status"), f, row.id);
          edges.push({ from: rid, to: bid, rel: field });
        });
      });

      // resolve outgoing refs to nodes (in parallel — each is an indexed id lookup)
      const outResolved = await Promise.all(outgoing.map(async (o) => {
        const pm = PREFIX_MAP[o.ref.split("-")[0]];
        if (!pm) return null;
        const rr = await collect(pm.form, `values[${pm.idField}]="${esc(o.ref)}"`, 2).catch(() => []);
        return { o, pm, hitRow: rr[0] };
      }));
      outResolved.forEach((x) => {
        if (!x) return;
        const { o, pm, hitRow } = x;
        addNode(o.ref, pm.label, hitRow ? (vf(hitRow, "Title") || vf(hitRow, "Name") || o.ref) : o.ref, hitRow ? vf(hitRow, "Status") : "", pm.form, hitRow ? hitRow.id : null);
        edges.push({ from: bid, to: o.ref, rel: o.field });
      });

      // timeline (audit trail) + signatures
      const [trail, sigs, actions] = await Promise.all([
        collect("audit-trail", `values[Record ID]="${esc(bid)}"`, 4),
        collect("esignatures", `values[Record ID]="${esc(bid)}"`, 2),
        form === "capas" ? collect("capa-actions", `values[CAPA ID]="${esc(bid)}"`, 4) : Promise.resolve([]),
      ]);

      return jsonResp(res, 200, {
        record: rec, businessId: bid, label: meta.label,
        graph: { nodes: [...nodes.values()], edges: edges.filter((e, i, a) => a.findIndex((x) => x.from === e.from && x.to === e.to && x.rel === e.rel) === i) },
        related: [...nodes.values()].filter((n) => n.id !== bid),
        actions: actions.sort((a, b) => String(vf(a, "Action ID")).localeCompare(vf(b, "Action ID"))).map((a) => ({ id: vf(a, "Action ID"), title: vf(a, "Title"), type: vf(a, "Type"), owner: vf(a, "Owner"), status: vf(a, "Status"), due: vf(a, "Due Date"), verification: vf(a, "Verification") })),
        timeline: trail.map((t) => ({ actor: vf(t, "Actor"), action: vf(t, "Action"), field: vf(t, "Field"), oldV: vf(t, "Old Value"), newV: vf(t, "New Value"), reason: vf(t, "Reason"), state: vf(t, "Workflow State"), ts: vf(t, "Timestamp"), corr: vf(t, "Correlation ID") }))
          .sort((a, b) => String(b.ts).localeCompare(String(a.ts))),
        signatures: sigs.map((s) => ({ id: vf(s, "Signature ID"), signer: vf(s, "Signer Name"), meaning: vf(s, "Meaning"), reason: vf(s, "Reason"), version: vf(s, "Record Version"), method: vf(s, "Auth Method"), date: vf(s, "Signed Date"), hash: vf(s, "Hash") }))
          .sort((a, b) => String(b.date).localeCompare(String(a.date))),
      }), true;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Versioned WebAPI  /v1/...
    // ════════════════════════════════════════════════════════════════════════
    const v1 = P.match(/^\/v1\/([a-z-]+)$/);
    if (v1) {
      const resource = v1[1];
      const RES = {
        "quality-events": { form: "quality-events", idField: "Event ID", filters: ["Status", "Type", "Severity", "Site", "Owner"] },
        "capas": { form: "capas", idField: "CAPA ID", filters: ["Status", "Type", "Risk Level", "Site", "Owner"] },
        "complaints": { form: "complaints", idField: "Complaint ID", filters: ["Status", "Reportable", "Product", "Owner"] },
        "suppliers": { form: "suppliers", idField: "Supplier ID", filters: ["Approval Status", "Risk Class", "Category", "Country"] },
      };

      // --- metrics contract (computed directly; bounded server-side collects) ---
      if (resource === "metrics" && req.method === "GET") {
        const [capas, complaints, scars, training] = await Promise.all([collect("capas"), collect("complaints"), collect("scars"), collect("training-records")]);
        return jsonResp(res, 200, {
          apiVersion: "1.0", correlationId: corrId, generatedAt: new Date(TODAY).toISOString(),
          metrics: {
            openCapas: cnt(capas, (c) => vf(c, "Status") !== "Closed"),
            overdueCapas: cnt(capas, (c) => vf(c, "Status") !== "Closed" && isOverdue(vf(c, "Due Date"))),
            effectivenessFailed: cnt(capas, (c) => vf(c, "Effectiveness Result") === "Failed"),
            openComplaints: cnt(complaints, (c) => vf(c, "Status") !== "Closed"),
            reportableOpen: cnt(complaints, (c) => vf(c, "Reportable") === "Yes" && vf(c, "Status") !== "Closed"),
            openScars: cnt(scars, (s) => !["Closed", "Accepted"].includes(vf(s, "Status"))),
            trainingCompliancePct: training.length ? Math.round(cnt(training, (t) => vf(t, "Status") === "Completed") / training.length * 100) : 100,
          },
        }), true;
      }

      const cfg = RES[resource];
      if (!cfg) return apiErr(404, "unknown_resource", `Unknown resource '${resource}'`), true;

      // --- GET list (paginated, filterable) ---
      if (req.method === "GET") {
        const limit = Math.min(100, Math.max(1, parseInt(qp("limit") || "25", 10)));
        const esc = (s) => String(s).replace(/"/g, '\\"');
        const clauses = cfg.filters.filter((f) => qp(f.replace(/\s/g, "_")) != null || qp(f) != null)
          .map((f) => `values[${f}]="${esc(qp(f.replace(/\s/g, "_")) ?? qp(f))}"`);
        let q = clauses.join(" AND ");
        const pageToken = qp("pageToken");
        let apiPath = `/kapps/${KAPP}/forms/${cfg.form}/submissions?include=values,details&limit=${limit}`;
        if (q) apiPath += `&q=${encodeURIComponent(q)}`;
        if (pageToken) apiPath += `&pageToken=${encodeURIComponent(pageToken)}`;
        const rr = await kineticRequest("GET", apiPath, null, auth);
        if (rr.status >= 300) return apiErr(rr.status, "upstream_error", "Query failed"), true;
        return jsonResp(res, 200, {
          apiVersion: "1.0", correlationId: corrId,
          data: (rr.data?.submissions || []).map((s) => ({ id: s.id, businessId: vf(s, cfg.idField), createdAt: s.createdAt, updatedAt: s.updatedAt, values: s.values })),
          pagination: { limit, nextPageToken: rr.data?.nextPageToken || null },
        }), true;
      }

      // --- POST intake (idempotent) for quality-events ---
      if (req.method === "POST" && resource === "quality-events") {
        const idemKey = req.headers["idempotency-key"];
        if (idemKey && _cache.has("idem:" + idemKey)) return jsonResp(res, 200, _cache.get("idem:" + idemKey).v), true;
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.Title) return apiErr(400, "validation_error", "Title is required"), true;
        const eid = body["Event ID"] || `QE-EXT-${Date.now().toString(36)}`;
        const values = { "Event ID": eid, Status: "Open", Source: "API", "Reported Date": new Date(TODAY).toISOString().slice(0, 10), ...body };
        const cr = await kineticRequest("POST", `/kapps/${KAPP}/forms/quality-events/submissions`, { values, coreState: "Submitted" }, auth);
        if (cr.status >= 300) return apiErr(cr.status, "create_failed", "Could not create event"), true;
        const result = { apiVersion: "1.0", correlationId: corrId, id: cr.data?.submission?.id, businessId: eid, status: "created" };
        if (idemKey) _cache.set("idem:" + idemKey, { t: Date.now(), v: result });
        return jsonResp(res, 201, result), true;
      }

      return apiErr(405, "method_not_allowed", `${req.method} not supported on ${resource}`), true;
    }

    return false;
  } catch (e) {
    return jsonResp(res, 500, { error: { code: "internal_error", message: e.message, correlationId: corrId } }), true;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Standalone mode — own port (3021) for development / dedicated hosting
// ════════════════════════════════════════════════════════════════════════════
if (import.meta.url === `file://${process.argv[1]}`) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const http = await import("node:http");
  const https = await import("node:https");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const PORT = process.env.PORT || 3021;
  const KINETIC = (process.env.KINETIC_URL || "https://ai-labs.kinopsdev.io").replace(/\/+$/, "");
  const __dir = path.dirname(new URL(import.meta.url).pathname);

  function kineticRequest(method, apiPath, body, authHeader) {
    return new Promise((resolve, reject) => {
      const u = new URL(`/app/api/v1${apiPath}`, KINETIC);
      const headers = { "Content-Type": "application/json" };
      if (authHeader) headers["Authorization"] = authHeader;
      const payload = body ? JSON.stringify(body) : null;
      if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
      const r = https.request(u, { method, headers }, (rs) => {
        const c = []; rs.on("data", (d) => c.push(d));
        rs.on("end", () => { const t = Buffer.concat(c).toString(); try { resolve({ status: rs.statusCode, data: JSON.parse(t) }); } catch { resolve({ status: rs.statusCode, data: t }); } });
      });
      r.on("error", reject); if (payload) r.write(payload); r.end();
    });
  }
  function jsonResp(res, status, data) { res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }); res.end(JSON.stringify(data)); }
  function readBody(req) { return new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c).toString())); }); }
  async function collectByQuery(kappSlug, formSlug, kql, authHeader, maxPages = 12) {
    const all = []; const seen = new Set(); let last = null;
    for (let i = 0; i < maxPages; i++) {
      let apiPath = `/kapps/${kappSlug}/forms/${formSlug}/submissions?include=values,details&limit=25`;
      let q = kql || "";
      // <= (not <) so records sharing the boundary createdAt aren't skipped; seen-set dedupes the overlap.
      if (last) q = (q ? "(" + q + ") AND " : "") + `createdAt <= "${last}"`;
      if (q) apiPath += `&q=${encodeURIComponent(q)}`;
      const r = await kineticRequest("GET", apiPath, null, authHeader);
      const subs = r.data?.submissions || []; let added = 0;
      for (const s of subs) { if (!seen.has(s.id)) { seen.add(s.id); all.push(s); added++; } }
      if (subs.length) last = subs[subs.length - 1].createdAt;
      if (added === 0 && i > 0) break; // entire page was overlap — timestamp plateau, stop
      if (!r.data?.nextPageToken || subs.length < 25) break;
    }
    return all;
  }
  const helpers = { kineticRequest, jsonResp, readBody, collectByQuery, vf: (s, f) => s.values?.[f] || "" };

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }); res.end(); return; }
    if (pathname.startsWith(apiPrefix)) { if (await handleAPI(req, res, pathname, req.headers.authorization, helpers)) return; res.writeHead(404); res.end("No route"); return; }
    if (pathname.startsWith("/app/")) {
      const u = new URL(req.url, KINETIC);
      const headers = { ...req.headers, host: u.host }; delete headers.origin; delete headers.referer;
      const body = await readBody(req);
      const pr = https.request(u, { method: req.method, headers }, (pres) => { res.writeHead(pres.statusCode, { ...pres.headers, "access-control-allow-origin": "*" }); pres.pipe(res); });
      pr.on("error", (e) => { res.writeHead(502); res.end(e.message); });
      if (body.length) pr.write(body); pr.end(); return;
    }
    let fp = path.join(__dir, pathname === "/" ? "/index.html" : pathname);
    try { const c = fs.readFileSync(fp); res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(fp)] || "application/octet-stream" }); res.end(c); }
    catch { res.writeHead(404); res.end("Not found"); }
  });
  server.listen(PORT, () => console.log(`\n  Kinetic MedQMS (ncrmanager): http://localhost:${PORT}  → ${KINETIC}\n`));
}
