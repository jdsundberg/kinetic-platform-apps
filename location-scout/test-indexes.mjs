/**
 * test-indexes.mjs — runs EVERY declared index as a real KQL query against the
 * live store and asserts a 2xx. Two filters that share no index fail at runtime
 * while each works alone, so this has to be exercised combination by combination.
 *
 * Usage: node test-indexes.mjs <serverUrl> <user> <pass>
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'url';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const [, , SERVER, USER, PASS] = process.argv;
if (!SERVER || !USER || !PASS) { console.error('Usage: node test-indexes.mjs <serverUrl> <user> <pass>'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const KAPP = 'location-scout';
const BASE = SERVER.replace(/\/+$/, '');
const app = JSON.parse(fs.readFileSync(path.join(__dir, 'app.json'), 'utf-8'));

function get(apiPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + '/app/api/v1' + apiPath);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(u, { method: 'GET', headers: { Authorization: AUTH } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, data: j, raw: b.slice(0, 200) }); });
    });
    r.on('error', reject); r.end();
  });
}
async function sample(form) {
  const r = await get(`/kapps/${KAPP}/forms/${form}/submissions?limit=25&include=values`);
  return (r.data?.submissions || []).map(s => s.values || {});
}

const fieldOf = part => (part.match(/^values\[(.+)\]$/) || [])[1];
let ok = 0, fail = 0, skipped = 0;
const failures = [];

for (const form of app.forms) {
  if (!form.indexes) continue;
  const rows = await sample(form.slug);
  const combos = [
    ...(form.indexes.single || []).map(p => [p]),
    ...(form.indexes.compound || []),
  ];
  for (const parts of combos) {
    const fields = parts.map(fieldOf);
    // Find a live record that actually has a value for every field in this index,
    // so the query is representative rather than trivially empty.
    const row = rows.find(r => fields.every(f => r[f] !== undefined && r[f] !== '' && r[f] !== null));
    if (!row) { skipped++; continue; }
    const kql = fields.map(f => `values[${f}]="${String(row[f]).replace(/"/g, '')}"`).join(' AND ');
    const r = await get(`/kapps/${KAPP}/forms/${form.slug}/submissions?limit=25&include=values&q=${encodeURIComponent(kql)}`);
    if (r.status === 200 && !r.data?.error) {
      ok++;
      process.stdout.write('.');
    } else {
      fail++;
      failures.push(`${form.slug}  [${fields.join(' + ')}]  -> ${r.status} ${r.data?.error || r.raw}`);
      process.stdout.write('X');
    }
  }
}
console.log(`\n\n  ${ok} index combinations returned 2xx, ${fail} failed, ${skipped} skipped (no representative row)\n`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(fail ? 1 : 0);
