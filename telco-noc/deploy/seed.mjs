/**
 * seed.mjs — resumable, idempotent loader for seed/reference.json.
 * Diffs by business key (the form's idField + Tenant ID): creates what is missing, updates what drifted,
 * never duplicates. "RELATIVE:±N" values become now ± N minutes (UTC) so freshness/maintenance windows are live.
 * Usage: node deploy/seed.mjs [--only form1,form2]
 */
import fs from "node:fs";
import path from "node:path";
import { search, create, update, pool } from "./lib.mjs";
import { formBySlug } from "../model.mjs";

const DIR = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const data = JSON.parse(fs.readFileSync(path.join(DIR, "seed/reference.json"), "utf-8"));
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const now = Date.now();
const rel = (v) => (typeof v === "string" && v.startsWith("RELATIVE:") ? new Date(now + Number(v.slice(9)) * 60000).toISOString().replace(/\.\d{3}Z$/, "Z") : v);

for (const [slug, rows] of Object.entries(data)) {
  if (only.length && !only.includes(slug)) continue;
  const key = formBySlug[slug].idField;
  const existing = new Map();
  for (const s of await search(slug, "", { max: 5000 })) existing.set(`${s.values["Tenant ID"]}|${s.values[key]}`, s);
  let created = 0, updated = 0, same = 0; const errs = [];
  await pool(rows, 8, async (row) => {
    const values = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, rel(v)]));
    const cur = existing.get(`${values["Tenant ID"]}|${values[key]}`);
    try {
      if (!cur) { await create(slug, values); created++; }
      else {
        const drift = Object.entries(values).some(([k, v]) => !String(v).startsWith("20") && (cur.values[k] ?? "") !== v) || Object.keys(values).some((k) => (cur.values[k] ?? "") === "" && values[k] !== "");
        if (drift) { await update(cur.id, values); updated++; } else same++;
      }
    } catch (e) { errs.push(e.message); }
  });
  const after = (await search(slug, "", { max: 5000 })).length;
  console.log(`${errs.length ? "✗" : "✓"} ${slug}: +${created} ~${updated} =${same} → ${after} in platform (expected ≥ ${rows.length})${errs.length ? "  first error: " + errs[0] : ""}`);
}
