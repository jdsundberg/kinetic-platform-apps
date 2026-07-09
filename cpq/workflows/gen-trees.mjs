/**
 * gen-trees.mjs — build Ironline CPQ workflow trees from ONE node model and emit
 * BOTH formats:
 *   • <name>.xml      — treeXml, fed to validate-workflow.mjs for the rule gate
 *   • trees.json      — treeJson payloads, fed to put-trees.mjs (the reliable
 *                       persistence path — Core-API treeXml PUT stores empty nodes
 *                       on this engine, per workflow-xml skill guidance).
 *
 * Three event-triggered automation trees (all via kinetic_core_api_connection_v1):
 *   1. Quote Approval Routing   (quotes / Submission Submitted)
 *   2. Won to Order Conversion  (quotes / Submission Updated)
 *   3. Approval Decision Sync   (approvals / Submission Updated)
 *
 * Usage: node gen-trees.mjs
 */
import fs from "node:fs";
import path from "node:path";
const DIR = path.dirname(new URL(import.meta.url).pathname);
const CORE = "kinetic_core_api_connection_v1";

const escX = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escA = (s) => escX(s).replace(/"/g, "&quot;");

// extra_headers must be present even when empty — the handler's message template references it.
const api = (method, p, body) => { const o = { method, path: p, body: body || "", extra_headers: "", error_handling: "Error Message" }; return o; };
const mkNode = (defId, id, name, x, y, params = {}, deps = []) => ({ defId, id, name, x, y, params, deps });

// ── XML emitter (for the validator's rule checks) ─────────────────────
function toXml(t) {
  const taskXml = (n) => `    <task definition_id="${n.defId}" id="${n.id}" name="${escA(n.name)}" x="${n.x}" y="${n.y}">
      <version>1</version>
      <configured>true</configured>
      <defers>false</defers>
      <deferrable>false</deferrable>
      <visible>false</visible>
      <parameters>${Object.entries(n.params).map(([k, v]) => `<parameter id="${k}">${escX(v)}</parameter>`).join("")}</parameters>
      <messages><message type="Complete"></message></messages>
      <dependents>${n.deps.map((d) => `<task label="${escA(d.label || "")}" type="${d.type || "Complete"}" value="${escA(d.value || "")}">${d.to}</task>`).join("")}</dependents>
    </task>`;
  return `<tree schema_version="1.0">
  <sourceName>Kinetic Request CE</sourceName>
  <sourceGroup>${t.guid}</sourceGroup>
  <type>Tree</type>
  <status>Active</status>
  <taskTree builder_version="" schema_version="1.0" version="1">
    <name>${escX(t.name)}</name>
    <author></author>
    <notes></notes>
    <lastID>${t.lastID}</lastID>
    <request>
${t.nodes.map(taskXml).join("\n")}
    </request>
  </taskTree>
</tree>`;
}

// ── treeJson emitter (the reliable persistence path) ──────────────────
function toJson(t) {
  const connectors = [];
  const nodes = t.nodes.map((n) => {
    n.deps.forEach((d) => connectors.push({ from: n.id, to: d.to, label: d.label || "", value: d.value || "", type: d.type || "Complete" }));
    return {
      configured: true, defers: false, deferrable: false, visible: false,
      name: n.name, messages: [],
      dependents: { task: n.deps.map((d) => ({ type: d.type || "Complete", content: d.to, value: d.value || "", label: d.label || "" })) },
      id: n.id, position: { x: n.x, y: n.y }, version: 1,
      parameters: Object.entries(n.params).map(([id, value]) => ({ dependsOnId: "", dependsOnValue: "", description: "", id, label: id, menu: "", value, required: false })),
      definitionId: n.defId,
    };
  });
  return { builderVersion: "", schemaVersion: "1.0", version: "1", processOwnerEmail: "", lastId: t.lastID, name: "", notes: "", connectors, nodes };
}

// ─── Tree 1: Quote Approval Routing (quotes / Submission Submitted) ───
const needs = "@values['Discount Pct'].to_f > 15 || @values['Margin Pct'].to_f < 22";
const approvalBody =
  `{"values":{"Approval ID":"APR-WF-<%= @run['Id'] %>","Quote Number":"<%= @values['Quote Number'] %>",` +
  `"Customer Name":"<%= @values['Customer Name'] %>","Approval Type":"<%= @values['Margin Pct'].to_f < 22 ? 'Margin Floor' : 'Discount' %>",` +
  `"Requested By":"<%= @values['Owner'] %>","Approver":"<%= (@values['Discount Pct'].to_f > 25 || @values['Net Total'].to_f > 150000) ? 'Victor Hale' : 'Karen Doyle' %>",` +
  `"Approver Role":"Deal Desk","Status":"Pending","Priority":"<%= @values['Discount Pct'].to_f > 25 ? 'High' : 'Medium' %>",` +
  `"Discount Pct":"<%= @values['Discount Pct'] %>","Margin Pct":"<%= @values['Margin Pct'] %>","Net Total":"<%= @values['Net Total'] %>",` +
  `"Threshold":"15% max / 22% floor","Reason":"Auto-routed by workflow on quote submit",` +
  `"Requested Date":"<%= Time.now.strftime('%Y-%m-%d') %>","SLA Due Date":"<%= (Time.now + 259200).strftime('%Y-%m-%d') %>","Aging Days":"0"},"coreState":"Submitted"}`;
const T1 = { guid: "142e9d3f-6eb0-4da1-8a26-7567cf81cb7d", file: "tree-approval-routing", name: "Quote Approval Routing", lastID: 3, nodes: [
  mkNode("system_start_v1", "start", "Start", 240, 40, {}, [
    { label: "needs approval", value: needs, to: `${CORE}_1` },
    { label: "auto-approve", value: `!(${needs})`, to: `${CORE}_3` }]),
  mkNode(CORE, `${CORE}_1`, "Create Approval", 120, 180, api("POST", "/app/api/v1/kapps/cpq/forms/approvals/submissions", approvalBody), [{ to: `${CORE}_2` }]),
  mkNode(CORE, `${CORE}_2`, "Flag Quote Pending", 120, 320, api("PUT", "/app/api/v1/submissions/<%= @submission['Id'] %>", `{"values":{"Approval Status":"Pending","Status":"Pending Approval","Stage":"Pending Approval"}}`)),
  mkNode(CORE, `${CORE}_3`, "Mark Auto Approved", 380, 180, api("PUT", "/app/api/v1/submissions/<%= @submission['Id'] %>", `{"values":{"Approval Status":"Not Required"}}`)),
]};

// ─── Tree 2: Won to Order Conversion (quotes / Submission Updated) ───
const wonCond = "@values['Status'] == 'Won' && @values['Order Number'].to_s.empty?";
const orderNum = "SO-<%= @values['Quote Number'].sub('Q-','') %>";
const orderBody =
  `{"values":{"Order Number":"${orderNum}","Quote Number":"<%= @values['Quote Number'] %>","Customer ID":"<%= @values['Customer ID'] %>",` +
  `"Customer Name":"<%= @values['Customer Name'] %>","Owner":"<%= @values['Owner'] %>","Status":"Open",` +
  `"Order Date":"<%= Time.now.strftime('%Y-%m-%d') %>","Order Total":"<%= @values['Net Total'] %>","Cost Total":"<%= @values['Cost Total'] %>",` +
  `"Margin Amount":"<%= @values['Margin Amount'] %>","Margin Pct":"<%= @values['Margin Pct'] %>","Fulfillment Status":"Pending"},"coreState":"Submitted"}`;
const T2 = { guid: "b192cfff-b131-4cb3-91fc-7fe32aa67529", file: "tree-won-order", name: "Won to Order Conversion", lastID: 2, nodes: [
  mkNode("system_start_v1", "start", "Start", 240, 40, {}, [{ label: "won, not yet converted", value: wonCond, to: `${CORE}_1` }]),
  mkNode(CORE, `${CORE}_1`, "Create Order", 240, 180, api("POST", "/app/api/v1/kapps/cpq/forms/orders/submissions", orderBody), [{ to: `${CORE}_2` }]),
  mkNode(CORE, `${CORE}_2`, "Link Order To Quote", 240, 320, api("PUT", "/app/api/v1/submissions/<%= @submission['Id'] %>", `{"values":{"Order Number":"${orderNum}"}}`)),
]};

// ─── Tree 3: Approval Decision Sync (approvals / Submission Updated) ───
const findPath = "/app/api/v1/kapps/cpq/forms/quotes/submissions?limit=1&include=values&q=values%5BQuote%20Number%5D%3D%22<%= @values['Quote Number'] %>%22";
const quoteId = "<%= require 'json'; JSON.parse(@results['Find Quote']['Response Body'])['submissions'][0]['id'] %>";
const T3 = { guid: "7f4a3976-a957-4d68-9aaf-60af92012b4a", file: "tree-approval-decision", name: "Approval Decision Sync", lastID: 3, nodes: [
  mkNode("system_start_v1", "start", "Start", 240, 40, {}, [{ to: `${CORE}_1` }]),
  mkNode(CORE, `${CORE}_1`, "Find Quote", 240, 170, api("GET", findPath), [
    { label: "approved", value: "@values['Status'] == 'Approved'", to: `${CORE}_2` },
    { label: "rejected", value: "@values['Status'] == 'Rejected'", to: `${CORE}_3` }]),
  mkNode(CORE, `${CORE}_2`, "Approve Quote", 110, 320, api("PUT", `/app/api/v1/submissions/${quoteId}`, `{"values":{"Approval Status":"Approved","Status":"Approved","Stage":"Approved"}}`)),
  mkNode(CORE, `${CORE}_3`, "Reject Quote", 380, 320, api("PUT", `/app/api/v1/submissions/${quoteId}`, `{"values":{"Approval Status":"Rejected","Status":"Negotiation","Stage":"Negotiation"}}`)),
]};

// ─── Tree 4: Order Invoice Generation (orders / Submission Updated) ───
const shipCond = "(@values['Status'] == 'Shipped' || @values['Status'] == 'Delivered') && @values['Invoiced Amount'].to_f == 0";
const invoiceBody =
  `{"values":{"Invoice Number":"INV-WF-<%= @run['Id'] %>","Order Number":"<%= @values['Order Number'] %>","Quote Number":"<%= @values['Quote Number'] %>",` +
  `"Customer ID":"<%= @values['Customer ID'] %>","Customer Name":"<%= @values['Customer Name'] %>","Status":"Sent",` +
  `"Invoice Date":"<%= Time.now.strftime('%Y-%m-%d') %>","Due Date":"<%= (Time.now + 2592000).strftime('%Y-%m-%d') %>","Terms":"Net 30",` +
  `"Amount":"<%= @values['Order Total'] %>","Amount Paid":"0","Balance":"<%= @values['Order Total'] %>","Days Outstanding":"0"},"coreState":"Submitted"}`;
const T4 = { guid: "5e969426-af5d-440e-aa5a-1ed84e90a866", file: "tree-order-invoice", name: "Order Invoice Generation", lastID: 2, nodes: [
  mkNode("system_start_v1", "start", "Start", 240, 40, {}, [{ label: "shipped, not invoiced", value: shipCond, to: `${CORE}_1` }]),
  mkNode(CORE, `${CORE}_1`, "Create Invoice", 240, 180, api("POST", "/app/api/v1/kapps/cpq/forms/invoices/submissions", invoiceBody), [{ to: `${CORE}_2` }]),
  mkNode(CORE, `${CORE}_2`, "Mark Order Invoiced", 240, 320, api("PUT", "/app/api/v1/submissions/<%= @submission['Id'] %>", `{"values":{"Invoiced Amount":"<%= @values['Order Total'] %>"}}`)),
]};

const TREES = [T1, T2, T3, T4];
const putPayload = [];
for (const t of TREES) {
  fs.writeFileSync(path.join(DIR, t.file + ".xml"), toXml(t));
  putPayload.push({
    title: `Kinetic Request CE :: ${t.guid} :: ${t.name}`,
    name: t.name, guid: t.guid, treeJson: toJson(t),
  });
}
fs.writeFileSync(path.join(DIR, "trees.json"), JSON.stringify(putPayload, null, 1));
console.log("Wrote", TREES.length, "tree XML files + trees.json to", DIR);
