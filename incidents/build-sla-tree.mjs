// Generate the SLA Timer workflow tree XML for incidents form.
// Outputs to ./sla-timer.tree.xml
//
// Flow:
//   start → wait 50% of (SLA Due − Opened At) → fetch status →
//   (open?) yes → create notification (To Username = "Incident Managers", Threshold=50) →
//   wait another 40% → fetch status → (open?) yes → notify (Threshold=90)
//
// Notifications target the team — UI filters by user's team membership.
import fs from 'node:fs';

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Compute wait duration in seconds using SLA Due / Opened At if parsable, else priority fallback.
// Stays as ERB so it evaluates at runtime (handles SLA edits / unusual priorities).
function waitERB(fraction) {
  // fraction = 0.5 for 50% step, 0.4 for additional step from 50% → 90%
  return `<%= ` +
    `begin; require 'time'; t = ((Time.parse(@values['SLA Due']) - Time.parse(@values['Opened At'])) * ${fraction}).to_i; t < 30 ? 30 : t; ` +
    `rescue; ((({'Critical'=>4,'High'=>8,'Medium'=>24,'Low'=>72}[@values['Priority']] || 24) * 3600 * ${fraction}).to_i); end %>`;
}

// JSON body for the Notify nodes. The Title field may contain quotes — escape via Ruby gsub at runtime.
function notifyBody(threshold) {
  // Keep this on one line; ERB tokens are inserted literally.
  return `{` +
    `"values":{` +
      `"To Username":"Incident Managers",` +
      `"Incident Id":"<%= @submission['Id'] %>",` +
      `"Incident Number":"<%= @values['Incident Number'] %>",` +
      `"Title":"<%= @values['Title'].to_s.gsub('\\\\','\\\\\\\\').gsub('"','\\\\"') %>",` +
      `"Threshold":"${threshold}",` +
      `"Priority":"<%= @values['Priority'] %>",` +
      `"Message":"Incident <%= @values['Incident Number'] %> reached ${threshold}% of SLA window and is still <%= JSON.parse(@results['Fetch Status ${threshold}']['Response Body'])['submission']['values']['Status'] rescue 'Open' %>.",` +
      `"Read":"No"` +
    `},` +
    `"coreState":"Submitted"` +
  `}`;
}

// Branch condition: still open per fetched status — RAW Ruby (NOT ERB-wrapped) — connector values.
function stillOpenCond(fetchNodeName) {
  return `[&apos;Open&apos;,&apos;In Progress&apos;,&apos;On Hold&apos;].include?((JSON.parse(@results[&apos;${fetchNodeName}&apos;][&apos;Response Body&apos;])[&apos;submission&apos;][&apos;values&apos;][&apos;Status&apos;] rescue &apos;Open&apos;))`;
}

function task({ name, id, defId, x, y, defers=false, deferrable=false, parameters=[], dependents=[] }) {
  const defersFlag = defers ? 'true' : 'false';
  const deferrableFlag = deferrable ? 'true' : 'false';
  const paramXml = parameters.map(p =>
    `      <parameter id="${xmlEscape(p.id)}" label="${xmlEscape(p.label || p.id)}" required="${p.required ? 'true' : 'false'}">${xmlEscape(p.value)}</parameter>`
  ).join('\n');
  const depXml = dependents.map(d =>
    `      <task type="${d.type || 'Complete'}"${d.label ? ` label="${xmlEscape(d.label)}"` : ''}${d.value ? ` value="${d.value}"` : ''}>${d.content}</task>`
  ).join('\n');
  const messages = deferrable
    ? `      <message type="Create"></message>\n      <message type="Update"></message>\n      <message type="Complete"></message>`
    : `      <message type="Complete"></message>`;
  return `  <task name="${xmlEscape(name)}" id="${id}" definition_id="${defId}" x="${x}" y="${y}">
    <version>1</version>
    <configured>true</configured>
    <defers>${defersFlag}</defers>
    <deferrable>${deferrableFlag}</deferrable>
    <visible>true</visible>
    <parameters>
${paramXml}
    </parameters>
    <messages>
${messages}
    </messages>
    <dependents>
${depXml}
    </dependents>
  </task>`;
}

const tasks = [
  // start
  task({
    name: 'Start', id: 'start', defId: 'system_start_v1', x: 200, y: 50,
    parameters: [],
    dependents: [{ type: 'Complete', content: 'system_wait_v1_2' }],
  }),
  // wait 50%
  task({
    name: 'Wait 50', id: 'system_wait_v1_2', defId: 'system_wait_v1', x: 200, y: 150,
    defers: true, deferrable: true,
    parameters: [
      { id: 'Time to wait', value: waitERB(0.5), required: true },
      { id: 'Time unit', value: 'Second' },
    ],
    dependents: [{ type: 'Complete', content: 'kinetic_core_api_connection_v1_3' }],
  }),
  // fetch 50
  task({
    name: 'Fetch Status 50', id: 'kinetic_core_api_connection_v1_3', defId: 'kinetic_core_api_connection_v1', x: 200, y: 250,
    parameters: [
      { id: 'method', value: 'GET', required: true },
      { id: 'path', value: `/app/api/v1/submissions/<%= @submission['Id'] %>?include=values`, required: true },
      { id: 'body', value: '' },
      { id: 'extra_headers', value: '' },
      { id: 'error_handling', value: 'Error Message', required: true },
    ],
    dependents: [
      { type: 'Complete', label: 'Still Open', value: stillOpenCond('Fetch Status 50'), content: 'kinetic_core_api_connection_v1_4' },
    ],
  }),
  // notify 50
  task({
    name: 'Notify 50', id: 'kinetic_core_api_connection_v1_4', defId: 'kinetic_core_api_connection_v1', x: 200, y: 350,
    parameters: [
      { id: 'method', value: 'POST', required: true },
      { id: 'path', value: '/app/api/v1/kapps/incidents/forms/notifications/submissions?completed=true', required: true },
      { id: 'body', value: notifyBody(50) },
      { id: 'extra_headers', value: '' },
      { id: 'error_handling', value: 'Error Message', required: true },
    ],
    dependents: [{ type: 'Complete', content: 'system_wait_v1_5' }],
  }),
  // wait additional 40% (so total = 90%)
  task({
    name: 'Wait 90', id: 'system_wait_v1_5', defId: 'system_wait_v1', x: 200, y: 450,
    defers: true, deferrable: true,
    parameters: [
      { id: 'Time to wait', value: waitERB(0.4), required: true },
      { id: 'Time unit', value: 'Second' },
    ],
    dependents: [{ type: 'Complete', content: 'kinetic_core_api_connection_v1_6' }],
  }),
  // fetch 90
  task({
    name: 'Fetch Status 90', id: 'kinetic_core_api_connection_v1_6', defId: 'kinetic_core_api_connection_v1', x: 200, y: 550,
    parameters: [
      { id: 'method', value: 'GET', required: true },
      { id: 'path', value: `/app/api/v1/submissions/<%= @submission['Id'] %>?include=values`, required: true },
      { id: 'body', value: '' },
      { id: 'extra_headers', value: '' },
      { id: 'error_handling', value: 'Error Message', required: true },
    ],
    dependents: [
      { type: 'Complete', label: 'Still Open', value: stillOpenCond('Fetch Status 90'), content: 'kinetic_core_api_connection_v1_7' },
    ],
  }),
  // notify 90
  task({
    name: 'Notify 90', id: 'kinetic_core_api_connection_v1_7', defId: 'kinetic_core_api_connection_v1', x: 200, y: 650,
    parameters: [
      { id: 'method', value: 'POST', required: true },
      { id: 'path', value: '/app/api/v1/kapps/incidents/forms/notifications/submissions?completed=true', required: true },
      { id: 'body', value: notifyBody(90) },
      { id: 'extra_headers', value: '' },
      { id: 'error_handling', value: 'Error Message', required: true },
    ],
    dependents: [],
  }),
];

const xml = `<taskTree schema_version="1.0" version="1">
<name>SLA Timer</name>
<author></author>
<notes></notes>
<lastID>7</lastID>
<request>
${tasks.join('\n')}
</request>
</taskTree>`;

fs.writeFileSync(new URL('./sla-timer.tree.xml', import.meta.url), xml);
console.log('Wrote sla-timer.tree.xml');
console.log('Nodes:', tasks.length);
