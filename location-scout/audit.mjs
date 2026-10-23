/**
 * audit.mjs — asserts business invariants against the LIVE dataset.
 *
 * Not unit tests: assertions about the world the app models. Every failure is
 * either a real defect or a too-strict invariant — decide which, out loud.
 *
 * Usage: node audit.mjs <serverUrl> <user> <pass>
 */
import https from 'node:https';
import http from 'node:http';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const [, , SERVER, USER, PASS] = process.argv;
if (!SERVER || !USER || !PASS) { console.error('Usage: node audit.mjs <serverUrl> <user> <pass>'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const KAPP = 'location-scout';
const BASE = SERVER.replace(/\/+$/, '');

function get(apiPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + '/app/api/v1' + apiPath);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(u, { method: 'GET', headers: { Authorization: AUTH } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    });
    r.on('error', reject); r.end();
  });
}
// GOLDEN RULE: 25 per page, always.
async function all(form) {
  const out = []; let token = null;
  do {
    const q = `/kapps/${KAPP}/forms/${form}/submissions?limit=25&include=values`
      + (token ? `&pageToken=${encodeURIComponent(token)}` : '');
    const r = await get(q);
    out.push(...(r.submissions || []));
    token = r.nextPageToken || null;
  } while (token);
  return out.map(s => ({ id: s.id, ...s.values }));
}

const seasonOf = m => (m === 12 || m <= 2) ? 'Winter' : m <= 5 ? 'Spring' : m <= 8 ? 'Summer' : 'Fall';
const overlaps = (a1, a2, b1, b2) => !(a2 < b1 || a1 > b2);

let pass = 0, failTotal = 0;
const results = [];
function check(name, offenders, describe) {
  const bad = offenders || [];
  if (bad.length === 0) { pass++; results.push(['PASS', name, 0, null]); }
  else { failTotal++; results.push(['FAIL', name, bad.length, bad.slice(0, 3).map(describe).join(' | ')]); }
}

const [locations, projects, contacts, reports, holds, permits, photos] = await Promise.all(
  ['locations', 'projects', 'contacts', 'scout-reports', 'holds', 'permits', 'location-photos'].map(all));

const locByCode = Object.fromEntries(locations.map(l => [l['Location Code'], l]));
const projCodes = new Set(projects.map(p => p['Project Code']));
const contactByCode = Object.fromEntries(contacts.map(c => [c['Contact Code'], c]));

console.log(`\nAuditing ${locations.length} locations, ${photos.length} photos, ${contacts.length} contacts, ` +
  `${reports.length} reports, ${holds.length} holds, ${permits.length} permits, ${projects.length} projects\n`);

// ── Referential integrity ───────────────────────────────────────────────
for (const [label, rows] of [['photos', photos], ['contacts', contacts], ['reports', reports], ['holds', holds], ['permits', permits]]) {
  check(`referential: every ${label} row points at a real location`,
    rows.filter(r => r['Location Code'] && !locByCode[r['Location Code']]),
    r => `${r['Location Code']}`);
}
for (const [label, rows] of [['reports', reports], ['holds', holds], ['permits', permits]]) {
  check(`referential: every ${label} Project Code resolves`,
    rows.filter(r => r['Project Code'] && !projCodes.has(r['Project Code'])),
    r => `${r['Project Code']}`);
}
for (const [label, rows] of [['holds', holds], ['permits', permits]]) {
  check(`referential: every ${label} Contact Code resolves`,
    rows.filter(r => r['Contact Code'] && !contactByCode[r['Contact Code']]),
    r => `${r['Contact Code']}`);
}
// Containment: the primary contact must belong to the location that names it.
check('containment: Primary Contact Code belongs to its own location',
  locations.filter(l => l['Primary Contact Code'] &&
    (!contactByCode[l['Primary Contact Code']] ||
      contactByCode[l['Primary Contact Code']]['Location Code'] !== l['Location Code'])),
  l => `${l['Location Code']} -> ${l['Primary Contact Code']}`);

// ── Lifecycle consistency ───────────────────────────────────────────────
const reportsByLoc = {}; for (const r of reports) (reportsByLoc[r['Location Code']] ||= []).push(r);
const holdsByLoc = {};   for (const h of holds)   (holdsByLoc[h['Location Code']] ||= []).push(h);
const photosByLoc = {};  for (const p of photos)  (photosByLoc[p['Location Code']] ||= []).push(p);

check('lifecycle: a Prospect location has never been scouted (no reports)',
  locations.filter(l => l['Status'] === 'Prospect' && (reportsByLoc[l['Location Code']] || []).length),
  l => `${l['Location Code']} has ${reportsByLoc[l['Location Code']].length} report(s)`);

check('lifecycle: Scouted/Cleared/Restricted locations have at least one report',
  locations.filter(l => ['Scouted', 'Cleared', 'Restricted'].includes(l['Status']) && !(reportsByLoc[l['Location Code']] || []).length),
  l => `${l['Location Code']} (${l['Status']})`);

check('lifecycle: holds only exist on bookable (Cleared/Restricted) locations',
  holds.filter(h => locByCode[h['Location Code']] && !['Cleared', 'Restricted'].includes(locByCode[h['Location Code']]['Status'])),
  h => `${h['Hold Code']} on ${h['Location Code']} (${locByCode[h['Location Code']]['Status']})`);

check('lifecycle: a report is Reviewed exactly when its status is Approved/Rejected',
  reports.filter(r => {
    const reviewed = ['Approved', 'Rejected'].includes(r['Status']);
    const hasFields = !!(r['Reviewed By'] && r['Reviewed On']);
    return reviewed !== hasFields;
  }),
  r => `${r['Report Code']} status=${r['Status']} reviewedBy=${r['Reviewed By'] || '(none)'}`);

check('lifecycle: a permit has Issued On exactly when Issued/Expired',
  permits.filter(p => (['Issued', 'Expired'].includes(p['Status'])) !== !!p['Issued On']),
  p => `${p['Permit Code']} status=${p['Status']} issuedOn=${p['Issued On'] || '(none)'}`);

check('lifecycle: a permit has Applied On once it has been applied for',
  permits.filter(p => ['Applied', 'In Review', 'Issued', 'Denied', 'Expired'].includes(p['Status']) && !p['Applied On']),
  p => `${p['Permit Code']} (${p['Status']})`);

// ── Exclusivity ─────────────────────────────────────────────────────────
const doubleBooked = [];
for (const [code, list] of Object.entries(holdsByLoc)) {
  const confirmed = list.filter(h => h['Status'] === 'Confirmed');
  for (let i = 0; i < confirmed.length; i++)
    for (let j = i + 1; j < confirmed.length; j++)
      if (overlaps(confirmed[i]['Start Date'], confirmed[i]['End Date'], confirmed[j]['Start Date'], confirmed[j]['End Date']))
        doubleBooked.push({ code, a: confirmed[i], b: confirmed[j] });
}
check('exclusivity: no location has two overlapping Confirmed holds',
  doubleBooked, d => `${d.code}: ${d.a['Hold Code']} vs ${d.b['Hold Code']}`);

// ── Date sanity ─────────────────────────────────────────────────────────
check('dates: hold End Date is never before Start Date',
  holds.filter(h => h['End Date'] && h['Start Date'] && h['End Date'] < h['Start Date']),
  h => `${h['Hold Code']} ${h['Start Date']}→${h['End Date']}`);
check('dates: permit Expires On is after Issued On',
  permits.filter(p => p['Issued On'] && p['Expires On'] && p['Expires On'] <= p['Issued On']),
  p => `${p['Permit Code']} ${p['Issued On']}→${p['Expires On']}`);
check('dates: production Shoot End is never before Shoot Start',
  projects.filter(p => p['Shoot End'] && p['Shoot Start'] && p['Shoot End'] < p['Shoot Start']),
  p => `${p['Project Code']}`);
check('dates: a photo is never captured before its location was discovered',
  photos.filter(p => {
    const loc = locByCode[p['Location Code']];
    return loc && loc['Discovered On'] && p['Captured On'] && p['Captured On'] < loc['Discovered On'];
  }),
  p => `${p['Photo Code']} ${p['Captured On']} < ${locByCode[p['Location Code']]['Discovered On']}`);

// ── Photo consistency ───────────────────────────────────────────────────
check('photos: every photo record carries an actual file attachment',
  photos.filter(p => !Array.isArray(p['Photo']) || !p['Photo'].length || !p['Photo'][0].name),
  p => `${p['Photo Code']}`);

check('photos: Setting never contradicts the location Setting',
  photos.filter(p => {
    const loc = locByCode[p['Location Code']];
    if (!loc || loc['Setting'] === 'Both') return false;
    return p['Setting'] && p['Setting'] !== loc['Setting'];
  }),
  p => `${p['Photo Code']} ${p['Setting']} on ${p['Location Code']} (${locByCode[p['Location Code']]['Setting']})`);

check('photos: Season agrees with the Captured On month',
  photos.filter(p => {
    if (!p['Captured On'] || !p['Season']) return false;
    const m = parseInt(p['Captured On'].slice(5, 7), 10);
    return seasonOf(m) !== p['Season'];
  }),
  p => `${p['Photo Code']} ${p['Captured On']} labelled ${p['Season']}`);

check('photos: a Summer Only location has no off-season plates',
  photos.filter(p => {
    const loc = locByCode[p['Location Code']];
    return loc && loc['Seasonal Access'] === 'Summer Only' && p['Season'] !== 'Summer';
  }),
  p => `${p['Photo Code']} ${p['Season']} at ${p['Location Code']}`);

check('coverage: every active location has at least one photo',
  locations.filter(l => ['Prospect', 'Scouted', 'Cleared', 'Restricted'].includes(l['Status']) && !(photosByLoc[l['Location Code']] || []).length),
  l => `${l['Location Code']} (${l['Status']})`);

check('coverage: every location has at least one contact',
  locations.filter(l => !contacts.some(c => c['Location Code'] === l['Location Code'])),
  l => `${l['Location Code']}`);

// ── Uniqueness of business keys ─────────────────────────────────────────
for (const [label, rows, key] of [
  ['locations', locations, 'Location Code'], ['photos', photos, 'Photo Code'],
  ['contacts', contacts, 'Contact Code'], ['reports', reports, 'Report Code'],
  ['holds', holds, 'Hold Code'], ['permits', permits, 'Permit Code'], ['projects', projects, 'Project Code']]) {
  const seen = new Map();
  for (const r of rows) seen.set(r[key], (seen.get(r[key]) || 0) + 1);
  check(`uniqueness: ${label} ${key} is unique`,
    [...seen.entries()].filter(([, n]) => n > 1),
    ([k, n]) => `${k} ×${n}`);
}

// ── Report ──────────────────────────────────────────────────────────────
console.log('  ' + 'RESULT'.padEnd(6) + 'INVARIANT'.padEnd(62) + 'OFFENDERS');
console.log('  ' + '-'.repeat(100));
for (const [status, name, n, sample] of results) {
  const mark = status === 'PASS' ? ' ok ' : 'FAIL';
  console.log(`  ${mark.padEnd(6)}${name.slice(0, 60).padEnd(62)}${n || ''}`);
  if (sample) console.log(`        ↳ ${sample}`);
}
console.log(`\n  ${pass} passed, ${failTotal} failed, ${results.length} invariants checked\n`);
process.exit(failTotal ? 1 : 0);
