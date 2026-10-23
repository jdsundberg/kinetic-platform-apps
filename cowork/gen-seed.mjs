/**
 * Minnetonka Cowork — seed generator.
 * Writes seed-data.json relative to a base date (default: today) so the schedule
 * always has past history, a live "today" and bookings ahead.
 *
 * Guarantees (checked again by audit.mjs against the live space):
 *   - no desk is held by two blocking rentals on the same calendar day
 *   - no room holds two blocking bookings with overlapping times
 *   - attendees <= room capacity; "Needs TV" bookings only land in TV rooms
 *   - statuses agree with dates (Completed = past, Reserved/Confirmed = ahead)
 *
 * Usage: node gen-seed.mjs [YYYY-MM-DD]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ── deterministic PRNG so re-runs produce the same data for the same base date ──
let seed = 20260926;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const isWeekday = (s) => { const w = parse(s).getDay(); return w > 0 && w < 6; };
// open every day for members; weekends run lighter
const isOpen = () => true;
const dayLoad = (s) => ([0, 6].includes(parse(s).getDay()) ? 0.4 : 1);
const daysBetween = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };

const TODAY = process.argv[2] || iso(new Date());
const NOW_MIN = process.argv[2] ? 12 * 60 : new Date().getHours() * 60 + new Date().getMinutes();
const statusFor = (start, end, future, active) => (end < TODAY ? "Completed" : start > TODAY ? future : active);

// ══════════════ ROOMS ══════════════
const ROOMS = [
  { name: "Gray's Bay",      tv: "Yes", size: '65"', vc: "Yes", wb: "Yes", rate: 45, loc: "North wing" },
  { name: "Big Willow",      tv: "Yes", size: '65"', vc: "Yes", wb: "Yes", rate: 45, loc: "North wing" },
  { name: "Purgatory Creek", tv: "Yes", size: '55"', vc: "No",  wb: "Yes", rate: 40, loc: "South wing" },
  { name: "Minnehaha",       tv: "Yes", size: '55"', vc: "No",  wb: "No",  rate: 40, loc: "South wing" },
  { name: "Shady Oak",       tv: "No",  size: "",    vc: "No",  wb: "Yes", rate: 30, loc: "Garden side" },
  { name: "Glen Lake",       tv: "No",  size: "",    vc: "No",  wb: "Yes", rate: 30, loc: "Garden side" },
];
const rooms = ROOMS.map((r, i) => ({
  "Room ID": `RM-${pad(i + 1)}`, "Room Name": r.name, "Capacity": "6", "Has TV": r.tv, "TV Size": r.size,
  "Video Conferencing": r.vc, "Whiteboard": r.wb, "Hourly Rate": String(r.rate), "Location": r.loc,
  "Status": "Available", "Notes": r.tv === "Yes" ? "HDMI + USB-C at the table" : "Quiet room, no display",
}));

// ══════════════ DESKS ══════════════
const ZONES = [
  { zone: "Window Row",   n: 6,  day: 35, week: 140, month: 375, feat: ["27\" monitor", "Lake view"] },
  { zone: "Open Floor",   n: 10, day: 30, week: 120, month: 325, feat: ["27\" monitor"] },
  { zone: "Quiet Zone",   n: 6,  day: 32, week: 130, month: 350, feat: ["27\" monitor", "Phone-free"] },
  { zone: "Standing Bar", n: 2,  day: 28, week: 110, month: 300, feat: ["Standing height"] },
];
const desks = [];
for (const z of ZONES) for (let i = 0; i < z.n; i++) {
  const n = desks.length + 1;
  desks.push({
    "Desk ID": `DK-${pad(n)}`, "Desk Name": `D-${pad(n)}`, "Zone": z.zone, "Features": z.feat.join(", "),
    "Day Rate": String(z.day), "Week Rate": String(z.week), "Month Rate": String(z.month),
    "Status": "Available", "Notes": "",
  });
}
// one desk out of service so that branch is visible — nothing booked on it from a week ago on
const OOS = "D-22";
Object.assign(desks.find(d => d["Desk Name"] === OOS), { Status: "Out of Service", Notes: "Monitor arm broken; replacement on order" });

// ══════════════ MEMBERS ══════════════
const FIRST = ["Emma","Liam","Olivia","Noah","Ava","Ethan","Sophia","Mason","Isabella","Logan","Mia","Lucas","Harper","Jackson","Evelyn","Aiden","Abigail","Carter","Emily","Owen","Ella","Wyatt","Grace","Henry","Chloe","Sam","Nora","Leo","Hannah","Jack","Zoe","Ben","Lily","Nate","Maya","Theo","Ruby","Eli","Claire","Gus","Priya","Omar","Mei","Diego","Anika","Tomas","Leah","Ravi","Ingrid","Soren"];
const LAST = ["Anderson","Johnson","Olson","Peterson","Larson","Nelson","Swanson","Hanson","Lindqvist","Berg","Carlson","Erickson","Thompson","Miller","Nguyen","Patel","Garcia","Kowalski","Schmidt","Novak","Lee","Kim","Haugen","Dahl","Moe","Ruud","Strand","Holm","Voss","Brandt"];
const COMPANIES = ["Independent","Independent","Independent","Lakeside Analytics","Bluestem Consulting","Northfield Design Co","Ridge Line Software","Cedar Path Marketing","Loon Point Ventures","Prairie Signal Labs","Birchwood Accounting","Twin Oaks Recruiting","Clearwater UX","Sumac Health Partners","Ironwood Legal Advisors"];
const PLANS = ["Pay As You Go", "Monthly Desk", "Meeting Rooms Only"];
const members = [];
const usedNames = new Set();
for (let i = 0; i < 72; i++) {
  let name;
  do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (usedNames.has(name));
  usedNames.add(name);
  const company = pick(COMPANIES);
  // first 16 are the monthly desk holders; the rest spread across plans
  const plan = i < 16 ? "Monthly Desk" : pick(["Pay As You Go", "Pay As You Go", "Meeting Rooms Only"]);
  const status = i < 14 ? "Active" : i < 16 ? "Cancelled" : pick(["Active","Active","Active","Active","Active","Paused","Prospect"]);
  const slug = name.toLowerCase().replace(/[^a-z]+/g, ".");
  const domain = company === "Independent" ? "gmail.com" : company.toLowerCase().replace(/[^a-z]+/g, "") + ".com";
  members.push({
    "Member ID": `MB-${String(i + 1).padStart(3, "0")}`, "Full Name": name, "Company": company,
    "Email": `${slug}@${domain}`, "Phone": `952-${int(200, 989)}-${String(int(0, 9999)).padStart(4, "0")}`,
    "Plan": plan, "Join Date": addDays(TODAY, -int(20, 700)), "Status": status,
    "Notes": status === "Prospect" ? "Toured the space; follow up on monthly desk" : "",
  });
}
const active = members.filter(m => m.Status === "Active");
const monthlyHolders = members.filter(m => m.Plan === "Monthly Desk");

// ══════════════ DESK RENTALS ══════════════
const deskRentals = [];
const held = {};                     // desk -> Set of days held by a blocking rental
const hold = (desk, days) => { const s = (held[desk] = held[desk] || new Set()); days.forEach(d => s.add(d)); };
const free = (desk, days) => !days.some(d => held[desk]?.has(d));
const deskRate = (desk, type) => desk[type === "Monthly" ? "Month Rate" : type === "Weekly" ? "Week Rate" : "Day Rate"];
let rentalN = 0;
function addRental(desk, m, type, start, end, status) {
  const days = daysBetween(start, end);
  if (status !== "Cancelled") hold(desk["Desk Name"], days);
  deskRentals.push({
    "Rental ID": `DR-${String(++rentalN).padStart(4, "0")}`, "Desk": desk["Desk Name"], "Zone": desk.Zone,
    "Member": m["Full Name"], "Company": m.Company, "Email": m.Email, "Rental Type": type,
    "Start Date": start, "End Date": end, "Rate": deskRate(desk, type), "Status": status, "Notes": "",
  });
}

// monthly: calendar months from two months back through next month
const monthStart = (s, k) => { const d = parse(s); return iso(new Date(d.getFullYear(), d.getMonth() + k, 1)); };
const monthEnd = (s, k) => { const d = parse(s); return iso(new Date(d.getFullYear(), d.getMonth() + k + 1, 0)); };
const MONTHS = [-2, -1, 0, 1];
const monthlyDesks = desks.filter(d => d.Status === "Available").slice(0, 14);  // window row, open floor, part of quiet zone
monthlyDesks.forEach((desk, i) => {
  const holder = monthlyHolders[i % monthlyHolders.length];
  for (const k of MONTHS) {
    const start = monthStart(TODAY, k), end = monthEnd(TODAY, k);
    // the two cancelled holders stopped after last month; a few desks are not yet re-let next month
    if (holder.Status === "Cancelled" && k >= 0) continue;
    if (k === 1 && i % 5 === 4) continue;
    addRental(desk, holder, "Monthly", start, end, statusFor(start, end, "Reserved", "Active"));
  }
});

// weekly + day passes on the remaining capacity, open days only
const WINDOW = daysBetween(addDays(TODAY, -56), addDays(TODAY, 35));
const walkIns = active.filter(m => m.Plan !== "Meeting Rooms Only");
for (const desk of desks) {
  const name = desk["Desk Name"];
  for (const day of WINDOW) {
    if (!isOpen(day)) continue;
    if (name === OOS && day >= addDays(TODAY, -7)) continue;
    // weekly rentals start on Mondays
    if (parse(day).getDay() === 1 && chance(0.12)) {
      const days = daysBetween(day, addDays(day, 4));
      if (free(name, days)) {
        const start = days[0], end = days[4];
        addRental(desk, pick(walkIns), "Weekly", start, end, chance(0.05) ? "Cancelled" : statusFor(start, end, "Reserved", "Active"));
        continue;
      }
    }
    const busy = day < TODAY ? 0.55 : day === TODAY ? 0.6 : Math.max(0.12, 0.45 - 0.012 * (parse(day) - parse(TODAY)) / 864e5);
    if (free(name, [day]) && chance(busy * dayLoad(day))) {
      addRental(desk, pick(walkIns), "Day Pass", day, day, chance(0.05) ? "Cancelled" : statusFor(day, day, "Reserved", "Active"));
    }
  }
}

// ══════════════ ROOM BOOKINGS ══════════════
const TITLES = ["Client kickoff","Quarterly planning","Design review","Sprint retro","Investor call","Hiring interview","Board prep","Sales pipeline review","Workshop","Vendor demo","Team standup","1:1","Strategy offsite","Product roadmap","Budget review","Training session","Partner sync","Customer interview"];
const TV_TITLES = ["Investor call","Vendor demo","Design review","Product roadmap","Customer interview","Training session","Client kickoff"];
const OPEN = 7 * 60, CLOSE = 19 * 60;
const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const roomBookings = [];
let bookingN = 0;
const DAYS = daysBetween(addDays(TODAY, -21), addDays(TODAY, 21)).filter(isOpen);
for (const day of DAYS) {
  for (const r of rooms) {
    const tv = r["Has TV"] === "Yes";
    const ahead = (parse(day) - parse(TODAY)) / 864e5;
    // TV rooms run busier; bookings thin out the further ahead we look
    let target = (tv ? 6.5 : 4) * 60 * dayLoad(day) * (ahead <= 0 ? 1 : Math.max(0.3, 1 - ahead / 25));
    const taken = [];
    let tries = 0;
    while (target > 0 && tries++ < 40) {
      const dur = pick([60, 60, 60, 90, 90, 120, 120, 180]);
      const start = OPEN + 30 * int(0, (CLOSE - OPEN - dur) / 30);
      const end = start + dur;
      if (taken.some(([a, b]) => start < b && a < end)) continue;
      taken.push([start, end]);
      target -= dur;
      const m = pick(active);
      const needsTv = tv && chance(0.6) ? "Yes" : "No";
      let status;
      if (day < TODAY) status = chance(0.07) ? "No Show" : "Completed";
      else if (day > TODAY) status = "Confirmed";
      else status = end <= NOW_MIN ? "Completed" : start <= NOW_MIN ? "Checked In" : "Confirmed";
      roomBookings.push({
        "Booking ID": `RB-${String(++bookingN).padStart(4, "0")}`, "Room": r["Room Name"], "Booking Date": day,
        "Start Time": hhmm(start), "End Time": hhmm(end), "Hours": String(dur / 60),
        "Booked By": m["Full Name"], "Company": m.Company, "Email": m.Email,
        "Attendees": String(int(2, 6)), "Meeting Title": needsTv === "Yes" ? pick(TV_TITLES) : pick(TITLES),
        "Needs TV": needsTv, "Rate": String(Math.round((dur / 60) * +r["Hourly Rate"])), "Status": status, "Notes": "",
      });
    }
    // a cancelled booking now and then — it sits on top of a live slot but blocks nothing
    if (chance(0.12)) {
      const start = OPEN + 30 * int(0, 20), m = pick(active);
      roomBookings.push({
        "Booking ID": `RB-${String(++bookingN).padStart(4, "0")}`, "Room": r["Room Name"], "Booking Date": day,
        "Start Time": hhmm(start), "End Time": hhmm(start + 60), "Hours": "1",
        "Booked By": m["Full Name"], "Company": m.Company, "Email": m.Email, "Attendees": String(int(2, 6)),
        "Meeting Title": pick(TITLES), "Needs TV": "No", "Rate": r["Hourly Rate"], "Status": "Cancelled",
        "Notes": "Cancelled by member",
      });
    }
  }
}

const out = { members, desks, rooms, "desk-rentals": deskRentals, "room-bookings": roomBookings };
fs.writeFileSync(path.join(__dir, "seed-data.json"), JSON.stringify(out, null, 1));

const count = (a, f) => a.reduce((m, x) => ((m[x[f]] = (m[x[f]] || 0) + 1), m), {});
console.log(`base date ${TODAY}`);
for (const [k, v] of Object.entries(out)) console.log(`  ${k}: ${v.length}`);
console.log("  rental types:", count(deskRentals, "Rental Type"));
console.log("  rental status:", count(deskRentals, "Status"));
console.log("  booking status:", count(roomBookings, "Status"));
console.log("  member status:", count(members, "Status"), "plans:", count(members, "Plan"));
