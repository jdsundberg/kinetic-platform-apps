/**
 * Band Scheduler — seed data generator.
 * Writes seed-data.json keyed by form slug: 20 venues, 100 bands, gigs, band feedback.
 * Deterministic (seeded PRNG) so re-running produces the same fictional world.
 * Usage: node gen-seed.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ── deterministic PRNG (mulberry32) ──
let _s = 0x5eed1e;
function rnd() { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const pad = (n) => String(n).padStart(3, "0");
const money = (n) => String(Math.round(n));

const GENRES = ["Rock", "Indie", "Punk", "Metal", "Jazz", "Blues", "Funk", "Soul", "Country", "Americana", "Bluegrass", "Hip-Hop", "Electronic", "Reggae", "Folk", "Pop"];
const VENUE_TYPES = ["Club", "Bar", "Theater", "Amphitheater", "Brewery", "Festival Grounds", "Coffeehouse", "Ballroom"];
const STAGE_SIZES = ["Small", "Medium", "Large"];
const SOUND = ["House PA + engineer", "House PA, BYO engineer", "Full line array", "Basic vocal PA", "Backline provided"];

const CITIES = [
  ["Minneapolis", "MN"], ["St. Paul", "MN"], ["Duluth", "MN"], ["Madison", "WI"], ["Milwaukee", "WI"],
  ["Chicago", "IL"], ["Des Moines", "IA"], ["Iowa City", "IA"], ["Omaha", "NE"], ["Kansas City", "MO"],
  ["St. Louis", "MO"], ["Fargo", "ND"], ["Sioux Falls", "SD"], ["Rochester", "MN"], ["Northfield", "MN"],
];

// ── 20 venues ──
const VENUE_DEFS = [
  ["The Tin Lantern", "Club", "Minneapolis", "MN", 450],
  ["Loring Hall", "Theater", "Minneapolis", "MN", 900],
  ["Cedar & Vine", "Bar", "Minneapolis", "MN", 180],
  ["Riverbend Amphitheater", "Amphitheater", "St. Paul", "MN", 4200],
  ["Selby Social Club", "Club", "St. Paul", "MN", 320],
  ["Kettle & Keg Brewing", "Brewery", "St. Paul", "MN", 260],
  ["Lake Superior Pavilion", "Amphitheater", "Duluth", "MN", 2600],
  ["The Copper Anchor", "Bar", "Duluth", "MN", 200],
  ["Harvest Grounds", "Festival Grounds", "Northfield", "MN", 3500],
  ["Blue Owl Coffeehouse", "Coffeehouse", "Northfield", "MN", 90],
  ["Quarry Ballroom", "Ballroom", "Rochester", "MN", 700],
  ["State Street Underground", "Club", "Madison", "WI", 380],
  ["Lakeshore Brewing Yard", "Brewery", "Madison", "WI", 500],
  ["The Gilded Moth", "Theater", "Milwaukee", "WI", 1100],
  ["Third Ward Tap", "Bar", "Milwaukee", "WI", 220],
  ["Warehouse 9", "Club", "Chicago", "IL", 850],
  ["Prairie Fire Stage", "Festival Grounds", "Des Moines", "IA", 3000],
  ["The Foundry Room", "Club", "Iowa City", "IA", 300],
  ["Union Pacific Hall", "Ballroom", "Omaha", "NE", 640],
  ["Boulevard Theatre", "Theater", "Kansas City", "MO", 1250],
];

const FIRST = ["Alex", "Jordan", "Casey", "Riley", "Morgan", "Taylor", "Devon", "Quinn", "Harper", "Rowan", "Micah", "Sasha", "Elena", "Theo", "Nina", "Owen", "Priya", "Marcus", "Ivy", "Gabe", "Lena", "Desmond", "Cora", "Felix"];
const LAST = ["Vasquez", "Okafor", "Lindstrom", "Petersen", "Nakamura", "Bergstrom", "Ellis", "Moreau", "Kowalski", "Rivera", "Halvorsen", "Dubois", "Mensah", "Novak", "Castellano", "Whitfield", "Ferraro", "Bianchi", "Odom", "Salcedo"];
const person = () => `${pick(FIRST)} ${pick(LAST)}`;
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const phone = () => `(${int(200, 989)}) ${int(200, 989)}-${String(int(0, 9999)).padStart(4, "0")}`;

const venues = VENUE_DEFS.map(([name, type, city, state, cap], i) => {
  const contact = person();
  return {
    "Venue ID": `VEN-${pad(i + 1)}`,
    "Venue Name": name,
    "Venue Type": type,
    "City": city,
    "State": state,
    "Address": `${int(100, 4800)} ${pick(["Main St", "Washington Ave", "Lake St", "Front St", "Mill Rd", "Division St", "Central Ave", "Riverside Dr"])}`,
    "Capacity": String(cap),
    "Stage Size": cap >= 1500 ? "Large" : cap >= 350 ? "Medium" : "Small",
    "Sound System": pick(SOUND),
    "Preferred Genre": pick(GENRES),
    "Contact Name": contact,
    "Contact Email": `${slugify(contact.split(" ")[0])}@${slugify(name)}.com`,
    "Contact Phone": phone(),
    "Base Fee": money(300 + Math.round(cap * (1.4 + rnd()))),
    "Status": i === 9 || i === 14 ? "Inactive" : "Active",
    "Notes": pick([
      "Load-in through the alley door; parking is tight on weekends.",
      "Green room upstairs, two dressing rooms.",
      "All-ages until 9pm, 21+ after.",
      "House drum kit and bass rig available on request.",
      "Sound check at 4:30, doors at 7:00.",
      "Outdoor stage — weather backup is the taproom.",
    ]),
  };
});

// ── 100 bands ──
const ADJ = ["Velvet", "Electric", "Midnight", "Golden", "Rusty", "Neon", "Wild", "Silver", "Broken", "Lonesome", "Cosmic", "Hollow", "Crooked", "Paper", "Iron", "Glass", "Northern", "Wandering", "Restless", "Copper", "Feral", "Quiet", "Sunken", "Marble", "Thunder"];
const NOUN = ["Sparrows", "Foxes", "Cassettes", "Lanterns", "Wolves", "Radio", "Boulevard", "Machines", "Coyotes", "Anchors", "Hymns", "Ravens", "Circuit", "Harbor", "Tigers", "Parade", "Orchard", "Comets", "Bandits", "Signals", "Pines", "Rivers", "Ghosts", "Motel", "Choir"];
const bandNames = new Set();
while (bandNames.size < 100) {
  const n = chance(0.18) ? `The ${pick(ADJ)} ${pick(NOUN)}` : `${pick(ADJ)} ${pick(NOUN)}`;
  bandNames.add(n);
}
const bands = [...bandNames].map((name, i) => {
  const [city, state] = pick(CITIES);
  const contact = person();
  const members = chance(0.05) ? 1 : int(2, 7); // occasional solo act
  const draw = int(40, 900);
  const status = chance(0.06) ? "On Hiatus" : chance(0.03) ? "Broken Up" : "Active";
  return {
    "Band ID": `BND-${pad(i + 1)}`,
    "Band Name": name,
    "Genre": pick(GENRES),
    "Home City": city,
    "Home State": state,
    "Members": String(members),
    "Formed Year": String(int(1998, 2025)),
    "Contact Name": contact,
    "Contact Email": `booking@${slugify(name)}.band`,
    "Contact Phone": phone(),
    "Rate": money(250 + draw * (1.2 + rnd() * 1.6)),
    "Typical Draw": String(draw),
    "Rating": String(int(3, 5)),
    "Website": `https://${slugify(name)}.band`,
    "Status": status,
    "Notes": pick([
      "Travels with own front-of-house engineer.",
      "Needs two 20-amp circuits stage left.",
      "Great for a Friday headline slot.",
      "Plays a tight 45-minute support set.",
      "Merch table required — sells well.",
      "Prefers late slots, no matinees.",
      "Van + trailer, needs oversized parking.",
    ]),
  };
});

// ── gigs ──
const activeVenues = venues.filter(v => v.Status === "Active");
const activeBands = bands.filter(b => b.Status === "Active");
const SET_TIMES = ["7:00 PM", "7:30 PM", "8:00 PM", "8:30 PM", "9:00 PM", "9:30 PM", "10:00 PM"];
const d2s = (d) => d.toISOString().slice(0, 10);
const TODAY = new Date("2026-08-12T00:00:00Z");

const gigs = [];
for (let i = 0; i < 240; i++) {
  const venue = pick(activeVenues);
  const band = pick(activeBands);
  const support = chance(0.55) ? pick(activeBands)["Band Name"] : "";
  // spread from 150 days back to 90 days ahead
  const offset = int(-150, 90);
  const date = new Date(TODAY.getTime() + offset * 86400000);
  const past = offset < 0;
  const cap = parseInt(venue.Capacity, 10);
  const draw = parseInt(band["Typical Draw"], 10);
  const door = int(10, 45);
  const guarantee = parseInt(band.Rate, 10);
  const status = past ? (chance(0.07) ? "Cancelled" : "Played") : (chance(0.45) ? "Confirmed" : "Scheduled");
  let sold = "", attendance = "", bar = "";
  if (status === "Played") {
    // Cap the house at 88-100% so a big draw in a small room reads as a busy night,
    // not a suspiciously exact sellout on a third of the calendar.
    const ceiling = Math.round(cap * (0.88 + rnd() * 0.12));
    const a = Math.max(15, Math.min(ceiling, Math.round(draw * (0.55 + rnd() * 0.95))));
    attendance = String(a);
    sold = String(Math.round(a * (0.75 + rnd() * 0.2)));
    bar = money(a * (7 + rnd() * 16));
  }
  gigs.push({
    "Gig ID": `GIG-${pad(i + 1)}`,
    "Gig Date": d2s(date),
    "Set Time": pick(SET_TIMES),
    "Venue": venue["Venue Name"],
    "Band": band["Band Name"],
    "Support Act": support === band["Band Name"] ? "" : support,
    "Genre": band.Genre,
    "City": venue.City,
    "Door Price": String(door),
    "Guarantee": String(guarantee),
    "Tickets Sold": sold,
    "Attendance": attendance,
    "Bar Sales": bar,
    "Status": status,
    "Notes": status === "Cancelled"
      ? pick(["Cancelled — van broke down outside Eau Claire.", "Cancelled — venue double-booked.", "Cancelled — singer lost their voice."])
      : pick(["Doors at 7, two-band bill.", "Sold as part of the summer series.", "All-ages show.", "Late set — curfew at midnight.", "Radio station co-promo.", ""]),
  });
}

// ── band feedback ──
const ROLES = ["Fan", "Venue Manager", "Sound Engineer", "Promoter", "Bartender"];
const CROWD = ["Packed and loud", "Enthusiastic", "Steady", "Polite but quiet", "Thin early, filled in"];
const POS = [
  "Tight set, started and ended on time. Would have them back.",
  "Crowd never sat down. Bar had its best night this month.",
  "Easy load-in, professional from soundcheck to teardown.",
  "Great energy and the mix was dialed in by the second song.",
  "Sold a ton of merch and stayed to talk to fans afterward.",
  "Perfect fit for a Saturday headline — packed the room.",
];
const MID = [
  "Solid performance, though the set ran about ten minutes long.",
  "Good show, but load-in was late and pushed soundcheck.",
  "Strong material, stage banter could be tighter.",
  "Nice draw for a Thursday. Volume was a bit hot up front.",
];
const NEG = [
  "Showed up late and the set never quite recovered.",
  "Mix was muddy and the band argued with the sound tech.",
  "Draw was well under what was promised.",
  "Left the green room a mess and skipped the settlement.",
];

const playedGigs = gigs.filter(g => g.Status === "Played");
const feedback = [];
for (let i = 0; i < 180; i++) {
  const gig = pick(playedGigs);
  const perf = chance(0.7) ? int(4, 5) : chance(0.75) ? 3 : int(1, 2);
  const prof = Math.max(1, Math.min(5, perf + (chance(0.3) ? int(-1, 1) : 0)));
  const overall = Math.max(1, Math.min(5, Math.round((perf + prof) / 2 + (chance(0.25) ? int(-1, 1) : 0))));
  feedback.push({
    "Feedback ID": `FBK-${pad(i + 1)}`,
    "Date": gig["Gig Date"],
    "Band": gig.Band,
    "Venue": gig.Venue,
    "Gig": `${gig.Band} @ ${gig.Venue}`,
    "Submitted By": person(),
    "Role": pick(ROLES),
    "Overall Rating": String(overall),
    "Performance Rating": String(perf),
    "Professionalism Rating": String(prof),
    "Crowd Response": pick(CROWD),
    "Would Book Again": overall >= 3 ? "Yes" : chance(0.3) ? "Yes" : "No",
    "Comment": overall >= 4 ? pick(POS) : overall === 3 ? pick(MID) : pick(NEG),
    "Status": chance(0.45) ? "New" : chance(0.6) ? "Reviewed" : "Resolved",
  });
}

const out = { venues, bands, gigs, feedback };
fs.writeFileSync(path.join(__dir, "seed-data.json"), JSON.stringify(out, null, 2));
console.log(`venues=${venues.length} bands=${bands.length} gigs=${gigs.length} feedback=${feedback.length}`);
console.log(`played gigs=${playedGigs.length}  upcoming=${gigs.filter(g => g.Status !== "Played" && g.Status !== "Cancelled").length}`);
