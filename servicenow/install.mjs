// One-shot install: creates the ServiceNow-equivalent kapp, forms, indexes, seeds data.
// Usage: node install.mjs <serverUrl> <user> <pass>
//   node install.mjs https://snow.kinetics.com john john1
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [serverUrl, user, pass] = process.argv.slice(2);
if (!serverUrl || !user || !pass) {
  console.error('usage: node install.mjs <serverUrl> <user> <pass>');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const BASE = serverUrl.replace(/\/+$/, '') + '/app/api/v1';

// snow.kinetics.com is served on the LAN with a self-signed certificate.
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SYSTEM_INDEXES = [
  { parts: ['closedBy'], unique: false },
  { parts: ['createdBy'], unique: false },
  { parts: ['handle'], unique: false },
  { parts: ['submittedBy'], unique: false },
  { parts: ['updatedBy'], unique: false },
];

async function k(method, urlPath, body) {
  const r = await fetch(BASE + urlPath, {
    method,
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const txt = await r.text();
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  return { status: r.status, data };
}

function buildPages(fields) {
  const elements = fields.map(f => ({
    type: 'field', name: f.name, label: f.name,
    key: crypto.randomBytes(16).toString('hex'),
    dataType: 'string', renderType: 'text',
    enabled: true, visible: true,
    required: f.required || false, rows: f.rows || 1,
    constraints: [], events: [], renderAttributes: {},
    defaultDataSource: 'none', defaultValue: '', defaultResourceName: '',
    requiredMessage: '', omitWhenHidden: null, pattern: null,
  }));
  elements.push({
    type: 'button', name: 'Submit Button', label: 'Submit',
    renderType: 'submit-page', visible: true, enabled: true, renderAttributes: {},
  });
  return [{ name: 'Page 1', type: 'page', renderType: 'submittable', elements, events: [] }];
}

const appDef = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.json'), 'utf-8'));
const seedData = fs.existsSync(path.join(__dirname, 'seed-data.json'))
  ? JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf-8'))
  : {};
const kappSlug = appDef.slug;

console.log(`Installing ${appDef.name} (${kappSlug}) to ${serverUrl} ...\n`);

// 1. Kapp
let r = await k('POST', '/kapps', { name: appDef.name, slug: kappSlug, status: 'Active' });
if (r.status < 300) console.log(`✓ kapp created: ${kappSlug}`);
else if (r.data?.errorKey === 'uniqueness_violation') console.log(`= kapp exists: ${kappSlug}`);
else { console.error(`✗ kapp failed (${r.status}):`, r.data); process.exit(1); }

// 2. Forms
for (const form of appDef.forms) {
  const body = { slug: form.slug, name: form.name, status: 'Active', pages: buildPages(form.fields) };
  if (form.description) body.description = form.description;
  if (form.submissionLabelExpression) body.submissionLabelExpression = form.submissionLabelExpression;
  r = await k('POST', `/kapps/${kappSlug}/forms`, body);
  if (r.status < 300) console.log(`✓ form created: ${form.slug} (${form.fields.length} fields)`);
  else if (r.data?.errorKey === 'uniqueness_violation') console.log(`= form exists: ${form.slug}`);
  else console.error(`✗ form failed ${form.slug} (${r.status}):`, r.data?.error || r.data);
}

// 3. Indexes
for (const form of appDef.forms.filter(f => f.indexes)) {
  const defs = [...SYSTEM_INDEXES];
  const custom = [];
  for (const p of (form.indexes.single || [])) { defs.push({ parts: [p], unique: false }); custom.push(p); }
  for (const parts of (form.indexes.compound || [])) { defs.push({ parts, unique: false }); custom.push(parts.join(',')); }
  r = await k('PUT', `/kapps/${kappSlug}/forms/${form.slug}`, { indexDefinitions: defs });
  if (custom.length > 0) {
    await k('POST', `/kapps/${kappSlug}/forms/${form.slug}/backgroundJobs`, {
      type: 'Build Index',
      content: { indexes: custom },
    });
  }
  console.log(`✓ indexes: ${form.slug} (${custom.length} custom)`);
}

// 4. Seed (concurrency 10)
console.log('\nSeeding data...');
for (const [formSlug, records] of Object.entries(seedData)) {
  let ok = 0, fail = 0;
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(values =>
        k('POST', `/kapps/${kappSlug}/forms/${formSlug}/submissions`, { values, coreState: 'Submitted' })
      )
    );
    for (const x of results) {
      if (x.status === 'fulfilled' && x.value.status < 300) ok++; else fail++;
    }
  }
  console.log(`  ${formSlug}: ${ok}/${records.length}${fail ? ` (${fail} failed)` : ''}`);
}

console.log('\nDone.');
