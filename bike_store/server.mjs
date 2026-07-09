/**
 * Bike Store — server-side handler for edits + AI audit log.
 *
 * Endpoints:
 *   PUT  /api/bike-store/save/:form/:id     Save edits to a submission, write audit log entry
 *   GET  /api/bike-store/history/:form/:id  Get audit log entries for a record
 *
 * Edits go through this endpoint (not raw Core API PUT) so we can compute the
 * diff, generate an AI-narrated description, and persist an audit-log entry.
 */

export const appId = "bike-store";
export const apiPrefix = "/api/bike-store";
export const kapp = "bike-store";

// Field label fallback per form — which value is the human-readable label
const RECORD_LABEL_FIELD = {
  "warehouses": "Code",
  "products": "SKU",
  "inventory": null, // built from Warehouse Code / Product SKU
  "shipments": "Order Number",
  "transfers": "Transfer Number",
  "bike-trails": "Name",
};

function recordLabel(formSlug, values) {
  if (formSlug === "inventory") {
    return `${values["Warehouse Code"] || "?"}/${values["Product SKU"] || "?"}`;
  }
  const f = RECORD_LABEL_FIELD[formSlug];
  return f && values && values[f] ? values[f] : "(unlabeled)";
}

/* ── AI-style description generator ─────────────────────────────────
 * Deterministic but natural-sounding narrative. Tries to read like a
 * human change-log entry. If ANTHROPIC_API_KEY is set in env, swap in a
 * real LLM call here — the rest of the audit pipeline doesn't care
 * where the description comes from.
 */
function generateDescription(formSlug, recordLabelStr, action, diff, user) {
  if (action === "Created") {
    return `${user} created ${friendlyForm(formSlug)} ${recordLabelStr}.`;
  }
  if (action === "Deleted") {
    return `${user} deleted ${friendlyForm(formSlug)} ${recordLabelStr}.`;
  }
  if (!diff.length) return `${user} touched ${friendlyForm(formSlug)} ${recordLabelStr} without changing any fields.`;

  // One field? Be specific and conversational.
  if (diff.length === 1) {
    const d = diff[0];
    return `${user} ${verbFor(d.field, d.before, d.after)} on ${friendlyForm(formSlug)} ${recordLabelStr}.`;
  }

  // Multiple fields — list them, prefer narrative for headline change first.
  const headline = pickHeadline(diff);
  const others = diff.filter(d => d !== headline);
  const lead = `${user} ${verbFor(headline.field, headline.before, headline.after)}`;
  const tail = others.length === 1
    ? ` and updated ${others[0].field}`
    : ` and updated ${others.length} other field${others.length === 1 ? '' : 's'} (${others.slice(0, 3).map(d => d.field).join(', ')}${others.length > 3 ? ', …' : ''})`;
  return `${lead}${tail} on ${friendlyForm(formSlug)} ${recordLabelStr}.`;
}

function friendlyForm(slug) {
  return ({
    "warehouses": "warehouse",
    "products": "product",
    "inventory": "inventory line",
    "shipments": "shipment",
    "transfers": "transfer",
    "bike-trails": "trail",
  })[slug] || slug;
}

function pickHeadline(diff) {
  // Prefer status, then quantities, then anything else
  const priority = ["Status", "Action", "On Hand", "Reserved", "Quantity", "Price", "Tracking Number", "Carrier", "Ship Date", "Est Delivery Date"];
  for (const p of priority) {
    const m = diff.find(d => d.field === p);
    if (m) return m;
  }
  return diff[0];
}

function verbFor(field, before, after) {
  const b = before == null ? "" : String(before);
  const a = after == null ? "" : String(after);
  // Status-style transitions read as "moved from X to Y"
  if (/status|action/i.test(field)) {
    if (!b && a) return `set ${field} to "${a}"`;
    if (b && !a) return `cleared ${field} (was "${b}")`;
    return `moved ${field} from "${b}" to "${a}"`;
  }
  // Numeric fields → increased / decreased
  const bn = parseFloat(b), an = parseFloat(a);
  if (!isNaN(bn) && !isNaN(an) && b !== "" && a !== "") {
    if (an > bn) return `increased ${field} from ${b} to ${a} (+${an - bn})`;
    if (an < bn) return `decreased ${field} from ${b} to ${a} (-${bn - an})`;
  }
  if (!b && a) return `set ${field} to "${a}"`;
  if (b && !a) return `cleared ${field} (was "${b}")`;
  return `changed ${field} from "${b}" to "${a}"`;
}

function computeDiff(before, after) {
  // before/after are values maps. Only report fields that actually changed.
  const out = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const b = before?.[k];
    const a = after?.[k];
    if (b === a) continue;
    if (b == null && a === "") continue;
    if (b === "" && a == null) continue;
    out.push({ field: k, before: b ?? "", after: a ?? "" });
  }
  return out;
}

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { kineticRequest, jsonResp, readBody, collectByQuery } = helpers;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(kapp, formSlug, kql, auth, maxPages);
  }

  // PUT /api/bike-store/save/:form/:id — save edits + write audit entry
  const saveMatch = pathname.match(/^\/api\/bike-store\/save\/([^/]+)\/([^/]+)$/);
  if (saveMatch && req.method === "PUT") {
    const formSlug = decodeURIComponent(saveMatch[1]);
    const id = decodeURIComponent(saveMatch[2]);
    const bodyText = await readBody(req);
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { jsonResp(res, 400, { error: 'Invalid JSON' }); return true; }
    const newValues = body.values || {};
    if (!Object.keys(newValues).length) {
      jsonResp(res, 400, { error: 'No values to save' });
      return true;
    }

    try {
      // 1. Fetch BEFORE state — use the generic /submissions/{id} endpoint;
      // the form-scoped path only works while the submission is in Draft state.
      const beforeRes = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      if (beforeRes.status >= 300) {
        jsonResp(res, beforeRes.status, { error: `Could not load record before save: ${beforeRes.status}` });
        return true;
      }
      const beforeValues = beforeRes.data?.submission?.values || {};

      // 2. Compute requested-change diff — only fields the user actually sent.
      // (computeDiff over the full union would treat unspecified fields as "cleared".)
      const diff = computeDiff(
        Object.fromEntries(Object.keys(newValues).map(k => [k, beforeValues[k] ?? ""])),
        newValues
      );

      // 3. PUT requires the full values map — it REPLACES, not merges. Build a merged
      // payload of beforeValues + newValues so unspecified fields (especially required
      // ones like Code/Name) aren't blanked out.
      const merged = { ...beforeValues, ...newValues };
      const putRes = await kineticRequest("PUT", `/submissions/${id}`, { values: merged }, auth);
      if (putRes.status >= 300) {
        jsonResp(res, putRes.status, { error: `Save failed: ${putRes.status}`, detail: putRes.data });
        return true;
      }

      // 4. Re-fetch to see what actually persisted (security policies may strip fields silently)
      const afterFetch = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const afterValues = afterFetch.data?.submission?.values || {};
      const persisted = computeDiff(beforeValues, afterValues);
      // Fields the client wanted to change that didn't actually move
      const ignored = diff.filter(d => !persisted.find(p => p.field === d.field && p.after === d.after));

      // 5. Identify the user (from /me)
      let user = "unknown";
      try {
        const me = await kineticRequest("GET", "/me", null, auth);
        user = me.data?.displayName || me.data?.username || "unknown";
      } catch {}

      // 6. Generate audit description (AI-style narrative)
      const label = recordLabel(formSlug, { ...beforeValues, ...newValues });
      const description = persisted.length
        ? generateDescription(formSlug, label, "Updated", persisted, user)
        : `${user} attempted to update ${friendlyForm(formSlug)} ${label} but no fields persisted (likely permission policy).`;

      // 7. Write audit-log entry
      await kineticRequest("POST", `/kapps/${kapp}/forms/audit-log/submissions`, {
        values: {
          "Record ID": id,
          "Form Slug": formSlug,
          "Record Label": label,
          "Action": persisted.length ? "Updated" : "Update Rejected",
          "Changed By": user,
          "Changed At": new Date().toISOString(),
          "Description": description,
          "Diff JSON": JSON.stringify(persisted),
        },
        coreState: "Submitted",
      }, auth).catch(() => {});

      jsonResp(res, 200, {
        ok: true,
        id,
        persisted,
        ignored: ignored.map(d => d.field),
        description,
        values: afterValues,
      });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: e.message });
      return true;
    }
  }

  // GET /api/bike-store/history/:form/:id — list audit-log entries for a record
  const histMatch = pathname.match(/^\/api\/bike-store\/history\/([^/]+)\/([^/]+)$/);
  if (histMatch && req.method === "GET") {
    const formSlug = decodeURIComponent(histMatch[1]);
    const id = decodeURIComponent(histMatch[2]);
    try {
      const kql = `values[Form Slug] = "${formSlug}" AND values[Record ID] = "${id}"`;
      const entries = await collect("audit-log", kql, 4);
      const records = (entries || []).map(e => {
        let diff = [];
        try { diff = JSON.parse(e.values?.["Diff JSON"] || "[]"); } catch {}
        return {
          id: e.id,
          recordId: e.values?.["Record ID"] || "",
          formSlug: e.values?.["Form Slug"] || "",
          recordLabel: e.values?.["Record Label"] || "",
          action: e.values?.["Action"] || "",
          changedBy: e.values?.["Changed By"] || "",
          changedAt: e.values?.["Changed At"] || "",
          description: e.values?.["Description"] || "",
          diff,
        };
      }).sort((a, b) => (b.changedAt || "").localeCompare(a.changedAt || ""));
      jsonResp(res, 200, { history: records, total: records.length });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: e.message });
      return true;
    }
  }

  return false;
}
