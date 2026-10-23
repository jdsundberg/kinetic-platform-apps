/**
 * reconcile.mjs — makes the live space match seed-data.json.
 *
 * Idempotent and resumable: records are matched by BUSINESS KEY (not submission
 * id), drifted field values are updated in place, and missing records are
 * created. Nothing is deleted — removal stays a manual decision.
 *
 * Usage: node reconcile.mjs <serverUrl> <user> <pass> [--apply]
 *        (without --apply it reports the diff and changes nothing)
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'url';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const [, , SERVER, USER, PASS, ...flags] = process.argv;
if (!SERVER || !USER || !PASS) { console.error('Usage: node reconcile.mjs <serverUrl> <user> <pass> [--apply]'); process.exit(1); }
const APPLY = flags.includes('--apply');
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const KAPP = 'location-scout';
const BASE = SERVER.replace(/\/+$/, '');

const KEYS = {
  projects: 'Project Code', locations: 'Location Code', contacts: 'Contact Code',
  'scout-reports': 'Report Code', holds: 'Hold Code', permits: 'Permit Code',
};

function req(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + '/app/api/v1' + apiPath);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const r = lib.request(u, { method, headers: { Authorization: AUTH, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} resolve({ status: res.statusCode, data: j, raw: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function reqRetry(method, p, body, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { const r = await req(method, p, body); if (r.status < 500) return r; last = r; }
    catch (e) { last = { status: 0, raw: e.message }; }
    await sleep(400 * (i + 1));
  }
  return last;
}
// GOLDEN RULE: 25 per page.
async function all(form) {
  const out = []; let token = null;
  do {
    const r = await req('GET', `/kapps/${KAPP}/forms/${form}/submissions?limit=25&include=values`
      + (token ? `&pageToken=${encodeURIComponent(token)}` : ''));
    out.push(...(r.data?.submissions || []));
    token = r.data?.nextPageToken || null;
  } while (token);
  return out;
}

const seed = JSON.parse(fs.readFileSync(path.join(__dir, 'seed-data.json'), 'utf-8'));
console.log(`\n→ Reconciling against ${BASE}${APPLY ? '' : '   (dry run — pass --apply to write)'}\n`);

let totalUpd = 0, totalNew = 0, totalErr = 0;
for (const [form, records] of Object.entries(seed)) {
  const key = KEYS[form];
  if (!key) { console.log(`  • ${form}: no business key defined, skipped`); continue; }
  const live = await all(form);
  const byKey = new Map();
  for (const s of live) byKey.set((s.values || {})[key], s);

  const updates = [], creates = [];
  for (const want of records) {
    const have = byKey.get(want[key]);
    if (!have) { creates.push(want); continue; }
    const drift = Object.keys(want).filter(f => String((have.values || {})[f] ?? '') !== String(want[f] ?? ''));
    if (drift.length) updates.push({ id: have.id, key: want[key], want, drift });
  }

  console.log(`  ${form.padEnd(16)} live=${String(live.length).padEnd(4)} seed=${String(records.length).padEnd(4)} drifted=${String(updates.length).padEnd(4)} missing=${creates.length}`);
  for (const u of updates.slice(0, 3)) console.log(`      ↳ ${u.key}: ${u.drift.slice(0, 4).join(', ')}${u.drift.length > 4 ? ` (+${u.drift.length - 4})` : ''}`);

  if (!APPLY) { totalUpd += updates.length; totalNew += creates.length; continue; }

  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    const rs = await Promise.allSettled(batch.map(u => reqRetry('PUT', `/submissions/${u.id}`, { values: u.want })));
    for (const r of rs) (r.status === 'fulfilled' && r.value.status < 300) ? totalUpd++ : totalErr++;
  }
  for (let i = 0; i < creates.length; i += 10) {
    const batch = creates.slice(i, i + 10);
    const rs = await Promise.allSettled(batch.map(vals => reqRetry('POST', `/kapps/${KAPP}/forms/${form}/submissions`, { values: vals, coreState: 'Submitted' })));
    for (const r of rs) (r.status === 'fulfilled' && r.value.status < 300) ? totalNew++ : totalErr++;
  }
}
console.log(`\n${APPLY ? '✓ applied' : 'would apply'}: ${totalUpd} updates, ${totalNew} creates${totalErr ? `, ${totalErr} errors` : ''}\n`);
if (APPLY && totalErr) process.exit(1);
