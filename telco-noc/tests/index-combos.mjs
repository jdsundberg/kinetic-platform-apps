// Every filter combination a screen or the engine can apply at once, run against the LIVE store. Any 400 = missing index.
import { core, KAPP } from "../deploy/lib.mjs";
const T = 'values[Tenant ID]="borealis"';
const combos = {
  alarms: ['values[State]="Active"', 'values[State]="Active" AND values[Correlation Role]="Uncorrelated"', 'values[Incident ID]="X"', 'values[Incident ID]="X" AND values[State]="Active"',
    'values[Incident ID]="X" AND values[Correlation Role]="Symptom"', 'values[Incident ID]="X" AND values[State]="Active" AND values[Correlation Role]="Symptom"', 'values[Resource ID]="X"',
    'values[Fingerprint]="X" AND values[State]="Active"', 'values[Replay Batch]="X"'],
  resources: ['values[Resource Type]="Router"', 'values[Health]="Down"', 'values[Site ID]="X"', 'values[Resource Type]="Router" AND values[Health]="Down"', 'values[Resource Type]="Router" AND values[Site ID]="X"',
    'values[Site ID]="X" AND values[Health]="Down"', 'values[Resource Type]="Router" AND values[Health]="Down" AND values[Site ID]="X"'],
  impacts: ['values[Incident ID]="X"', 'values[Incident ID]="X" AND values[Impact Class]="Confirmed"', 'values[Account ID]="X"'],
  incidents: ['values[State]="New" OR values[State]="Acknowledged"', 'values[Incident ID]="X"', 'values[Root Resource ID]="X"'],
  "raw-alarms": ['values[Processing State]="Rejected"', 'values[Source System]="ip-nms"', 'values[Idempotency Key]="X"', 'values[Replay Batch]="X"'],
  customers: ['values[Segment]="Enterprise"', 'values[Account ID]="X"'], contacts: ['values[Account ID] IN ("A","B")'],
  identifiers: ['values[External ID] IN ("A","B")', 'values[Internal ID]="X"'], metrics: ['values[Subject ID] IN ("A","B")'],
  "work-orders": ['values[Assigned Tech]="x"', 'values[Incident ID]="X"', 'values[Work Order ID]="X"'], "ai-recommendations": ['values[Incident ID]="X" AND values[Kind]="Summary"'],
  "correlation-groups": ['values[State]="Open"', 'values[Group ID]="X"'], notifications: ['values[Incident ID]="X"', 'values[Notification ID]="X"'],
  "incident-updates": ['values[Incident ID]="X"'], integrations: ['values[Source ID]="gis"'], changes: ['values[Change ID]="X"'], parts: ['values[Part ID]="X"'],
};
let fail = 0, n = 0;
for (const [form, qs] of Object.entries(combos)) for (const q of qs) { n++;
  const r = await core("GET", `/kapps/${KAPP}/forms/${form}/submissions?limit=1&q=${encodeURIComponent(`${T} AND (${q})`)}`);
  if (r.status !== 200) { fail++; console.log(`FAIL ${form}: ${q} → ${r.status} ${(r.data.error || "").split("\n")[0]}`); } }
console.log(fail ? `${fail}/${n} combinations FAILED` : `ALL ${n} filter combinations return 200`);
