// Purge ALL runtime (replay) data for a tenant: finds every Replay Batch in runtime forms and calls /api/noc/demo/reset for each.
// Reference data (topology, customers, history) is untouched. Admin only.
import { search } from "../deploy/lib.mjs";
import { call } from "../tests/api-smoke.mjs";
const T = process.argv[2] || "borealis"; const batches = new Set();
for (const f of ["raw-alarms", "alarms", "incidents", "metrics", "correlation-groups", "work-orders", "notifications", "impacts"])
  for (const s of await search(f, `values[Tenant ID]="${T}"`, { max: 5000 })) if (s.values["Replay Batch"]) batches.add(s.values["Replay Batch"]);
for (const b of batches) { const r = await call("POST", "/api/noc/demo/reset", { batch: b }, undefined, { "X-NOC-Tenant": T }); console.log(b, JSON.stringify(r.data.deleted)); }
console.log(`purged ${batches.size} batch(es)`);
