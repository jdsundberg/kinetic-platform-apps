/**
 * seed-photos.mjs — generates a procedural plate per location and uploads it as a
 * REAL Kinetic file attachment via POST .../submissions-multipart.
 *
 * Multipart contract (verified against Core 7.0.0, ManageSubmissionController):
 *   - the FIRST part is the JSON submission payload, read positionally (its part
 *     name is irrelevant; "_submission" is conventional). A body of only file
 *     parts fails with "Request body must contain at least one part."
 *   - every later part's field name must match a form field name exactly
 *   - the `link` returned in the value is space-slug-prefixed and 404s as-is;
 *     fetch attachments at /app/api/v1/submissions/{id}/files/{field}/{i}/{name}
 *
 * Idempotent + resumable: existing Photo Codes are skipped, so a re-run only
 * uploads what is missing.
 *
 * Usage: node seed-photos.mjs <serverUrl> <user> <pass> [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { renderPhoto } from './lib-png.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const [, , SERVER, USER, PASS, ...flags] = process.argv;
if (!SERVER || !USER || !PASS) { console.error('Usage: node seed-photos.mjs <serverUrl> <user> <pass> [--dry-run] [--repair-text]'); process.exit(1); }
const DRY = flags.includes('--dry-run');
const REPAIR = flags.includes('--repair-text');
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const KAPP = 'location-scout', FORM = 'location-photos';
const BASE = SERVER.replace(/\/+$/, '');

let _s = 771103;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const TODAY = new Date('2026-09-01T00:00:00Z');
const seasonOf = m => (m === 12 || m <= 2) ? 'Winter' : m <= 5 ? 'Spring' : m <= 8 ? 'Summer' : 'Fall';

function request(method, apiPath, payload, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + '/app/api/v1' + apiPath);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { Authorization: AUTH };
    if (payload) { headers['Content-Type'] = contentType; headers['Content-Length'] = payload.length; }
    const r = lib.request(u, { method, headers }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => {
        const b = Buffer.concat(c); let j = null;
        try { j = JSON.parse(b.toString()); } catch {}
        resolve({ status: res.statusCode, data: j, raw: b.toString().slice(0, 300) });
      });
    });
    r.on('error', reject); if (payload) r.write(payload); r.end();
  });
}
const getJson = (p) => request('GET', p, null, null);

function multipart(parts) {
  const b = '----ls' + crypto.randomBytes(10).toString('hex');
  const c = [];
  for (const p of parts) {
    c.push(Buffer.from(`--${b}\r\n`));
    let cd = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename) cd += `; filename="${p.filename}"`;
    cd += '\r\n';
    if (p.contentType) cd += `Content-Type: ${p.contentType}\r\n`;
    c.push(Buffer.from(cd + '\r\n'));
    c.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data)));
    c.push(Buffer.from('\r\n'));
  }
  c.push(Buffer.from(`--${b}--\r\n`));
  return { ct: `multipart/form-data; boundary=${b}`, body: Buffer.concat(c) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Serialise the multipart JSON part as PURE ASCII (\uXXXX escapes).
 *
 * Core parses that part with `new InputStreamReader(stream)` — no charset — so it
 * decodes with the JVM default charset. Where that is not UTF-8 a raw multi-byte
 * character is silently mangled (an em dash lands as three Latin-1 codepoints).
 * JSON \uXXXX escapes are ASCII, so they survive any default charset and the
 * parser rebuilds the original character. The plain /submissions JSON endpoint
 * does NOT have this problem — only multipart.
 */
function asciiJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

async function uploadPhoto(values, png, fileName, tries = 4) {
  const m = multipart([
    { name: '_submission', contentType: 'application/json', data: asciiJson({ values, coreState: 'Submitted' }) },
    { name: 'Photo', filename: fileName, contentType: 'image/png', data: png },
  ]);
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await request('POST', `/kapps/${KAPP}/forms/${FORM}/submissions-multipart?include=values`, m.body, m.ct);
      if (r.status < 300) return r;
      // 4xx other than contention is terminal — don't burn retries on a bad payload.
      if (r.status < 500 && r.status !== 409) return r;
      last = r;
    } catch (e) { last = { status: 0, raw: e.message }; }
    await sleep(500 * (i + 1));
  }
  return last;
}

// GOLDEN RULE: page at limit=25, never bulk-pull.
async function existingPhotoCodes() {
  const codes = new Set();
  let token = null;
  do {
    // include=values, NOT include=values[Photo Code]: the unencoded space in the
    // field name silently yields submissions with no values, which made this
    // "resume" check report zero and would have duplicated every photo on a re-run.
    const q = `/kapps/${KAPP}/forms/${FORM}/submissions?limit=25&include=values` + (token ? `&pageToken=${encodeURIComponent(token)}` : '');
    const r = await getJson(q);
    for (const s of (r.data?.submissions || [])) { const c = s.values?.['Photo Code']; if (c) codes.add(c); }
    token = r.data?.nextPageToken || null;
  } while (token);
  return codes;
}

/**
 * Undo the multipart charset mangling on values already stored.
 *
 * A character written through the multipart endpoint before the asciiJson fix
 * landed as its individual UTF-8 bytes reinterpreted as Latin-1 (an em dash
 * became three codepoints in U+0080..U+00FF). Re-encoding as Latin-1 and
 * decoding as UTF-8 reverses that exactly. Repairs are written back through the
 * plain JSON endpoint, which handles UTF-8 correctly.
 */
function demojibake(str) {
  if (typeof str !== 'string' || !/[\u0080-\u00ff]/.test(str)) return str;
  // Anything above U+00FF means the text is already correct — never touch it.
  for (const c of str) if (c.charCodeAt(0) > 0xff) return str;
  const fixed = Buffer.from(str, 'latin1').toString('utf8');
  if (fixed.includes('\ufffd')) return str;   // not valid UTF-8; leave it alone
  return fixed;
}

async function repairText() {
  const rows = [];
  let token = null;
  do {
    const r = await getJson(`/kapps/${KAPP}/forms/${FORM}/submissions?limit=25&include=values`
      + (token ? `&pageToken=${encodeURIComponent(token)}` : ''));
    rows.push(...(r.data?.submissions || []));
    token = r.data?.nextPageToken || null;
  } while (token);

  const broken = [];
  for (const s of rows) {
    const vals = s.values || {};
    const fixes = {};
    for (const [k, v] of Object.entries(vals)) {
      if (typeof v !== 'string') continue;
      const f = demojibake(v);
      if (f !== v) fixes[k] = f;
    }
    if (Object.keys(fixes).length) broken.push({ id: s.id, code: vals['Photo Code'], fixes });
  }
  console.log(`\n  ${rows.length} photo records scanned, ${broken.length} need repair`);
  for (const b of broken.slice(0, 3)) {
    const k = Object.keys(b.fixes)[0];
    console.log(`    e.g. ${b.code} ${k}: ${JSON.stringify(b.fixes[k])}`);
  }
  if (DRY) { console.log('\n  dry run — nothing written\n'); return; }

  let ok = 0, bad = 0;
  for (let i = 0; i < broken.length; i += 10) {
    const batch = broken.slice(i, i + 10);
    const rs = await Promise.allSettled(batch.map(b =>
      request('PUT', `/submissions/${b.id}`, Buffer.from(JSON.stringify({ values: b.fixes })), 'application/json')));
    for (const r of rs) (r.status === 'fulfilled' && r.value.status < 300) ? ok++ : bad++;
    process.stdout.write(`\r  repaired ${ok}/${broken.length}   `);
  }
  console.log(`\n\n  repaired: ${ok}, failed: ${bad}\n`);
}

const EXT_SHOTS = ['Establishing', 'Wide', 'Aerial / Drone', 'Approach / Access', 'Panorama', 'Detail'];
const INT_SHOTS = ['Interior', 'Detail', 'Reference'];
const PHOTOGS = ['Dana Whitlock', 'Marcus Feld', 'Priya Raman', 'Tobias Lindgren', 'Jules Arnesen', 'Sam Ostrand'];
const LENSES = ['16mm, f/5.6 — full width', '24mm, f/8 — handheld', '35mm, f/2.8 — natural light',
  '50mm, f/1.8 — shallow', '85mm, f/4 — compression', '14mm, drone, f/2.8'];
const TOD = ['Morning', 'Midday', 'Afternoon', 'Golden Hour', 'Blue Hour', 'Night'];

async function main() {
  if (REPAIR) { await repairText(); return; }
  const seed = JSON.parse(fs.readFileSync(path.join(__dir, 'seed-data.json'), 'utf-8'));
  const locations = seed.locations;
  // A dry run must report the SAME work a real run would do, so it checks what
  // already exists too — it just doesn't upload.
  const done = await existingPhotoCodes();
  console.log(`\n→ ${locations.length} locations; ${done.size} photos already present\n`);

  // Build the full plan first so Photo Codes are stable across runs.
  const plan = [];
  let n = 0;
  for (const loc of locations) {
    const setting = loc['Setting'];
    const count = setting === 'Both' ? 4 : 3;
    for (let k = 0; k < count; k++) {
      const code = `PH-${String(++n).padStart(4, '0')}`;
      // An Interior-only location can never yield an Exterior plate, and vice versa.
      const shotSetting = setting === 'Both' ? (k < 2 ? 'Exterior' : 'Interior') : setting;
      const shotType = shotSetting === 'Interior' ? INT_SHOTS[k % INT_SHOTS.length] : EXT_SHOTS[k % EXT_SHOTS.length];
      // Captured after the location was discovered; Season is DERIVED from the date
      // so the two can never disagree.
      const disc = new Date(loc['Discovered On'] + 'T00:00:00Z');
      const span = Math.max(1, Math.round((TODAY - disc) / 86400000));
      let captured = addDays(disc, int(0, span));
      let season = seasonOf(captured.getUTCMonth() + 1);
      // Respect the location's own seasonal access rather than inventing a winter
      // plate for a road that closes in October.
      if (loc['Seasonal Access'] === 'Summer Only' && season !== 'Summer') {
        captured = new Date(Date.UTC(captured.getUTCFullYear(), 6, int(1, 28)));
        season = 'Summer';
      }
      const timeOfDay = shotSetting === 'Interior' ? pick(['Morning', 'Midday', 'Afternoon']) : pick(TOD);
      plan.push({
        code, loc, shotType, shotSetting, timeOfDay, season, captured,
        photographer: pick(PHOTOGS), lens: pick(LENSES),
      });
    }
  }
  const todo = plan.filter(p => !done.has(p.code));
  console.log(`  planned ${plan.length} photos, ${todo.length} to upload\n`);
  if (DRY) {
    const bytes = todo.slice(0, 10).reduce((a, p) => a + renderPhoto({ code: p.code, name: p.loc['Location Name'], shotType: p.shotType, setting: p.shotSetting, timeOfDay: p.timeOfDay, season: p.season, category: p.loc['Category'], city: p.loc['City'] }).length, 0);
    console.log(`  dry run — avg plate ${(bytes / 10 / 1024).toFixed(1)} KB, est total ${(bytes / 10 * todo.length / 1024 / 1024).toFixed(1)} MB`);
    return;
  }

  let ok = 0, failed = 0; const errs = new Map();
  const CONC = 5;
  for (let i = 0; i < todo.length; i += CONC) {
    const batch = todo.slice(i, i + CONC);
    const results = await Promise.all(batch.map(async p => {
      const loc = p.loc;
      const png = renderPhoto({
        code: p.code, name: loc['Location Name'], shotType: p.shotType, setting: p.shotSetting,
        timeOfDay: p.timeOfDay, season: p.season, category: loc['Category'], city: loc['City'],
      });
      const values = {
        'Photo Code': p.code,
        'Location Code': loc['Location Code'],
        'Caption': `${loc['Location Name']} — ${p.shotType.toLowerCase()}, ${p.timeOfDay.toLowerCase()}`,
        'Shot Type': p.shotType,
        'Setting': p.shotSetting,
        'Time Of Day': p.timeOfDay,
        'Season': p.season,
        'Photographer': p.photographer,
        'Captured On': iso(p.captured),
        'Lens Notes': p.lens,
        'Notes': `${p.shotSetting} plate for ${loc['Sub Type'].toLowerCase()}; ${loc['City']}, MN.`,
      };
      const fileName = `${p.code.toLowerCase()}-${loc['Location Code'].toLowerCase()}.png`;
      return { p, r: await uploadPhoto(values, png, fileName), size: png.length };
    }));
    for (const { p, r } of results) {
      if (r.status < 300) ok++;
      else { failed++; const k = `${r.status} ${r.raw}`; errs.set(k, (errs.get(k) || 0) + 1); }
    }
    process.stdout.write(`\r  uploaded ${ok}/${todo.length}${failed ? `  (${failed} failed)` : ''}   `);
  }
  console.log();
  for (const [msg, count] of errs) console.log(`  ⚠ ${count}× ${msg}`);
  console.log(`\n✓ photos uploaded: ${ok}, failed: ${failed}\n`);
}
main().catch(e => { console.error(e); process.exit(1); });
