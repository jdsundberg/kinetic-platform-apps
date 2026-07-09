// Emit command-center/app.json from the model. Run: node build-app.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORMS, KAPP } from "./model.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const forms = FORMS.map(f => {
  const fields = f.fields.map(fl => {
    const o = { name: fl.name };
    if (fl.required) o.required = true;
    if (fl.rows) o.rows = fl.rows;
    return o;
  });
  const single = f.fields.filter(fl => fl.idx === "single").map(fl => `values[${fl.name}]`);
  const compound = f.compound || [];
  const out = {
    slug: f.slug, name: f.name, description: f.desc,
    submissionLabelExpression: f.label, fields,
  };
  if (single.length || compound.length) out.indexes = { single, compound };
  return out;
});

const app = {
  name: "GRC Command Center",
  slug: KAPP,
  description: "Kinetic GRC Command Center — provider-scale governance, risk & compliance across CMMC, NIST 800-171, NIST CSF, SOC 2, ISO 27001, HIPAA & CIS. Asset-centric scoping, continuous compliance, audit-ready visuals.",
  category: "Governance, Risk & Compliance",
  icon: "shield",
  color: "#3B5BDB",
  bg: "#EDF2FF",
  forms,
};

const out = path.join(__dirname, "app.json");
fs.writeFileSync(out, JSON.stringify(app, null, 2) + "\n");
const idxCount = forms.reduce((a, f) => a + (f.indexes ? f.indexes.single.length + f.indexes.compound.length : 0), 0);
console.log(`Wrote ${out}: ${forms.length} forms, ${forms.reduce((a, f) => a + f.fields.length, 0)} fields, ${idxCount} custom indexes.`);
