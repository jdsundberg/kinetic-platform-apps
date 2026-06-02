// Migration 1: add Notified 50%/90% fields to incidents form,
// create notifications form, ensure indexes.
import crypto from 'crypto';
const [serverUrl, user, pass] = process.argv.slice(2);
if (!serverUrl || !user || !pass) { console.error('usage: node migrate-1.mjs <serverUrl> <user> <pass>'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const BASE = serverUrl.replace(/\/+$/, '') + '/app/api/v1';
const KAPP = 'incidents';

async function k(method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  return { status: r.status, data };
}
function newField(name, rows = 1) {
  return {
    type: 'field', name, label: name, key: crypto.randomBytes(16).toString('hex'),
    dataType: 'string', renderType: 'text', enabled: true, visible: true,
    required: false, rows, constraints: [], events: [], renderAttributes: {},
    defaultDataSource: 'none', defaultValue: '', defaultResourceName: '',
    requiredMessage: '', omitWhenHidden: null, pattern: null,
  };
}
function buildPages(fields) {
  const elements = fields.map(f => typeof f === 'string' ? newField(f) : newField(f.name, f.rows||1));
  elements.push({ type: 'button', name: 'Submit Button', label: 'Submit', renderType: 'submit-page', visible: true, enabled: true, renderAttributes: {} });
  return [{ name: 'Page 1', type: 'page', renderType: 'submittable', elements, events: [] }];
}

// --- 1. Append fields to incidents form ---
console.log('Fetching incidents form…');
let r = await k('GET', `/kapps/${KAPP}/forms/incidents?include=details,pages,indexDefinitions`);
if (r.status >= 300) { console.error('fetch failed', r.status, r.data); process.exit(1); }
const form = r.data.form;
const pages = form.pages;
const page = pages[0];
const existingNames = new Set(page.elements.map(e => e.name));
const toAdd = ['Notified 50%', 'Notified 90%'].filter(n => !existingNames.has(n));
if (toAdd.length) {
  const submitIdx = page.elements.findIndex(e => e.type === 'button');
  for (const n of toAdd) page.elements.splice(submitIdx, 0, newField(n));
  r = await k('PUT', `/kapps/${KAPP}/forms/incidents`, { pages });
  console.log(`✓ added fields to incidents: ${toAdd.join(', ')} (status ${r.status})`);
} else console.log('= incidents fields already present');

// --- 2. Create notifications form ---
console.log('Creating notifications form…');
const nFields = ['To Username','Incident Id','Incident Number','Title','Threshold','Priority',{name:'Message',rows:3},'Read'];
r = await k('POST', `/kapps/${KAPP}/forms`, {
  slug: 'notifications', name: 'Notifications', status: 'Active', pages: buildPages(nFields)
});
if (r.status < 300) console.log('✓ notifications form created');
else if (r.data?.errorKey === 'uniqueness_violation') console.log('= notifications form exists');
else console.error('✗ notifications create:', r.status, r.data);

// --- 3. Indexes for notifications + incidents ---
const SYSTEM_INDEXES = [
  { parts: ['closedBy'], unique: false }, { parts: ['createdBy'], unique: false },
  { parts: ['handle'], unique: false }, { parts: ['submittedBy'], unique: false },
  { parts: ['updatedBy'], unique: false },
];

async function setIndexes(formSlug, single, compound) {
  const defs = [...SYSTEM_INDEXES];
  const custom = [];
  for (const p of single) { defs.push({ parts: [p], unique: false }); custom.push(p); }
  for (const parts of compound) { defs.push({ parts, unique: false }); custom.push(parts.join(',')); }
  const rr = await k('PUT', `/kapps/${KAPP}/forms/${formSlug}`, { indexDefinitions: defs });
  await k('POST', `/kapps/${KAPP}/forms/${formSlug}/backgroundJobs`, { type: 'Build Index', content: { indexes: custom } });
  console.log(`✓ indexes: ${formSlug} (${custom.length} custom, status ${rr.status})`);
}
await setIndexes('notifications', ['values[To Username]','values[Read]','values[Incident Id]'], [['values[To Username]','values[Read]']]);

console.log('\nDone.');
