/**
 * Create workflows for ServiceProMax
 * Adds event-triggered workflows to key forms
 */
import https from "node:https";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const SERVER = "https://first.kinetics.com";
const AUTH = "Basic " + Buffer.from("john:john1").toString("base64");
const KAPP = "service-pro-max";

function req(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER + "/app/api/v1" + apiPath);
    const opts = { method, hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, headers: { Authorization: AUTH, "Content-Type": "application/json" } };
    const r = https.request(opts, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode} ${method} ${apiPath}: ${d.slice(0, 200)}`));
        else resolve(d ? JSON.parse(d) : {});
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// ─── XML Builders (reusable patterns from Activity Monitor / sec-ops) ───

function xmlEsc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;'); }

// Simple log tree: Start → Log (echo)
function logTree(message) {
  return `<taskTree schema_version="1.0" version="1"><request><task name="Start" id="start" definition_id="system_start_v1" x="200" y="50"><version>1</version><configured>true</configured><defers>false</defers><deferrable>false</deferrable><visible>false</visible><parameters></parameters><messages><message type="Complete"></message></messages><dependents><task type="Complete">utilities_echo_v1_1</task></dependents></task><task name="Log" id="utilities_echo_v1_1" definition_id="utilities_echo_v1" x="200" y="200"><version>1</version><configured>true</configured><defers>false</defers><deferrable>false</deferrable><visible>false</visible><parameters><parameter id="input" label="Input" required="true" tooltip="" menu="">${xmlEsc(message)}</parameter></parameters><messages><message type="Complete"></message></messages><dependents></dependents></task></request></taskTree>`;
}

// Branch tree: Start → condition? → Echo A / Echo B
function branchTree(condition, trueLabel, trueMsg, falseLabel, falseMsg) {
  return `<taskTree schema_version="1.0" version="1"><request><task name="Start" id="start" definition_id="system_start_v1" x="200" y="50"><version>1</version><configured>true</configured><defers>false</defers><deferrable>false</deferrable><visible>false</visible><parameters></parameters><messages><message type="Complete"></message></messages><dependents><task type="Complete" label="${xmlEsc(trueLabel)}" value="${xmlEsc(condition)}">utilities_echo_v1_1</task><task type="Complete" label="${xmlEsc(falseLabel)}" value="true">utilities_echo_v1_2</task></dependents></task><task name="${xmlEsc(trueLabel)}" id="utilities_echo_v1_1" definition_id="utilities_echo_v1" x="100" y="200"><version>1</version><configured>true</configured><defers>false</defers><deferrable>false</deferrable><visible>false</visible><parameters><parameter id="input" label="Input" required="true" tooltip="" menu="">${xmlEsc(trueMsg)}</parameter></parameters><messages><message type="Complete"></message></messages><dependents></dependents></task><task name="${xmlEsc(falseLabel)}" id="utilities_echo_v1_2" definition_id="utilities_echo_v1" x="350" y="200"><version>1</version><configured>true</configured><defers>false</defers><deferrable>false</deferrable><visible>false</visible><parameters><parameter id="input" label="Input" required="true" tooltip="" menu="">${xmlEsc(falseMsg)}</parameter></parameters><messages><message type="Complete"></message></messages><dependents></dependents></task></request></taskTree>`;
}

// Auto-timestamp tree: Start → Set timestamp field via echo
function autoTimestamp() {
  return logTree("<%= @form['Name'] %> submitted at <%= Time.now.utc.iso8601 %> by <%= @submission['Created By'] %>: <%= @values.map{|k,v| k.to_s + '=' + v.to_s}.join(', ') %>");
}

// ─── Workflow definitions per form ───

const WORKFLOWS = [
  // ── Project ──
  { form: "project", name: "Project Submitted Logger", event: "Submission Submitted",
    xml: logTree("Project created: <%= @values['Project ID'] %> - <%= @values['Name'] %> by <%= @submission['Created By'] %> (Customer: <%= @values['Customer Name'] %>)") },
  { form: "project", name: "Project Health Change Monitor", event: "Submission Updated",
    xml: branchTree(
      "@values['Health'] == 'Red'",
      "Red Alert",
      "ALERT: Project <%= @values['Project ID'] %> health turned RED. PM: <%= @values['Project Manager'] %>. Stage: <%= @values['Stage'] %>. Updated by: <%= @submission['Updated By'] %>",
      "Normal Update",
      "Project <%= @values['Project ID'] %> updated. Health: <%= @values['Health'] %>. Stage: <%= @values['Stage'] %>. By: <%= @submission['Updated By'] %>"
    ) },

  // ── Status Update ──
  { form: "status-update", name: "Status Report Submitted", event: "Submission Submitted",
    xml: logTree("Status report submitted for <%= @values['Project ID'] %> by <%= @values['Reporter'] %>. Overall: <%= @values['Overall Health'] %>. Escalation: <%= @values['Escalation Flag'] %>") },
  { form: "status-update", name: "Escalation Detection", event: "Submission Submitted",
    xml: branchTree(
      "@values['Escalation Flag'] == 'Yes'",
      "Escalation",
      "ESCALATION: Project <%= @values['Project ID'] %> flagged for escalation by <%= @values['Reporter'] %>. Health: <%= @values['Overall Health'] %>. Executive Attention: <%= @values['Executive Attention'] %>",
      "No Escalation",
      "Status report for <%= @values['Project ID'] %> - no escalation"
    ) },

  // ── Quality Review ──
  { form: "quality-review", name: "Quality Review Submitted", event: "Submission Submitted",
    xml: logTree("Quality review (<%= @values['Gate Type'] %>) submitted for project <%= @values['Project ID'] %> by <%= @values['Reviewer'] %>. Score: <%= @values['Score'] %>. Decision: <%= @values['Decision'] %>") },
  { form: "quality-review", name: "Quality Gate Failure Alert", event: "Submission Submitted",
    xml: branchTree(
      "@values['Decision'] == 'Recovery Required' || @values['Decision'] == 'Rejected'",
      "Gate Failed",
      "QUALITY GATE FAILED: <%= @values['Gate Type'] %> for project <%= @values['Project ID'] %>. Decision: <%= @values['Decision'] %>. Score: <%= @values['Score'] %>. Reviewer: <%= @values['Reviewer'] %>",
      "Gate Passed",
      "Quality gate <%= @values['Gate Type'] %> passed for <%= @values['Project ID'] %>. Decision: <%= @values['Decision'] %>"
    ) },

  // ── Corrective Action ──
  { form: "corrective-action", name: "Corrective Action Created", event: "Submission Submitted",
    xml: logTree("Corrective action created: <%= @values['Title'] %> (Type: <%= @values['Type'] %>, Severity: <%= @values['Severity'] %>) for project <%= @values['Project ID'] %>. Owner: <%= @values['Owner'] %>. Due: <%= @values['Due Date'] %>") },
  { form: "corrective-action", name: "Corrective Action Status Change", event: "Submission Updated",
    xml: branchTree(
      "@values['Status'] == 'Completed'",
      "Action Completed",
      "Corrective action COMPLETED: <%= @values['Title'] %> for project <%= @values['Project ID'] %>. Validated by: <%= @values['Validated By'] %>",
      "Action Updated",
      "Corrective action updated: <%= @values['Title'] %> - Status: <%= @values['Status'] %>. By: <%= @submission['Updated By'] %>"
    ) },

  // ── Risk ──
  { form: "risk", name: "Risk Registered", event: "Submission Submitted",
    xml: logTree("Risk registered: <%= @values['Title'] %> (Severity: <%= @values['Severity'] %>, Probability: <%= @values['Probability'] %>) for project <%= @values['Project ID'] %>. Owner: <%= @values['Owner'] %>") },
  { form: "risk", name: "Critical Risk Escalation", event: "Submission Updated",
    xml: branchTree(
      "@values['Severity'] == 'Critical' && @values['Escalation Flag'] == 'Yes'",
      "Critical Escalation",
      "CRITICAL RISK ESCALATION: <%= @values['Title'] %> on project <%= @values['Project ID'] %>. Impact: <%= @values['Impact'] %>. Owner: <%= @values['Owner'] %>",
      "Risk Updated",
      "Risk updated: <%= @values['Title'] %> - Status: <%= @values['Status'] %>. Severity: <%= @values['Severity'] %>"
    ) },

  // ── Customer Feedback ──
  { form: "customer-feedback", name: "Feedback Received", event: "Submission Submitted",
    xml: logTree("Customer feedback received for project <%= @values['Project ID'] %> (Customer: <%= @values['Customer ID'] %>). Overall: <%= @values['Overall Score'] %>/5. Type: <%= @values['Feedback Type'] %>. Recommend: <%= @values['Would Recommend'] %>") },
  { form: "customer-feedback", name: "Low Score Follow-Up Trigger", event: "Submission Submitted",
    xml: branchTree(
      "@values['Overall Score'].to_i <= 2",
      "Low Score Alert",
      "LOW SATISFACTION ALERT: Customer <%= @values['Customer ID'] %> rated project <%= @values['Project ID'] %> at <%= @values['Overall Score'] %>/5. Follow-up required. Comments: <%= @values['Comments'] %>",
      "Positive Feedback",
      "Positive feedback from <%= @values['Customer ID'] %> on project <%= @values['Project ID'] %>: <%= @values['Overall Score'] %>/5"
    ) },

  // ── Recovery Plan ──
  { form: "recovery-plan", name: "Recovery Plan Initiated", event: "Submission Submitted",
    xml: logTree("RECOVERY PLAN initiated for project <%= @values['Project ID'] %>. Assigned to: <%= @values['Assigned To'] %>. Manager: <%= @values['Manager'] %>. Financial impact: $<%= @values['Financial Impact'] %>. Trigger: <%= @values['Trigger Reason'] %>") },

  // ── Time Entry ──
  { form: "time-entry", name: "Auto Timestamp", event: "Submission Submitted",
    xml: autoTimestamp() },

  // ── Change Request ──
  { form: "change-request", name: "Change Request Submitted", event: "Submission Submitted",
    xml: logTree("Change request submitted for project <%= @values['Project ID'] %>: <%= @values['Title'] %>. Budget impact: $<%= @values['Budget Impact'] %>. Schedule impact: <%= @values['Schedule Impact'] %>. Requested by: <%= @values['Requested By'] %>") },

  // ── Closeout Record ──
  { form: "closeout-record", name: "Closeout Status Logger", event: "Submission Updated",
    xml: branchTree(
      "@values['Status'] == 'Complete'",
      "Closeout Complete",
      "PROJECT CLOSEOUT COMPLETE: <%= @values['Project ID'] %> closed on <%= Time.now.utc.iso8601 %> by <%= @submission['Updated By'] %>",
      "Closeout Updated",
      "Closeout updated for <%= @values['Project ID'] %>. Status: <%= @values['Status'] %>. By: <%= @submission['Updated By'] %>"
    ) },
];

async function main() {
  console.log(`Creating ${WORKFLOWS.length} workflows for ${KAPP}...`);
  let ok = 0, fail = 0;
  for (const wf of WORKFLOWS) {
    try {
      // Create the workflow registration via Core API
      const res = await req("POST", `/kapps/${KAPP}/forms/${wf.form}/workflows`, {
        name: wf.name,
        event: wf.event,
        type: "Tree",
        status: "Active",
        treeXml: wf.xml,
      });
      console.log(`  ✓ ${wf.form} > ${wf.name}`);
      ok++;
    } catch (e) {
      console.error(`  ✗ ${wf.form} > ${wf.name}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone: ${ok} created, ${fail} failed`);
}

main();
