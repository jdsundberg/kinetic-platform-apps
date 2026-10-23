/**
 * build.mjs — generate app.json from model.mjs (the single declaration).
 * Index rule: every query is tenant-scoped, so every index leads with values[Tenant ID]:
 *   [Tenant] ; [Tenant, f] for each filter ; [Tenant, ...c] for each declared compound.
 * Usage: node build.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { KAPP, FORMS } from "./model.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const V = (n) => `values[${n}]`;

export function indexesFor(form) {
  const hasTenant = form.fields.some((x) => x.name === "Tenant ID");
  const lead = hasTenant ? [V("Tenant ID")] : [];
  const compound = [];
  const seen = new Set();
  const add = (parts) => { const k = parts.join("|"); if (!seen.has(k) && parts.length > 1) { seen.add(k); compound.push(parts); } };
  for (const f of form.filters || []) add([...lead, V(f)]);
  for (const c of form.compound || []) add([...lead, ...c.map(V)]);
  const single = hasTenant ? [V("Tenant ID")] : (form.filters || []).map(V);
  // Business ID is unique per tenant on EVERY form: retried writes (workflows, engine, replays) cannot duplicate.
  const uq = [...(form.unique || []), ...(form.idField ? [hasTenant && form.idField !== "Tenant ID" ? ["Tenant ID", form.idField] : [form.idField]] : [])];
  const unique = [...new Map(uq.map((u) => [u.join("|"), u.map(V)])).values()];
  return { single, compound, unique };
}

const app = {
  name: KAPP.name, slug: KAPP.slug, category: KAPP.category,
  description: "Telecom NOC: alarms → correlation → one incident → topology traversal → service & customer impact → field work → comms → verified recovery. Multi-tenant, provenance-aware, AI suggestions with citations.",
  icon: "radio-tower", color: "#0B2A4A", bg: "#E8EEF5",
  forms: FORMS.map((form) => ({
    slug: form.slug, name: form.name, description: form.purpose,
    submissionLabelExpression: form.label,
    fields: form.fields.map((x) => ({ name: x.name, required: !!x.req, ...(["text", "json"].includes(x.type) ? { rows: 3 } : {}) })),
    indexes: indexesFor(form),
  })),
};
fs.writeFileSync(path.join(DIR, "app.json"), JSON.stringify(app, null, 2));
const nIdx = app.forms.reduce((s, x) => s + x.indexes.single.length + x.indexes.compound.length + x.indexes.unique.length, 0);
console.log(`app.json: ${app.forms.length} forms, ${app.forms.reduce((s, x) => s + x.fields.length, 0)} fields, ${nIdx} index definitions`);
