/**
 * gen-docs.mjs — generate docs/data-dictionary.md and docs/schemas/*.schema.json from model.mjs,
 * and (with --samples) docs/samples/*.json from the LIVE platform (real records of the last demo run).
 * Usage: node docs/gen-docs.mjs [--samples]
 */
import fs from "node:fs";
import path from "node:path";
import { FORMS, ENUMS, KAPP } from "../model.mjs";
import { indexesFor } from "../build.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const typeText = (t) => t.startsWith("enum:") ? `enum ${ENUMS[t.slice(5)].join(" \\| ")}` : t.startsWith("ref:") ? `ref → ${t.slice(4)}` :
  ({ id: "string (stable ID)", ts: "timestamp UTC ISO-8601 `Z`", date: "date YYYY-MM-DD", num: "decimal", int: "integer", bool: "Yes \\| No", json: "JSON (string)", text: "long text", str: "string", list: "comma-separated list", pii: "string — **PII**" })[t] || t;
const validation = (f) => f.v || (f.type.startsWith("enum:") ? "one of enum" : f.type === "ts" ? "ISO-8601 with Z; ≤ now+2 min" : f.type === "num" ? "finite number" : f.type === "int" ? "integer ≥ 0" : f.type === "bool" ? "Yes|No" : f.type === "json" ? "valid JSON" : f.type.startsWith("ref:") ? "must resolve in same tenant" : "");

// Designed-but-not-separately-implemented entities: where each lives in the pilot and why.
const MAPPED = [
  ["Organization", "Operator organization", "teams.Organization + tenants", "One operator org per tenant in pilot; multi-org tenants (MVNO + host) need an `organizations` form."],
  ["Organization", "User", "Kinetic platform users", "Identity is the platform's. NOC data keyed by username. Attributes `NOC Tenant` (single) and `NOC Role` (multi) are admin-set user attributes."],
  ["Organization", "Role", "user attribute NOC Role", "Operator, Service Owner, Field Tech, Support Agent, Executive, Tenant Admin. Enforced by KSL policies + server."],
  ["Organization", "Permission", "Kinetic KSL security policy definitions", "7 kapp-level definitions bound per form (Display / Submission Access / Submission Modification). See deploy/security.mjs."],
  ["Geography", "Region, Market", "geo-areas (Area Type)", "Hierarchy via Parent Area ID."],
  ["Geography", "Location, Address, Geospatial coordinates", "sites (Street/City/State/Postal Code, Latitude/Longitude WGS84, Geo Source)", "A location without equipment is a site of type Customer Premises or Fiber Hut."],
  ["Network", "Resource type", "ENUMS.RES_TYPE + Resource Class", "Fixed catalog in pilot; production: `resource-types` form with characteristic schema per type (TMF634)."],
  ["Network", "Port, Interface, Link, Circuit, Path, Network function", "resources (Resource Type = Optical Port / Interface / Ethernet Link / OTN Link / Circuit / Path / Network Function)", "One table specialised by type (TMF639 Resource pattern); type-specific attributes in Characteristics JSON."],
  ["Network", "Dependency relationship", "relationships", "Time-aware (Valid From/To), provenance (Source System, Last Verified At, Confidence), redundancy groups (OR) vs mandatory (AND)."],
  ["Services", "Service dependency", "relationships (From Kind = Service Instance)", "Same graph as resources so traversal is uniform."],
  ["Customers", "Contract", "subscriptions.Contract ID / Contract End", "Designed entity `contracts` (term, renewal, credit terms) deferred; SLA terms live on slas."],
  ["Customers", "Communication preference", "customers.Preferred Channel / Status Page Opt In + contacts.Preferred Channel / Notify On / Consent Recorded At", ""],
  ["Telemetry", "Metric definition", "engine/catalog.json `metrics` (canonical unit, accepted source units, healthy threshold)", "Versioned with the catalog."],
  ["Telemetry", "Event", "raw-alarms (every accepted source event, incl. non-alarm state events)", "Events are facts from a source; alarms are conditions with a lifecycle; incidents are the response."],
  ["Telemetry", "Health state", "resources.Health / service-instances.Health + computed propagation (engine/core.mjs propagate)", "Derived, never authoritative; recomputed from alarms + topology."],
  ["Operations", "Task, Escalation, Runbook execution", "incident-updates (Update Type = Escalation / Runbook Step / Field …) + incidents.Escalation Level", "Append-only timeline is the task/escalation log in pilot."],
  ["Operations", "Known error", "problems (Known Error = Yes, Workaround)", ""],
  ["Change", "Approval, Maintenance window, Deployment event, Rollback", "changes (Approver/Approved At, Window Start/End + Suppress Alarms, Timeline JSON, Implementation Result = Rolled Back, Rollback Plan)", ""],
  ["Field work", "Dispatch, Technician assignment, Site visit", "work-orders (Dispatch Approved By/Dispatched At, Assigned Tech/Crew, Accepted/Arrived/Completed At)", ""],
  ["Field work", "Inventory reservation", "parts.Qty Reserved + work-orders.Parts[].reservation", "Reserved at dispatch approval; fails closed on insufficient stock."],
  ["Field work", "Completion evidence", "work-orders.Evidence JSON (type, ref, capturedAt) + Findings + Completion Notes", "Files would be Kinetic attachments in production."],
  ["Communications", "Notification audience", "notifications.Audience JSON + Audience Size", "Computed from impacts (Confirmed/Inferred accounts) → contacts by Notify On; consumer segments → status page."],
  ["Communications", "Status update", "notifications (Sequence Initial/Update/Resolution) + incident-updates (Visibility = Customer)", ""],
  ["Governance", "Integration connection, Ingestion job", "integrations (Mode, Status, Last Success At, Freshness SLA) + raw-alarms.Replay Batch", "Connections themselves are Kinetic Integrator connections in production (credentials never in forms)."],
  ["Governance", "Operator feedback", "ai-recommendations (Status Accepted/Rejected, Feedback, Decided By/At)", "Rejections require a reason (the evaluation signal)."],
];

function dictionary() {
  const out = [`# Data Dictionary — ${KAPP.name}`, "", "_Generated from `model.mjs` by `docs/gen-docs.mjs` — the same declaration that creates the Kinetic forms and indexes, so this cannot drift from what is deployed._", "",
    "## Conventions (apply to every entity)", "",
    "- **Storage**: one Kinetic form per entity in kapp `telco-noc`; every value is stored as a string, typed and validated by the writer (ingest WebAPI, engine, server). Required fields are *also* enforced by the platform (`required: true` → 400 on submit).",
    "- **Stable internal ID**: the entity's `<X> ID` field (prefixed, never reused, never changed). **Unique per tenant** via a unique index `[Tenant ID, <X> ID]` → a retried create returns `uniqueness_violation` instead of duplicating. The Kinetic submission UUID is an implementation detail and is never used as a business key.",
    "- **External IDs**: `External IDs` JSON map (source → id) on inventory entities; the `identifiers` form is the authoritative cross-system mapping used by alarm resolution.",
    "- **Tenant scope**: `Tenant ID` on every row; every index leads with it; KSL policy `NOC Same Tenant` = `values('Tenant ID') === identity('attribute:NOC Tenant')`.",
    "- **Provenance** (inventory entities): `Source System`, `Last Seen At`, `Confidence` (0–1).",
    "- **Timestamps**: UTC ISO-8601 with `Z`, second precision. Display converts to tenant timezone.",
    "- **Audit**: every state change by a user, the engine, a workflow or the AI writes an `audit` row (append-only: `Submission Modification` = admins only). Timeline (`incident-updates`) is also append-only.",
    "- **Retention** (tenant policy, pilot defaults): raw events 30 d · metrics 30 d · alarms 400 d · incidents, impacts, notifications, audit 7 y. Purge job is designed, not implemented (see roadmap).", "",
    "## Entity index", "", "| Domain | Entity (form slug) | Purpose | Owner / source of truth |", "|---|---|---|---|",
    ...FORMS.map((f) => `| ${f.domain} | **${f.name}** (\`${f.slug}\`) | ${f.purpose} | ${f.owner} |`), "",
    "## Required entities that map onto the forms above", "", "| Domain | Required entity | Where it lives in the pilot | Notes |", "|---|---|---|---|",
    ...MAPPED.map((r) => `| ${r.join(" | ")} |`), ""];
  for (const f of FORMS) {
    const ix = indexesFor(f);
    const rels = f.fields.filter((x) => x.type.startsWith("ref:")).map((x) => `\`${x.name}\` → ${x.type.slice(4)} (many-to-one)`);
    const back = FORMS.flatMap((o) => o.fields.filter((x) => x.type === `ref:${f.slug}`).map((x) => `${o.slug}.\`${x.name}\` (one-to-many)`));
    const ex = Object.fromEntries(f.fields.filter((x) => x.ex !== undefined || x.def !== undefined).map((x) => [x.name, x.ex ?? x.def]));
    out.push(`---`, "", `## ${f.name} — \`${f.slug}\``, "", `**Purpose.** ${f.purpose}  `, `**Owning system.** ${f.owner}  `, `**Stable ID.** \`${f.idField}\`${f.idPrefix ? ` (prefix \`${f.idPrefix}\`)` : ""}, unique per tenant.  `,
      `**Lifecycle.** ${f.lifecycle}  `, `**Tenant / permissions.** Tenant-scoped; see deploy/security.mjs for the policy bound to this form.`, "",
      "| Field | Type | Req | Default | Validation | Example | Notes |", "|---|---|---|---|---|---|---|",
      ...f.fields.map((x) => `| ${x.name} | ${typeText(x.type)} | ${x.req ? "✔" : ""} | ${x.def ?? ""} | ${validation(x)} | ${x.ex !== undefined ? "`" + String(x.ex).replace(/\|/g, "\\|") + "`" : ""} | ${(x.d || "").replace(/\|/g, "\\|")} |`), "",
      `**Relationships.** ${[...rels, ...back].join(" · ") || "none"}  `,
      `**Indexes** (all tenant-led): ${[...ix.compound, ...ix.unique.map((u) => [...u, "(unique)"])].map((p) => "`" + p.join(" + ").replace(/values\[|\]/g, "") + "`").join(", ")}  `,
      `**Query patterns.** ${(f.filters || []).map((x) => `by ${x}`).join(", ") || "full tenant scan (small reference set)"}${f.compound ? "; combined: " + f.compound.map((c) => c.join(" + ")).join(", ") : ""}.`, "",
      "Example record:", "```json", JSON.stringify(ex, null, 1), "```", "");
  }
  out.push("---", "", "## Relationship diagram", "", "```mermaid", "erDiagram",
    ...FORMS.flatMap((f) => f.fields.filter((x) => x.type.startsWith("ref:") && x.type.slice(4) !== f.slug).map((x) => `  ${x.type.slice(4).replace(/-/g, "_")} ||--o{ ${f.slug.replace(/-/g, "_")} : "${x.name}"`)),
    '  resources ||--o{ relationships : "From ID (dependent) / To ID (supporting)"', '  service_instances ||--o{ relationships : "From ID (Service Instance)"', "```", "",
    "### The impact chain (time-aware)", "",
    "```", "raw-alarms ──(fingerprint)──▶ alarms ──(Correlation Group ID)──▶ correlation-groups ──(Incident ID)──▶ incidents",
    "                                                                        │ Root Resource ID", "                                                                        ▼",
    "resources ◀──(relationships: From depends on To, Valid From ≤ t < Valid To, redundancy groups)── resources … service-instances",
    "                                                                        │", "service-instances ──▶ subscriptions (active at t) ──▶ customers ──▶ slas → SLA exposure", "                                   │",
    "                                   └──▶ impacts (Confirmed / Inferred / Potential, path, basis, Topology As Of = incident Detected At)",
    "customers ──▶ contacts (Notify On) ──▶ notifications.Audience", "```", "");
  return out.join("\n");
}
fs.writeFileSync(path.join(DIR, "data-dictionary.md"), dictionary());

// JSON Schemas for the key contracts
const S = (id, title, props, required, extra = {}) => ({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: `https://noc.example/schemas/${id}.schema.json`, title, type: "object", properties: props, required, additionalProperties: false, ...extra });
const tsP = { type: "string", format: "date-time", pattern: "Z$", description: "UTC ISO-8601 with Z" };
const enumP = (k) => ({ type: "string", enum: ENUMS[k] });
function formSchema(slug, title) {
  const f = FORMS.find((x) => x.slug === slug);
  const props = Object.fromEntries(f.fields.map((x) => [x.name, x.type === "ts" ? tsP : x.type.startsWith("enum:") ? enumP(x.type.slice(5)) : x.type === "bool" ? { type: "string", enum: ["Yes", "No"] } : x.type === "num" ? { type: "string", pattern: "^-?\\d+(\\.\\d+)?$" } : x.type === "int" ? { type: "string", pattern: "^\\d+$" } : { type: "string", ...(x.d ? { description: x.d } : {}) }]));
  return S(slug, title, props, f.fields.filter((x) => x.req).map((x) => x.name), { description: `Kinetic submission values for form ${slug} (all values are strings on the wire). Schema version 1.0.` });
}
const schemas = {
  "event-ingestion": S("event-ingestion", "Event ingestion envelope v1.x (POST /app/kapps/telco-noc/webApis/ingest-event)", {
    schemaVersion: { type: "string", enum: ["1.0", "1.1"], description: "Minor versions are additive; unknown fields are ignored; major versions get a new WebAPI slug (ingest-event-v2)" },
    tenantId: { type: "string", pattern: "^[a-z0-9-]{3,32}$" }, source: { type: "string", description: "Registered source id (integrations form); drives severity/condition mapping" },
    sourceEventId: { type: "string", minLength: 1, description: "Unique within source; idempotency key = tenantId|source|sourceEventId" },
    eventTime: tsP, resourceRef: { type: "string", minLength: 1, description: "Identifier exactly as the source emits it; resolved through the identifiers form" },
    relatedResourceRef: { type: "string", description: "Peer resource named by the alarm (e.g. X2 neighbour)" }, condition: { type: "string", description: "Vendor condition code; mapped via engine/catalog.json conditionMap" },
    vendorSeverity: { type: "string", description: "Vendor-native severity; mapped via catalog severityMap; unmapped → Indeterminate + note" },
    state: { type: "string", enum: ["raise", "clear"], default: "raise" }, text: { type: "string", maxLength: 2000 }, attributes: { type: "object" }, replayBatch: { type: "string" },
  }, ["schemaVersion", "tenantId", "source", "sourceEventId", "eventTime", "resourceRef", "condition"], { additionalProperties: true }),
  "ingest-response": S("ingest-response", "ingest-event response", { status: { enum: ["accepted", "duplicate", "rejected"] }, kind: { enum: ["new", "repeat", "clear", "orphan-clear", "duplicate", "invalid", "unscoped"] },
    rawId: { type: "string" }, alarmId: { type: "string" }, fingerprint: { type: "string" }, resourceId: { type: "string" }, resourceMatch: enumP("RES_MATCH"), severity: enumP("SEVERITY"),
    late: { type: "boolean" }, clockSkew: { type: "boolean" }, errors: { type: "array", items: { type: "string" } }, notes: { type: "array", items: { type: "string" } } }, ["status"]),
  "normalized-alarm": formSchema("alarms", "Normalized alarm"), "topology-relationship": formSchema("relationships", "Topology relationship (time-aware)"),
  incident: formSchema("incidents", "Incident"), "impact-assessment": formSchema("impacts", "Impact assessment row"), "work-order": formSchema("work-orders", "Work order"),
  "metric-observation": S("metric-observation", "Metric observation (POST /api/noc/ingest/metrics observations[])", { subject: { type: "string" }, metric: { type: "string", enum: ["availability_pct", "packet_loss_pct", "latency_ms", "rx_power_dbm", "throughput_mbps"] },
    value: { type: "number" }, unit: { type: "string", description: "Source unit; converted to canonical via catalog.metrics[metric].from" }, observedAt: tsP, source: { type: "string" } }, ["subject", "metric", "value", "unit", "observedAt"]),
};
fs.mkdirSync(path.join(DIR, "schemas"), { recursive: true });
for (const [k, v] of Object.entries(schemas)) fs.writeFileSync(path.join(DIR, "schemas", `${k}.schema.json`), JSON.stringify(v, null, 2));
console.log(`data-dictionary.md (${FORMS.length} forms + ${MAPPED.length} mapped entities), ${Object.keys(schemas).length} schemas`);

if (process.argv.includes("--samples")) {
  const { search } = await import("../deploy/lib.mjs");
  const batch = fs.readFileSync(path.join(DIR, "../.last-batch"), "utf-8").trim();
  fs.mkdirSync(path.join(DIR, "samples"), { recursive: true });
  // one indexed query per form (tenant + batch), then filter in memory — no extra indexes just for doc export
  const B = `values[Tenant ID]="borealis" AND values[Replay Batch]="${batch}"`;
  const all = {}; for (const f of ["raw-alarms", "alarms", "correlation-groups", "incidents", "impacts", "work-orders", "notifications", "ai-recommendations"]) all[f] = (await search(f, B, { max: 1000 })).map((s) => s.values);
  const one = (f, pred) => all[f].filter(pred).slice(0, 1);
  const samples = {
    "raw-alarm": one("raw-alarms", (r) => r["Source System"] === "optical-ems" && r["Processing State"] === "Normalized"), "raw-alarm-rejected": one("raw-alarms", (r) => r["Processing State"] === "Rejected"),
    "raw-alarm-late": one("raw-alarms", (r) => r.Late === "Yes"), "alarm-root-evidence": one("alarms", (a) => a["Correlation Role"] === "Root Evidence"),
    "alarm-symptom-multisource": one("alarms", (a) => String(a["Source Systems"]).includes(",")), "alarm-suppressed": one("alarms", (a) => a["Correlation Role"] === "Suppressed"),
    "correlation-group": all["correlation-groups"].slice(0, 1), incident: all.incidents.slice(0, 1),
    "impact-confirmed": one("impacts", (i) => i["Impact Class"] === "Confirmed" && i["Account Name"] && i.Segment !== "Consumer Segment"), "impact-inferred": one("impacts", (i) => i["Impact Class"] === "Inferred"),
    "impact-potential-conflict": one("impacts", (i) => /RCN-/.test(i.Basis)), "work-order": all["work-orders"].slice(0, 1), notification: one("notifications", (n) => n.Sequence === "Initial"),
    "ai-recommendation": one("ai-recommendations", (r) => r.Kind === "Summary"),
    "topology-relationship-retired": (await search("relationships", `values[Tenant ID]="borealis" AND values[From ID]="CKT-DIA-10479"`)).map((s) => s.values),
  };
  for (const [k, v] of Object.entries(samples)) fs.writeFileSync(path.join(DIR, "samples", `${k}.json`), JSON.stringify(v.length === 1 ? v[0] : v, null, 2));
  console.log("samples:", Object.entries(samples).map(([k, v]) => `${k}(${v.length})`).join(" "));
}
