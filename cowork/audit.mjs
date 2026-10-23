/**
 * Minnetonka Cowork — invariant audit against the LIVE space.
 *
 * 1. Business truths over every record (not unit tests):
 *    - exclusivity: no room / desk held twice for overlapping time
 *    - capacity: attendees <= room capacity; "Needs TV" only in TV rooms
 *    - lifecycle: statuses agree with dates; holding states are whitelisted
 *    - referential: every Room / Desk / member name points at a real record
 *    - derived: Hours = End - Start; desk Zone matches the desk's zone
 * 2. Every filter combination a list screen can send runs against the server
 *    and must return 2xx (proves each has an index).
 *
 * Usage: KINETIC_PASS=... node audit.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const SERVER = process.env.KINETIC_URL || "https://first.kinetics.com";
const AUTH = "Basic " + Buffer.from(`${process.env.KINETIC_USER || "john"}:${process.env.KINETIC_PASS || ""}`).toString("base64");
const KAPP = "cowork";
const ROOM_HOLDING = ["Confirmed", "Checked In", "Completed"];
const DESK_HOLDING = ["Reserved", "Active", "Completed"];
const ROOM_STATUS = [...ROOM_HOLDING, "Cancelled", "No Show"];
const DESK_STATUS = [...DESK_HOLDING, "Cancelled"];

async function get(p) {
  const r = await fetch(`${SERVER}/app/api/v1${p}`, { headers: { Authorization: AUTH } });
  const t = await r.text();
  let d = {}; try { d = JSON.parse(t); } catch { d = { raw: t.slice(0, 200) }; }
  return { status: r.status, data: d };
}
// golden rule: 25 per page, walked with pageToken
async function all(form) {
  const out = []; let tok = null;
  do {
    const r = await get(`/kapps/${KAPP}/forms/${form}/submissions?include=values&limit=25${tok ? "&pageToken=" + encodeURIComponent(tok) : ""}`);
    if (r.status >= 300) throw new Error(`${form}: ${r.status}`);
    out.push(...r.data.submissions.map(s => ({ id: s.id, ...s.values })));
    tok = r.data.nextPageToken;
  } while (tok);
  return out;
}

const results = [];
function check(name, bad, fmt) {
  results.push({ name, n: bad.length });
  console.log(`${bad.length ? "✗" : "✓"} ${name}${bad.length ? ` — ${bad.length} violation(s)` : ""}`);
  bad.slice(0, 3).forEach(b => console.log("    e.g. " + fmt(b)));
}
const mins = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };

const [members, desks, rooms, rentals, bookings] = await Promise.all(
  ["members", "desks", "rooms", "desk-rentals", "room-bookings"].map(all));
console.log(`live: ${members.length} members, ${desks.length} desks, ${rooms.length} rooms, ${rentals.length} rentals, ${bookings.length} bookings\n`);
const today = new Date().toISOString().slice(0, 10);
const room = Object.fromEntries(rooms.map(r => [r["Room Name"], r]));
const desk = Object.fromEntries(desks.map(d => [d["Desk Name"], d]));
const member = new Set(members.map(m => m["Full Name"]));

// ── exclusivity ──
const rb = bookings.filter(b => ROOM_HOLDING.includes(b.Status));
const roomClash = [];
const byRoomDay = {};
for (const b of rb) (byRoomDay[b.Room + "|" + b["Booking Date"]] ||= []).push(b);
for (const list of Object.values(byRoomDay)) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
  const a = list[i], b = list[j];
  if (a["Start Time"] < b["End Time"] && b["Start Time"] < a["End Time"]) roomClash.push([a, b]);
}
check("no room double-booked", roomClash, ([a, b]) => `${a.Room} ${a["Booking Date"]} ${a["Start Time"]}-${a["End Time"]} vs ${b["Start Time"]}-${b["End Time"]}`);

const dr = rentals.filter(r => DESK_HOLDING.includes(r.Status));
const deskClash = [];
const byDesk = {};
for (const r of dr) (byDesk[r.Desk] ||= []).push(r);
for (const list of Object.values(byDesk)) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
  const a = list[i], b = list[j];
  if (a["Start Date"] <= b["End Date"] && b["Start Date"] <= a["End Date"]) deskClash.push([a, b]);
}
check("no desk double-rented", deskClash, ([a, b]) => `${a.Desk}: ${a.Member} ${a["Start Date"]}→${a["End Date"]} vs ${b.Member} ${b["Start Date"]}→${b["End Date"]}`);

// ── capacity / equipment ──
check("attendees fit the room", bookings.filter(b => room[b.Room] && +b.Attendees > +room[b.Room].Capacity),
  b => `${b.Room} (${room[b.Room].Capacity}) booked for ${b.Attendees}`);
check("'Needs TV' bookings are in TV rooms", bookings.filter(b => b["Needs TV"] === "Yes" && room[b.Room]?.["Has TV"] !== "Yes"),
  b => `${b["Booking ID"]} ${b.Room}`);
check("every room seats 6", rooms.filter(r => r.Capacity !== "6"), r => `${r["Room Name"]} = ${r.Capacity}`);
check("some rooms have TVs and some don't", (() => { const n = rooms.filter(r => r["Has TV"] === "Yes").length; return n > 0 && n < rooms.length ? [] : [n]; })(), n => `${n} of ${rooms.length} have TVs`);

// ── times / derived ──
check("bookings within 07:00–19:00, start < end, 30-min steps", bookings.filter(b =>
  !(b["Start Time"] >= "07:00" && b["End Time"] <= "19:00" && b["Start Time"] < b["End Time"] && mins(b["Start Time"]) % 30 === 0 && mins(b["End Time"]) % 30 === 0)),
  b => `${b["Booking ID"]} ${b["Start Time"]}-${b["End Time"]}`);
check("Hours = End − Start", bookings.filter(b => Math.abs(+b.Hours - (mins(b["End Time"]) - mins(b["Start Time"])) / 60) > 0.001),
  b => `${b["Booking ID"]} hours=${b.Hours} ${b["Start Time"]}-${b["End Time"]}`);
check("rental end >= start", rentals.filter(r => r["End Date"] < r["Start Date"]), r => `${r["Rental ID"]}`);
check("rental Zone matches its desk", rentals.filter(r => desk[r.Desk] && desk[r.Desk].Zone !== r.Zone), r => `${r["Rental ID"]} ${r.Desk} ${r.Zone}≠${desk[r.Desk].Zone}`);

// ── lifecycle ──
check("room booking statuses are known", bookings.filter(b => !ROOM_STATUS.includes(b.Status)), b => `${b["Booking ID"]} "${b.Status}"`);
check("desk rental statuses are known", rentals.filter(r => !DESK_STATUS.includes(r.Status)), r => `${r["Rental ID"]} "${r.Status}"`);
check("Completed / No Show bookings are not in the future", bookings.filter(b => ["Completed", "No Show"].includes(b.Status) && b["Booking Date"] > today),
  b => `${b["Booking ID"]} ${b.Status} on ${b["Booking Date"]}`);
check("Completed rentals ended in the past", rentals.filter(r => r.Status === "Completed" && r["End Date"] >= today), r => `${r["Rental ID"]} ends ${r["End Date"]}`);
check("Reserved rentals start in the future", rentals.filter(r => r.Status === "Reserved" && r["Start Date"] <= today),
  r => `${r["Rental ID"]} starts ${r["Start Date"]} (stale — should be Active or Completed now)`);
check("no future holds on out-of-service desks", dr.filter(r => desk[r.Desk]?.Status !== "Available" && r["End Date"] >= today),
  r => `${r.Desk} held ${r["Start Date"]}→${r["End Date"]}`);

// ── referential ──
check("bookings point at real rooms", bookings.filter(b => !room[b.Room]), b => `${b["Booking ID"]} → "${b.Room}"`);
check("rentals point at real desks", rentals.filter(r => !desk[r.Desk]), r => `${r["Rental ID"]} → "${r.Desk}"`);
check("bookers are members", bookings.filter(b => !member.has(b["Booked By"])), b => `${b["Booking ID"]} → "${b["Booked By"]}"`);
check("renters are members", rentals.filter(r => !member.has(r.Member)), r => `${r["Rental ID"]} → "${r.Member}"`);
check("unique desk names", desks.filter((d, i) => desks.findIndex(x => x["Desk Name"] === d["Desk Name"]) !== i), d => d["Desk Name"]);
check("unique room names", rooms.filter((r, i) => rooms.findIndex(x => x["Room Name"] === r["Room Name"]) !== i), r => r["Room Name"]);

// ── distribution: every visual branch has data ──
const need = (label, arr, key, vals) => check(`seed exercises every ${label}`, vals.filter(v => !arr.some(x => x[key] === v)), v => `none with ${key}="${v}"`);
need("room status", bookings, "Status", ROOM_STATUS);
need("rental status", rentals, "Status", DESK_STATUS);
need("rental type", rentals, "Rental Type", ["Day Pass", "Weekly", "Monthly"]);
need("member status", members, "Status", ["Active", "Prospect", "Paused", "Cancelled"]);

// ── every filter combination the list screens can send ──
console.log("\nfilter combinations (each must return 2xx):");
const sample = (arr, f) => arr.find(x => x[f])?.[f] || "x";
const SCREENS = {
  "room-bookings": { src: bookings, fields: ["Room", "Booking Date", "Status"] },
  "desk-rentals": { src: rentals, fields: ["Desk", "Rental Type", "Status"] },
  members: { src: members, fields: ["Status", "Plan"] },
  desks: { src: desks, fields: ["Zone", "Status"] },
};
const subsets = (a) => a.reduce((acc, x) => acc.concat(acc.map(s => [...s, x])), [[]]).filter(s => s.length);
let comboFail = 0, comboN = 0;
for (const [form, { src, fields }] of Object.entries(SCREENS)) {
  for (const set of subsets(fields)) {   // subsets keep declaration order == UI order
    const q = set.map(f => `values[${f}]="${sample(src, f)}"`).join(" AND ");
    const r = await get(`/kapps/${KAPP}/forms/${form}/submissions?include=values&limit=25&q=${encodeURIComponent(q)}`);
    comboN++;
    if (r.status >= 300) { comboFail++; console.log(`  ✗ ${form}: ${q} → ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`); }
  }
}
// ranged queries the server relies on
for (const [form, q, ob] of [
  ["room-bookings", `values[Room]="${rooms[0]["Room Name"].replace(/"/g, '\\"')}" AND values[Booking Date] >= "2026-01-01" AND values[Booking Date] <= "2026-12-31"`, "values[Booking Date]"],
  ["desk-rentals", `values[Desk]="D-01" AND values[End Date] >= "2026-01-01"`, "values[End Date]"],
]) {
  const r = await get(`/kapps/${KAPP}/forms/${form}/submissions?limit=25&q=${encodeURIComponent(q)}&orderBy=${encodeURIComponent(ob)}`);
  comboN++;
  if (r.status >= 300) { comboFail++; console.log(`  ✗ ${form}: ${q} → ${r.status}`); }
}
console.log(`${comboFail ? "✗" : "✓"} ${comboN - comboFail}/${comboN} filter/range queries OK`);
results.push({ name: "filter combinations", n: comboFail });

const failed = results.filter(r => r.n);
console.log(`\n${failed.length ? `${failed.length} check(s) FAILED` : "all checks passed"} (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
