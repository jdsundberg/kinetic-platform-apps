/**
 * drop-forms.mjs — DELETE every form (and therefore every submission + form workflow) in kapp telco-noc.
 * Used for a clean reinstall of a pilot/demo space. Refuses without --yes. Never touches other kapps.
 */
import { core, KAPP } from "./lib.mjs";
if (!process.argv.includes("--yes")) { console.log(`Refusing: this deletes ALL forms and data in kapp ${KAPP}. Pass --yes.`); process.exit(1); }
const r = await core("GET", `/kapps/${KAPP}/forms?limit=200`);
for (const f of r.data.forms || []) { const d = await core("DELETE", `/kapps/${KAPP}/forms/${f.slug}`); console.log(`${d.status < 300 ? "✓" : "✗"} deleted form ${f.slug}`); }
