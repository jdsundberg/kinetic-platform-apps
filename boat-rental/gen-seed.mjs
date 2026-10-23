/**
 * Northwoods Boat Rental — seed data generator.
 * Writes seed-data.json keyed by form slug: lakes, boats, reservations, feedback, mailing-list.
 * Deterministic (seeded PRNG). Reservations are generated conflict-free: a boat never holds
 * overlapping blocks on a date (Full Day excludes both halves).
 * Usage: node gen-seed.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ── deterministic PRNG (mulberry32) ──
let _s = 0xB0A7ED;
function rnd() { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const pad = (n, w = 3) => String(n).padStart(w, "0");
const d2s = (d) => d.toISOString().slice(0, 10);

const TODAY = new Date("2026-08-14T00:00:00Z");
const BOAT_TYPES = ["Ski Boat", "Fishing Boat", "Pontoon"];
const TIME_BLOCKS = ["Half Day AM", "Half Day PM", "Full Day"];

// ── lakes: real Northern Minnesota waters ──
const LAKE_DEFS = [
  ["Leech Lake", "Cass", "Walker", 111527, 156, "Walleye, Muskie, Northern Pike, Perch"],
  ["Lake Winnibigoshish", "Itasca", "Deer River", 58544, 70, "Walleye, Northern Pike, Perch, Crappie"],
  ["Cass Lake", "Cass", "Cass Lake", 15596, 120, "Walleye, Muskie, Bass, Panfish"],
  ["Gull Lake", "Cass", "Nisswa", 9947, 80, "Walleye, Bass, Northern Pike, Tullibee"],
  ["Lake Vermilion", "St. Louis", "Tower", 39271, 76, "Walleye, Smallmouth Bass, Muskie, Crappie"],
  ["Rainy Lake", "Koochiching", "International Falls", 220800, 161, "Walleye, Smallmouth Bass, Northern Pike, Sturgeon"],
  ["Lake of the Woods", "Lake of the Woods", "Baudette", 950400, 210, "Walleye, Sauger, Northern Pike, Muskie"],
  ["Pelican Lake", "Crow Wing", "Breezy Point", 8367, 104, "Walleye, Bass, Northern Pike, Sunfish"],
  ["Ten Mile Lake", "Cass", "Hackensack", 4640, 208, "Walleye, Cisco, Bass, Northern Pike"],
  ["Big Sandy Lake", "Aitkin", "McGregor", 9400, 82, "Walleye, Crappie, Northern Pike, Bass"],
  ["Lake Bemidji", "Beltrami", "Bemidji", 6765, 76, "Walleye, Northern Pike, Perch, Bass"],
  ["Whitefish Chain", "Crow Wing", "Crosslake", 14103, 130, "Walleye, Bass, Muskie, Crappie"],
];
const AMENITIES = [
  "Paved launch, fish cleaning house, fuel dock",
  "Two public launches, picnic shelter, restrooms",
  "Marina with slip rental, bait shop, fuel",
  "Gravel launch, primitive camping, no fuel on site",
  "Full-service resort marina, restaurant, fuel dock",
  "Paved launch, courtesy dock, day-use park",
];

const lakes = LAKE_DEFS.map(([name, county, town, acres, depth, fish], i) => ({
  "Lake ID": `LK-${pad(i + 1)}`,
  "Lake Name": name,
  "County": county,
  "Nearest Town": town,
  "Acres": String(acres),
  "Max Depth": String(depth),
  "Boat Launch": pick(["Public — paved", "Public — gravel", "Resort marina", "Public + resort"]),
  "Marina": i % 4 === 3 ? "No" : "Yes",
  "Fish Species": fish,
  "Amenities": pick(AMENITIES),
  "Status": i === 8 ? "Seasonal" : "Active",
  "Notes": pick([
    "Big water — check the wind forecast before sending renters out.",
    "Shallow bars on the north end; renters get the hazard map at checkout.",
    "Popular weekend lake, reserve early in July and August.",
    "Quiet lake, good for first-time pontoon renters.",
    "Clear deep water, best ski conditions before 10am.",
  ]),
}));
const activeLakes = lakes.filter(l => l.Status === "Active");

// ── boats ──
const SKI = [["MasterCraft", "NXT22"], ["Malibu", "Wakesetter 21"], ["Nautique", "Ski Nautique 200"], ["Yamaha", "AR195"], ["Chaparral", "21 SSi"]];
const FISH = [["Lund", "Pro-V 1875"], ["Alumacraft", "Competitor 185"], ["Ranger", "620FS"], ["Crestliner", "1850 Fish Hawk"], ["Lund", "Impact 1875"]];
const PONTOON = [["Bennington", "22 SSRX"], ["Premier", "Sunsation 220"], ["Manitou", "Aurora 22"], ["Harris", "Cruiser 230"], ["Sylvan", "Mirage 8520"]];
const NAME_A = ["Loon", "Birch", "Timber", "Granite", "Aurora", "Boreal", "Tamarack", "Otter", "Walleye", "Balsam", "Cedar", "Moose", "Pine", "Beaver", "Heron"];
const NAME_B = ["Runner", "Cruiser", "Chaser", "Drifter", "Skipper", "Voyager", "Wanderer", "Glider"];

const boats = [];
let boatIdx = 0;
for (const lake of activeLakes) {
  const count = int(4, 7);
  for (let i = 0; i < count; i++) {
    const type = i === 0 ? "Pontoon" : i === 1 ? "Fishing Boat" : pick(BOAT_TYPES);
    const [make, model] = pick(type === "Ski Boat" ? SKI : type === "Fishing Boat" ? FISH : PONTOON);
    const year = int(2018, 2026);
    const half = type === "Ski Boat" ? int(285, 395) : type === "Pontoon" ? int(225, 325) : int(165, 245);
    const status = chance(0.06) ? "Maintenance" : chance(0.03) ? "Retired" : "Available";
    boatIdx++;
    boats.push({
      "Boat ID": `BT-${pad(boatIdx)}`,
      "Boat Name": `${pick(NAME_A)} ${pick(NAME_B)} ${boatIdx}`,
      "Boat Type": type,
      "Make": make,
      "Model": model,
      "Year": String(year),
      "Capacity": String(type === "Pontoon" ? int(10, 14) : type === "Ski Boat" ? int(6, 8) : int(4, 6)),
      "Horsepower": String(type === "Ski Boat" ? int(320, 450) : type === "Pontoon" ? int(115, 250) : int(90, 200)),
      "Lake": lake["Lake Name"],
      "Half Day Rate": String(half),
      "Full Day Rate": String(Math.round(half * 1.7)),
      "Engine Hours": String(int(40, 1400)),
      "Last Service": d2s(new Date(TODAY.getTime() - int(5, 260) * 86400000)),
      "Status": status,
      "Notes": status === "Maintenance"
        ? pick(["Lower unit service, back in the water next week.", "Waiting on an impeller.", "Warranty work at the dealer."])
        : pick(["Bimini top, swim ladder, cooler included.", "Life jackets for full capacity on board.", "Tower with two boards and a tube.", "Livewell, locator, and two swivel seats.", "Fuel is billed at return.", ""]),
    });
  }
}
const rentable = boats.filter(b => b.Status === "Available");

// ── customers ──
const FIRST = ["Erik", "Anna", "Jack", "Maria", "Ben", "Sofia", "Luke", "Hannah", "Tomas", "Greta", "Sam", "Nora", "Dan", "Ingrid", "Paul", "Lena", "Chris", "Maya", "Nate", "Elsa", "Ryan", "Clara", "Jon", "Britta"];
const LAST = ["Anderson", "Johnson", "Lindgren", "Halvorson", "Berg", "Nyberg", "Sorensen", "Carlson", "Odegard", "Thorson", "Ellingson", "Rasmussen", "Kowalczyk", "Bergstrom", "Salo", "Maki", "Koskinen", "Hartman", "Dahl", "Fjeld"];
const CITIES = [["Minneapolis", "MN"], ["St. Paul", "MN"], ["Duluth", "MN"], ["Rochester", "MN"], ["Brainerd", "MN"], ["Bemidji", "MN"], ["Fargo", "ND"], ["Sioux Falls", "SD"], ["Des Moines", "IA"], ["Madison", "WI"], ["Chicago", "IL"], ["Eau Claire", "WI"]];
const person = () => `${pick(FIRST)} ${pick(LAST)}`;
const emailOf = (n) => `${n.toLowerCase().replace(/[^a-z]+/g, ".")}@${pick(["gmail.com", "yahoo.com", "outlook.com", "comcast.net"])}`;
const phone = () => `(${pick([218, 320, 507, 612, 651, 763, 952])}) ${int(200, 989)}-${pad(int(0, 9999), 4)}`;

// ── reservations (conflict-free) ──
// booked[boat][date] = Set of blocks. Full Day blocks the whole day.
const booked = {};
function canBook(boat, date, block) {
  const day = (booked[boat] = booked[boat] || {});
  const held = (day[date] = day[date] || new Set());
  if (held.has("Full Day")) return false;
  if (block === "Full Day") return held.size === 0;
  return !held.has(block);
}
function hold(boat, date, block) { booked[boat][date].add(block); }

const reservations = [];
let resIdx = 0, attempts = 0;
while (reservations.length < 320 && attempts < 6000) {
  attempts++;
  const boat = pick(rentable);
  // season skew: Northern MN rentals run late May through early October
  const offset = int(-90, 60);
  const date = new Date(TODAY.getTime() + offset * 86400000);
  const m = date.getUTCMonth() + 1;
  if (m < 5 || m > 10) continue;
  const block = pick(TIME_BLOCKS);
  if (!canBook(boat["Boat Name"], d2s(date), block)) continue;
  hold(boat["Boat Name"], d2s(date), block);

  const past = offset < 0;
  const cust = person();
  const rate = block === "Full Day" ? +boat["Full Day Rate"] : +boat["Half Day Rate"];
  const status = past
    ? (chance(0.08) ? "Cancelled" : "Returned")
    : (offset === 0 ? "Out" : chance(0.6) ? "Confirmed" : "Requested");
  resIdx++;
  reservations.push({
    "Reservation ID": `RES-${pad(resIdx)}`,
    "Reservation Date": d2s(date),
    "Time Block": block,
    "Boat": boat["Boat Name"],
    "Boat Type": boat["Boat Type"],
    "Lake": boat["Lake"],
    "Customer Name": cust,
    "Customer Email": emailOf(cust),
    "Customer Phone": phone(),
    "Party Size": String(int(2, Math.max(3, +boat.Capacity))),
    "Rate": String(rate),
    "Deposit": String(Math.round(rate * 0.25)),
    "Status": status,
    "Notes": status === "Cancelled"
      ? pick(["Cancelled — storms in the forecast.", "Cancelled — party couldn't make the drive up.", "Cancelled — rebooked for a later week."])
      : pick(["Requested the bimini up at pickup.", "First-time renters — walk through the controls.", "Repeat customer.", "Wants the fish locator demoed.", "Bringing their own tube.", ""]),
  });
}

// ── feedback (on boats AND lakes) ──
const returned = reservations.filter(r => r.Status === "Returned");
const POS_BOAT = [
  "Boat was spotless and ran perfectly all day.",
  "Great pontoon for a family day — plenty of shade and room.",
  "Motor started first try every time. Easy checkout.",
  "Ski boat pulled the kids all afternoon without a hiccup.",
  "Livewell and locator both worked great, we limited out.",
];
const POS_LAKE = [
  "Beautiful water and the launch was easy to find.",
  "Quiet lake even on a Saturday. We'll be back.",
  "Fishing was excellent off the north bars.",
  "Clear water and great swimming spots.",
];
const MID = [
  "Good day overall, though the boat was low on fuel at pickup.",
  "Solid rental. Launch was crowded midday.",
  "Boat was fine, seats could use a cleaning.",
  "Fun day but the wind made the big water rough by noon.",
];
const NEG = [
  "Motor was hard to start and died on us twice.",
  "Boat was not clean when we picked it up.",
  "Waited 40 minutes past our block to get on the water.",
  "Depth finder was dead the whole trip.",
];

const feedback = [];
for (let i = 0; i < 200 && returned.length; i++) {
  const r = pick(returned);
  const type = chance(0.5) ? "Both" : chance(0.6) ? "Boat" : "Lake";
  const boatR = chance(0.72) ? int(4, 5) : chance(0.7) ? 3 : int(1, 2);
  const lakeR = chance(0.8) ? int(4, 5) : 3;
  const clean = Math.max(1, Math.min(5, boatR + (chance(0.3) ? int(-1, 1) : 0)));
  const staff = chance(0.85) ? int(4, 5) : 3;
  // Weight the boat experience heaviest — averaging four sub-scores pulls every
  // record to the middle and leaves nobody who would decline to rent again.
  let overall = Math.round((boatR * 2 + lakeR + clean + staff) / 5);
  if (boatR <= 2) overall = Math.min(overall, boatR + 1);
  overall = Math.max(1, Math.min(5, overall));
  feedback.push({
    "Feedback ID": `FB-${pad(i + 1)}`,
    "Date": r["Reservation Date"],
    "Feedback Type": type,
    "Boat": type === "Lake" ? "" : r.Boat,
    "Boat Type": type === "Lake" ? "" : r["Boat Type"],
    "Lake": r.Lake,
    "Reservation": r["Reservation ID"],
    "Submitted By": r["Customer Name"],
    "Submitted Email": r["Customer Email"],
    "Overall Rating": String(overall),
    "Boat Rating": type === "Lake" ? "" : String(boatR),
    "Lake Rating": type === "Boat" ? "" : String(lakeR),
    "Cleanliness Rating": type === "Lake" ? "" : String(clean),
    "Staff Rating": String(staff),
    "Would Rent Again": boatR >= 3 && overall >= 3 ? "Yes" : chance(0.2) ? "Yes" : "No",
    "Comment": overall >= 4 ? (type === "Lake" ? pick(POS_LAKE) : pick(POS_BOAT)) : overall === 3 ? pick(MID) : pick(NEG),
    "Status": chance(0.4) ? "New" : chance(0.6) ? "Reviewed" : "Resolved",
  });
}

// ── mailing list ──
const SOURCES = ["Rental checkout", "Website signup", "Boat show", "Resort partner", "Referral"];
const INTERESTS = [...BOAT_TYPES, "All boats", "Fishing reports", "Family outings"];
const QUARTERS = ["2026-Q1", "2026-Q2"];
const seenEmail = new Set();
const mailing = [];
// every renter who left an email is a natural subscriber, then pad with signups
const renterPool = [...new Map(reservations.map(r => [r["Customer Email"], r])).values()];
for (let i = 0; i < 260; i++) {
  let first, last, email, city, state, src, sub;
  if (i < renterPool.length) {
    const r = renterPool[i];
    [first, last] = r["Customer Name"].split(" ");
    email = r["Customer Email"];
    [city, state] = pick(CITIES);
    src = "Rental checkout";
    sub = r["Reservation Date"];
  } else {
    const n = person();
    [first, last] = n.split(" ");
    email = emailOf(n + int(1, 99));
    [city, state] = pick(CITIES);
    src = pick(SOURCES);
    sub = d2s(new Date(TODAY.getTime() - int(20, 900) * 86400000));
  }
  if (seenEmail.has(email)) continue;
  seenEmail.add(email);
  const status = chance(0.09) ? "Unsubscribed" : chance(0.03) ? "Bounced" : "Subscribed";
  const mailed = status === "Subscribed" && chance(0.8);
  mailing.push({
    "Subscriber ID": `SUB-${pad(mailing.length + 1)}`,
    "First Name": first,
    "Last Name": last,
    "Email": email,
    "Phone": phone(),
    "City": city,
    "State": state,
    "Preferred Lake": chance(0.75) ? pick(activeLakes)["Lake Name"] : "",
    "Interests": pick(INTERESTS),
    "Source": src,
    "Subscribed Date": sub,
    "Last Mailed": mailed ? "2026-04-06" : "",
    "Last Quarter Mailed": mailed ? pick(QUARTERS) : "",
    "Status": status,
    "Notes": status === "Bounced" ? "Mail bounced on the last send — needs a good address." : "",
  });
}

const out = { lakes, boats, reservations, feedback, "mailing-list": mailing };
fs.writeFileSync(path.join(__dir, "seed-data.json"), JSON.stringify(out, null, 2));
console.log(`lakes=${lakes.length} boats=${boats.length} (rentable ${rentable.length}) reservations=${reservations.length} feedback=${feedback.length} mailing=${mailing.length}`);
const byType = {}; boats.forEach(b => byType[b["Boat Type"]] = (byType[b["Boat Type"]] || 0) + 1);
console.log("fleet by type:", byType);
const byBlock = {}; reservations.forEach(r => byBlock[r["Time Block"]] = (byBlock[r["Time Block"]] || 0) + 1);
console.log("blocks:", byBlock);
const byStatus = {}; reservations.forEach(r => byStatus[r.Status] = (byStatus[r.Status] || 0) + 1);
console.log("reservation status:", byStatus);
