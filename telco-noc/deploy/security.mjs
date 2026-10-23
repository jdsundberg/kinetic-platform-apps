/**
 * security.mjs — KSL (JavaScript) security policy definitions for the telco-noc kapp.
 *
 * Model:  user attribute "NOC Tenant" (single, admin-set)  +  "NOC Role" (multi, admin-set).
 *         Never profile attributes — users can edit those themselves (privilege escalation).
 * Layers: (1) every server query is tenant-scoped KQL; (2) these policies re-check on the platform,
 *         so a direct REST call with a user's credentials cannot read or modify another tenant's data.
 */
const tenantOk = `(function(){var t=identity('attribute:NOC Tenant');if(t instanceof Array)t=t[0];return !!t && values('Tenant ID')===t;})()`;
const roleIn = (roles) => `(function(){var r=identity('attribute:NOC Role')||[];if(!(r instanceof Array))r=[r];var a=${JSON.stringify(roles)};for(var i=0;i<r.length;i++){if(a.indexOf(r[i])>-1)return true;}return false;})()`;
const admin = `identity('spaceAdmin')`;

export const POLICY_DEFS = [
  { name: "NOC Member", type: "Form", message: "You are not assigned to a NOC tenant.",
    rule: `${admin} || (function(){var t=identity('attribute:NOC Tenant');if(t instanceof Array)t=t[0];return !!t;})()` },
  { name: "NOC Same Tenant", type: "Submission", message: "Record belongs to another tenant.", rule: `${admin} || ${tenantOk}` },
  { name: "NOC Ops Writer", type: "Submission", message: "Operators and service owners only.",
    rule: `${admin} || (${tenantOk} && ${roleIn(["Operator", "Service Owner", "Tenant Admin"])})` },
  { name: "NOC Field Writer", type: "Submission", message: "Operators and field technicians only.",
    rule: `${admin} || (${tenantOk} && ${roleIn(["Operator", "Field Tech", "Tenant Admin"])})` },
  { name: "NOC Reference Writer", type: "Submission", message: "Reference data is maintained by integrations and tenant admins.",
    rule: `${admin} || (${tenantOk} && ${roleIn(["Tenant Admin"])})` },
  { name: "NOC PII Reader", type: "Submission", message: "Contact details are restricted.",
    rule: `${admin} || (${tenantOk} && ${roleIn(["Operator", "Service Owner", "Support Agent", "Tenant Admin"])})` },
  { name: "NOC Append Only", type: "Submission", message: "Append-only record; cannot be modified.", rule: `${admin}` },
  // WebAPI execution (ingest-event): integration identities only. The policy cannot see the body, so the tree
  // additionally requires caller == "int.<tenantId>" (or a configured admin caller) — see workflows/gen-trees.mjs.
  { name: "NOC Integration", type: "Kapp", message: "Only integration identities may ingest events.", rule: `${admin} || ${roleIn(["Integration"])}` },
];

const OPS = ["alarms", "correlation-groups", "incidents", "impacts", "notifications", "ai-recommendations", "problems", "changes"];
const FIELD = ["work-orders", "parts"];
const APPEND = ["audit", "incident-updates", "raw-alarms", "metrics"];

export function FORM_POLICIES(slug) {
  const read = slug === "contacts" ? "NOC PII Reader" : "NOC Same Tenant";
  const write = OPS.includes(slug) ? "NOC Ops Writer" : FIELD.includes(slug) ? "NOC Field Writer" : APPEND.includes(slug) ? "NOC Append Only" : "NOC Reference Writer";
  return [
    { endpoint: "Display", name: "NOC Member" },
    { endpoint: "Submission Access", name: read },
    { endpoint: "Submission Modification", name: write },
  ];
}
