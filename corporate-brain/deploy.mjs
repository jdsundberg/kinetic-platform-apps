// Repeatable, non-destructive deployment of the Corporate Brain kapp.
//   KINETIC_URL=https://ai-labs.kinopsdev.io KINETIC_USER=john KINETIC_PASS=… node apps/corporate-brain/deploy.mjs [--dry-run]
// Creates what is missing and adds what is new; never deletes forms, fields, indexes or submissions.
//   1. kapp            2. teams (Members / Reviewers / Admins)   3. security policy definitions
//   4. forms + fields  5. index definitions (merged, unique flags) + build   6. kapp/form security policies
import { FORMS, KAPP, SALES_FORMS, RFP_SCOPED_FORMS, toAppJson } from "./model.mjs";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.KINETIC_URL || "").replace(/\/+$/, "");
const USER = process.env.KINETIC_USER, PASS = process.env.KINETIC_PASS;
const DRY = process.argv.includes("--dry-run");
if (!BASE || !USER || !PASS) { console.error("Set KINETIC_URL, KINETIC_USER, KINETIC_PASS"); process.exit(1); }
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

async function api(method, p, body) {
  if (DRY && method !== "GET") { console.log(`  [dry-run] ${method} ${p}`); return { status: 200, data: {} }; }
  const r = await fetch(BASE + "/app/api/v1" + p, { method, headers: { Authorization: AUTH, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: r.status, data };
}
const ok = (m) => console.log("  ✓ " + m), warn = (m) => console.log("  • " + m), fail = (m) => { console.log("  ✗ " + m); process.exitCode = 1; };

export const TEAMS = ["Corporate Brain", "Corporate Brain::Members", "Corporate Brain::Reviewers", "Corporate Brain::Admins",
  // Sales Brain audiences (John, 2026-10-27). Sales, Legal and Executive may see deal-level prices; Marketing sees the playbook only.
  // These teams grant no Corporate Brain access by themselves — readers are added to Members too until playbook-only access exists.
  "Corporate Brain::Sales", "Corporate Brain::Marketing", "Corporate Brain::Legal", "Corporate Brain::Executive"];
const IS_ADMIN = "identity('spaceAdmin') || identity('teams').indexOf('Corporate Brain::Admins') >= 0";
const IS_REVIEWER = `${IS_ADMIN} || identity('teams').indexOf('Corporate Brain::Reviewers') >= 0`;
const IS_MEMBER = `${IS_REVIEWER} || identity('teams').indexOf('Corporate Brain::Members') >= 0`;
const IS_PRICING = `${IS_REVIEWER} || identity('teams').indexOf('Corporate Brain::Sales') >= 0 || identity('teams').indexOf('Corporate Brain::Legal') >= 0 || identity('teams').indexOf('Corporate Brain::Executive') >= 0`;
export const POLICIES = [
  { name: "CB Member", type: "Kapp", rule: IS_MEMBER, message: "Corporate Brain is private. Ask an administrator to add you to the Corporate Brain::Members team." },
  { name: "CB Admin", type: "Kapp", rule: IS_ADMIN, message: "Only Corporate Brain administrators can change the application." },
  { name: "CB Member Form", type: "Form", rule: IS_MEMBER, message: "Corporate Brain is private." },
  // Form *modification* grants access to every submission on the form, so only admins hold it.
  { name: "CB Admin Form", type: "Form", rule: IS_ADMIN, message: "Only Corporate Brain administrators can change forms." },
  { name: "CB Member Submission", type: "Submission", rule: IS_MEMBER, message: "Corporate Brain is private." },
  // Members may edit their own knowledge only while it is still proposed; status changes belong to reviewers.
  { name: "CB Knowledge Modification", type: "Submission",
    rule: `${IS_REVIEWER} || ((${IS_MEMBER}) && submission('createdBy') === identity('username') && ['proposed','needs-research'].indexOf(values('Review Status')) >= 0)`,
    message: "Only reviewers can change knowledge that has been reviewed." },
  { name: "CB Restricted Source", type: "Submission",
    rule: `(${IS_REVIEWER}) || ((${IS_MEMBER}) && values('Access Scope') !== 'restricted')`,
    message: "This source is restricted to Corporate Brain reviewers." },
  { name: "CB Append Only", type: "Submission", rule: IS_ADMIN, message: "The audit log is append-only." },
  // Same rule as knowledge: members edit their own sales records only while they are still under review.
  { name: "CB Sales Modification", type: "Submission",
    rule: `${IS_REVIEWER} || ((${IS_MEMBER}) && submission('createdBy') === identity('username') && ['proposed','needs-research'].indexOf(values('Verification Status')) >= 0)`,
    message: "Only reviewers can change a sales record after it has been reviewed." },
  { name: "CB Deal Pricing", type: "Submission", rule: `(${IS_MEMBER}) && (${IS_PRICING})`,
    message: "Deal prices are visible only to the Sales, Legal and Executive teams and Corporate Brain reviewers." },
  // RFP Intelligence: a historical answer is evidence — once confirmed only a reviewer may touch it (and the server only
  // ever changes its status: corrections are new revisions). Restricted RFP rows stay reviewer-only, as for sources.
  { name: "CB RFP Answer Modification", type: "Submission",
    rule: `((${IS_REVIEWER}) || ((${IS_MEMBER}) && values('Access Scope') !== 'restricted' && ['candidate','needs_review'].indexOf(values('Answer Status')) >= 0))`,
    message: "A confirmed historical answer cannot be changed. A reviewer can record a correction as a new revision." },
  // Approved answers are current organizational knowledge: members draft them, only reviewers change one once submitted.
  { name: "CB Approved Answer Modification", type: "Submission",
    rule: `(${IS_REVIEWER}) || ((${IS_MEMBER}) && ['draft',''].indexOf(values('Approval Status')) >= 0)`,
    message: "Only reviewers can change an approved answer after it has been submitted for review." },
];

function buildPages(fields) {
  const elements = fields.map(fieldElement);
  elements.push({ type: "button", name: "Submit Button", label: "Submit", renderType: "submit-page", visible: true, enabled: true, renderAttributes: {} });
  return [{ name: "Page 1", type: "page", renderType: "submittable", elements, events: [] }];
}
function fieldElement(f) {
  // Attachment fields use dataType "file" and must not carry `rows` (Kinetic answers 400 Invalid Form otherwise)
  if (f.attachment || f.renderType === "attachment") return { type: "field", name: f.name, label: f.name, key: crypto.randomBytes(16).toString("hex"), dataType: "file",
    renderType: "attachment", enabled: true, visible: true, required: !!f.required, allowMultiple: false, constraints: [], events: [],
    renderAttributes: {}, defaultDataSource: "none", defaultValue: null, defaultResourceName: null, requiredMessage: null,
    omitWhenHidden: null, pattern: null };
  return { type: "field", name: f.name, label: f.name, key: crypto.randomBytes(16).toString("hex"), dataType: "string",
    renderType: "text", enabled: true, visible: true, required: !!f.required, rows: f.rows || 1, constraints: [], events: [],
    renderAttributes: {}, defaultDataSource: "none", defaultValue: "", defaultResourceName: "", requiredMessage: "",
    omitWhenHidden: null, pattern: null };
}
function walkFields(els, out = []) { for (const e of els || []) { if (e.type === "field") out.push(e.name); if (e.elements) walkFields(e.elements, out); } return out; }

const SYS_IDX = [
  { parts: ["closedBy"], unique: false }, { parts: ["createdBy"], unique: false }, { parts: ["handle"], unique: true },
  { parts: ["submittedBy"], unique: false }, { parts: ["updatedBy"], unique: false },
];

async function main() {
  console.log(`Deploying ${KAPP.slug} to ${BASE}${DRY ? " (dry run)" : ""}`);
  fs.writeFileSync(path.join(HERE, "app.json"), JSON.stringify(toAppJson(), null, 2) + "\n");

  // 1. Kapp
  const k = await api("GET", `/kapps/${KAPP.slug}`);
  if (k.status === 404) { const r = await api("POST", "/kapps", { name: KAPP.name, slug: KAPP.slug, status: "Active" }); r.status < 300 ? ok("kapp created") : fail(`kapp: ${r.status} ${JSON.stringify(r.data)}`); }
  else ok("kapp exists");

  // 2. Teams
  for (const name of TEAMS) {
    const r = await api("POST", "/teams", { name, description: "Corporate Brain access group" });
    if (r.status < 300) ok(`team ${name} created`);
    else if (r.status === 400 && /exist|unique/i.test(JSON.stringify(r.data))) warn(`team ${name} exists`);
    else fail(`team ${name}: ${r.status} ${JSON.stringify(r.data)}`);
  }

  // 3. Policy definitions (create or update rule text)
  const existing = await api("GET", `/kapps/${KAPP.slug}/securityPolicyDefinitions`);
  const have = new Set((existing.data?.securityPolicyDefinitions || []).map(d => d.name));
  for (const p of POLICIES) {
    const r = have.has(p.name)
      ? await api("PUT", `/kapps/${KAPP.slug}/securityPolicyDefinitions/${encodeURIComponent(p.name)}`, p)
      : await api("POST", `/kapps/${KAPP.slug}/securityPolicyDefinitions`, p);
    r.status < 300 ? ok(`policy ${p.name}`) : fail(`policy ${p.name}: ${r.status} ${JSON.stringify(r.data)}`);
  }

  // 4. Forms + fields (additive)
  for (const form of FORMS) {
    const g = await api("GET", `/kapps/${KAPP.slug}/forms/${form.slug}?include=pages`);
    if (g.status === 404) {
      const r = await api("POST", `/kapps/${KAPP.slug}/forms`, { slug: form.slug, name: form.name, description: form.description, status: "Active",
        submissionLabelExpression: "${values('" + form.label + "')}", pages: buildPages(form.fields) });
      r.status < 300 ? ok(`form ${form.slug} created (${form.fields.length} fields)`) : fail(`form ${form.slug}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    } else {
      const pages = g.data.form.pages;
      const present = new Set(walkFields(pages));
      const missing = form.fields.filter(x => !present.has(x.name));
      if (!missing.length) { ok(`form ${form.slug} up to date`); continue; }
      const els = pages[0].elements; const btn = els.findIndex(e => e.type === "button");
      els.splice(btn >= 0 ? btn : els.length, 0, ...missing.map(fieldElement));
      const r = await api("PUT", `/kapps/${KAPP.slug}/forms/${form.slug}`, { pages });
      r.status < 300 ? ok(`form ${form.slug}: added ${missing.map(x => x.name).join(", ")}`) : fail(`form ${form.slug} fields: ${r.status}`);
    }
  }

  // 5. Indexes (merge with what exists, then build anything not Built)
  for (const form of FORMS) {
    const g = await api("GET", `/kapps/${KAPP.slug}/forms/${form.slug}?include=indexDefinitions`);
    const cur = g.data?.form?.indexDefinitions || [];
    const want = [...SYS_IDX];
    const key = d => d.parts.join(",");
    for (const u of form.unique) want.push({ parts: Array.isArray(u) ? u : [u], unique: true });
    for (const s of form.single) want.push({ parts: [s], unique: false });
    for (const c of form.compound) want.push({ parts: c, unique: false });
    const merged = new Map(cur.map(d => [key(d), { parts: d.parts, unique: !!d.unique }]));
    for (const w of want) merged.set(key(w), w);
    const defs = [...merged.values()];
    if (defs.length !== cur.length || defs.some(d => !cur.find(c => key(c) === key(d) && !!c.unique === !!d.unique))) {
      const r = await api("PUT", `/kapps/${KAPP.slug}/forms/${form.slug}`, { indexDefinitions: defs });
      if (r.status >= 300) { fail(`indexes ${form.slug}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); continue; }
    }
    const after = (await api("GET", `/kapps/${KAPP.slug}/forms/${form.slug}?include=indexDefinitions`)).data?.form?.indexDefinitions || [];
    const unbuilt = after.filter(d => d.status !== "Built" && !d.parts.every(p => !p.startsWith("values["))).map(key);
    if (unbuilt.length) {
      await api("POST", `/kapps/${KAPP.slug}/forms/${form.slug}/backgroundJobs`, { type: "Build Index", content: { indexes: unbuilt } });
      for (let i = 0; i < 30 && !DRY; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const ch = (await api("GET", `/kapps/${KAPP.slug}/forms/${form.slug}?include=indexDefinitions`)).data?.form?.indexDefinitions || [];
        if (!ch.some(d => unbuilt.includes(key(d)) && d.status !== "Built")) break;
      }
      ok(`indexes ${form.slug}: built ${unbuilt.length}`);
    } else ok(`indexes ${form.slug}: all built (${after.length})`);
  }

  // 6. Security policies: private by default
  const kp = await api("PUT", `/kapps/${KAPP.slug}`, { securityPolicies: [
    { endpoint: "Display", name: "CB Member" }, { endpoint: "Modification", name: "CB Admin" },
    { endpoint: "Form Creation", name: "CB Admin" }, { endpoint: "Submission Support", name: "CB Admin" },
    { endpoint: "Default Form Display", name: "CB Member Form" }, { endpoint: "Default Form Modification", name: "CB Admin Form" },
    { endpoint: "Default Submission Access", name: "CB Member Submission" }, { endpoint: "Default Submission Modification", name: "CB Member Submission" },
  ] });
  kp.status < 300 ? ok("kapp security policies applied") : fail(`kapp policies: ${kp.status} ${JSON.stringify(kp.data).slice(0, 300)}`);
  const formPolicies = {
    "knowledge-entries": [{ endpoint: "Submission Modification", name: "CB Knowledge Modification" }],
    sources: [{ endpoint: "Submission Access", name: "CB Restricted Source" }, { endpoint: "Submission Modification", name: "CB Restricted Source" }],
    "audit-log": [{ endpoint: "Submission Modification", name: "CB Append Only" }],
    "deal-pricing": [{ endpoint: "Submission Access", name: "CB Deal Pricing" }, { endpoint: "Submission Modification", name: "CB Deal Pricing" }],
    ...Object.fromEntries([...SALES_FORMS].map(f => [f, [{ endpoint: "Submission Modification", name: "CB Sales Modification" }]])),
    ...Object.fromEntries(RFP_SCOPED_FORMS.map(f => [f, [{ endpoint: "Submission Access", name: "CB Restricted Source" },
      { endpoint: "Submission Modification", name: f === "rfp-answers" ? "CB RFP Answer Modification" : "CB Restricted Source" }]])),
    "approved-answers": [{ endpoint: "Submission Modification", name: "CB Approved Answer Modification" }],
  };
  for (const [slug, sp] of Object.entries(formPolicies)) {
    const r = await api("PUT", `/kapps/${KAPP.slug}/forms/${slug}`, { securityPolicies: sp });
    r.status < 300 ? ok(`form policies ${slug}`) : fail(`form policies ${slug}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  console.log(process.exitCode ? "Deploy finished with errors" : "Deploy complete");
}
main().catch(e => { console.error(e); process.exit(1); });
