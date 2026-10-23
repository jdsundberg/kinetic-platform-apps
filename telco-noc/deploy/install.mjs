/**
 * install.mjs — idempotent installer for the Telco NOC kapp.
 *   1. kapp  2. forms (fields from app.json)  3. index definitions incl. UNIQUE, build + poll
 *   4. space user attribute definitions (NOC Tenant, NOC Role)
 *   5. kapp security policy definitions + form policy bindings (tenant isolation, role checks)
 * Re-running converges: existing objects are updated, never duplicated.
 * Usage: node deploy/install.mjs [--no-security]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { core, KAPP, ok } from "./lib.mjs";
import { POLICY_DEFS, FORM_POLICIES } from "./security.mjs";

const DIR = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const app = JSON.parse(fs.readFileSync(path.join(DIR, "app.json"), "utf-8"));
const log = (...a) => console.log(...a);
const SYS_IDX = ["closedBy", "createdBy", "handle", "submittedBy", "updatedBy"].map((n) => ({ name: n, parts: [n], unique: n === "handle" }));

function pages(fields) {
  const elements = fields.map((f) => ({
    type: "field", name: f.name, label: f.name, key: crypto.createHash("md5").update(f.name).digest("hex"),
    dataType: "string", renderType: "text", enabled: true, visible: true, required: !!f.required, rows: f.rows || 1,
    constraints: [], events: [], renderAttributes: {}, defaultDataSource: "none", defaultValue: "", defaultResourceName: "",
    requiredMessage: f.required ? `${f.name} is required` : "", omitWhenHidden: null, pattern: null,
  }));
  elements.push({ type: "button", name: "Submit Button", label: "Submit", renderType: "submit-page", visible: true, enabled: true, renderAttributes: {} });
  return [{ name: "Page 1", type: "page", renderType: "submittable", elements, events: [] }];
}

async function main() {
  log(`== Install ${app.name} (${KAPP}) ==`);
  if (process.argv.includes("--security-only")) return security();
  if (process.argv.includes("--indexes-only")) return indexes();
  let r = await core("POST", "/kapps", { name: app.name, slug: KAPP, status: "Active" });
  log(ok(r) ? "✓ kapp created" : r.data?.errorKey === "uniqueness_violation" || /already/.test(JSON.stringify(r.data)) ? "• kapp exists" : `✗ kapp ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);

  for (const form of app.forms) {
    const body = { slug: form.slug, name: form.name, description: form.description, status: "Active", submissionLabelExpression: form.submissionLabelExpression, pages: pages(form.fields) };
    r = await core("POST", `/kapps/${KAPP}/forms`, body);
    if (ok(r)) log(`✓ form ${form.slug} (${form.fields.length} fields)`);
    else {
      // converge: PUT fields/pages so added fields land on an existing form
      const u = await core("PUT", `/kapps/${KAPP}/forms/${form.slug}`, { name: form.name, description: form.description, submissionLabelExpression: form.submissionLabelExpression, pages: body.pages });
      log(ok(u) ? `• form ${form.slug} updated` : `✗ form ${form.slug} ${u.status} ${JSON.stringify(u.data).slice(0, 200)}`);
    }
  }

  await indexes();
  // (rest of install continues below)
  await afterIndexes();
}
async function indexes() {
  let r;
  for (const form of app.forms) {
    const ix = form.indexes;
    const defs = [...SYS_IDX];
    const custom = [];
    for (const p of ix.single) { defs.push({ parts: [p], unique: false }); custom.push(p); }
    for (const ps of ix.compound) { defs.push({ parts: ps, unique: false }); custom.push(ps.join(",")); }
    for (const ps of ix.unique) { defs.push({ parts: ps, unique: true }); custom.push(ps.join(",")); }
    r = await core("PUT", `/kapps/${KAPP}/forms/${form.slug}`, { indexDefinitions: defs });
    if (!ok(r)) { log(`✗ indexes ${form.slug} ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); continue; }
    const now = await core("GET", `/kapps/${KAPP}/forms/${form.slug}?include=indexDefinitions`);
    const toBuild = custom.filter((c) => !(now.data.form?.indexDefinitions || []).some((d) => d.parts.join(",") === c && d.status === "Built"));
    if (!toBuild.length) { log(`• ${form.slug}: ${custom.length} indexes already built`); continue; }
    await core("POST", `/kapps/${KAPP}/forms/${form.slug}/backgroundJobs`, { type: "Build Index", content: { indexes: toBuild } });
    let pending = toBuild.length;
    for (let w = 0; w < 30 && pending; w++) {
      await new Promise((res) => setTimeout(res, 1500));
      const c = await core("GET", `/kapps/${KAPP}/forms/${form.slug}?include=indexDefinitions`);
      pending = (c.data.form?.indexDefinitions || []).filter((d) => d.status !== "Built" && custom.includes(d.parts.join(","))).length;
    }
    log(pending ? `✗ ${form.slug}: ${pending} indexes not built` : `✓ ${form.slug}: ${custom.length} indexes built`);
  }

}
async function afterIndexes() {
  let r;
  // Space user attribute definitions (admin-set, trusted — never profile attributes)
  for (const name of ["NOC Tenant", "NOC Role"]) {
    r = await core("POST", "/userAttributeDefinitions", { name, allowsMultiple: name === "NOC Role", description: name === "NOC Tenant" ? "Telco NOC tenant isolation (admin-set)" : "Telco NOC role: Operator|Service Owner|Field Tech|Support Agent|Executive|Tenant Admin" });
    log(ok(r) ? `✓ user attribute ${name}` : `• user attribute ${name} (${r.status})`);
  }

  if (!process.argv.includes("--no-security")) await security();
  log("== done ==");
}
async function security() {
  let r;
  {
    for (const d of POLICY_DEFS) {
      r = await core("POST", `/kapps/${KAPP}/securityPolicyDefinitions`, d);
      if (!ok(r)) r = await core("PUT", `/kapps/${KAPP}/securityPolicyDefinitions/${encodeURIComponent(d.name)}`, d);
      log(ok(r) ? `✓ policy ${d.name}` : `✗ policy ${d.name} ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    for (const form of app.forms) {
      const pol = FORM_POLICIES(form.slug);
      r = await core("PUT", `/kapps/${KAPP}/forms/${form.slug}`, { securityPolicies: pol });
      log(ok(r) ? `✓ ${form.slug} policies: ${pol.map((p) => p.endpoint + "=" + p.name).join(", ")}` : `✗ ${form.slug} policies ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    }
  }
}
main();
