// Verify every index in app.json exists AND is Built on the platform; re-trigger builds for any that are not.
import fs from "node:fs";
import { core, KAPP } from "./lib.mjs";
const app = JSON.parse(fs.readFileSync(new URL("../app.json", import.meta.url), "utf-8"));
let bad = 0;
for (const f of app.forms) {
  const want = [...f.indexes.single.map((p) => [p]), ...f.indexes.compound, ...f.indexes.unique].map((p) => p.join(","));
  const r = await core("GET", `/kapps/${KAPP}/forms/${f.slug}?include=indexDefinitions`);
  const defs = r.data.form.indexDefinitions;
  const notBuilt = want.filter((w) => !defs.some((d) => d.parts.join(",") === w && d.status === "Built"));
  if (notBuilt.length) { bad += notBuilt.length; console.log(`✗ ${f.slug}: ${notBuilt.length} not built → rebuilding`, notBuilt.slice(0, 3));
    await core("POST", `/kapps/${KAPP}/forms/${f.slug}/backgroundJobs`, { type: "Build Index", content: { indexes: notBuilt } }); }
}
console.log(bad ? `${bad} index(es) were not built — rebuild jobs submitted; re-run to confirm` : "✓ all indexes built");
