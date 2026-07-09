/**
 * gen-seed.mjs — realistic seed-data.json for Crux Bouldering. Deterministic PRNG.
 *   node gen-seed.mjs   →  writes seed-data.json
 */
import fs from "node:fs";
import path from "node:path";
const DIR = path.dirname(new URL(import.meta.url).pathname);

let _s = 0x1a2b3c4d;
function rnd() { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const pad = (n, w = 4) => String(n).padStart(w, "0");
const dateStr = (y, m, d) => `${y}-${pad(m, 2)}-${pad(d, 2)}`;

const FIRST = ["Alex","Sam","Jordan","Taylor","Casey","Morgan","Riley","Jamie","Avery","Quinn","Skyler","Cameron","Drew","Reese","Kai","Rowan","Sage","Emerson","Finley","Harper","Devin","Blake","Charlie","Dakota","Elliot","Hayden","Jesse","Logan","Marley","Noah","Parker","River","Shawn","Tatum","Wren","Nico","Mateo","Sofia","Luna","Mia","Ivy","Remy","Juno","Cleo","Theo","Ezra","Ada","Beck","Coral","Dash"];
const LAST = ["Nguyen","Ramirez","Kessler","Okafor","Bianchi","Sato","Kowalski","Petrov","Andersen","Mbeki","Rossi","Fischer","Novak","Haas","Delgado","Larsen","Costa","Yamamoto","Silva","Bauer","Vance","Cho","Reyes","Frost","Kane","Mercer","Ellison","Whitaker","Barlow","Sharp","Quill","Vega","Ash","Cliff","Stone","Ridge","Crag","Boulder","Holt","Marsh"];
const name = () => `${pick(FIRST)} ${pick(LAST)}`;

const GRADES = ["V0","V1","V2","V3","V4","V5","V6","V7","V8","V9","V10","V11","V12"];
const GRADE_W = [4,6,9,11,12,12,10,8,6,4,3,2,1]; // weight toward mid grades
function pickGrade() { const tot = GRADE_W.reduce((a, b) => a + b, 0); let r = rnd() * tot; for (let i = 0; i < GRADES.length; i++) { r -= GRADE_W[i]; if (r <= 0) return GRADES[i]; } return "V4"; }
const COLORS = ["Red","Blue","Green","Yellow","Purple","Orange","Black","White","Pink","Teal"];
const STYLES = ["Overhang","Slab","Vertical","Roof","Arete","Dihedral","Compression","Slopers","Crimps","Dyno","Mantle","Traverse"];
const WALLS = ["Main Cave","Slab Wall","The Prow","Comp Wall","Back 45","Training Room","The Corner","Moon Board Area","Kids Zone","Woody","North Face","The Gully"];
const SETTERS = () => name();
const ADJ = ["Crimpy","Dynamic","Balancy","Powerful","Techy","Burly","Delicate","Sketchy","Classic","Sandbagged","Flowy","Committing","Cryptic","Juggy"];

const BOULDER_NAMES = ["Chalkdust","Send Train","The Pinch","Gravity Well","Crux Move","Heel Hook Heaven","Sloper City","Dyno King","Static Cling","Toe Jam","Mantle Madness","Compression Session","Arete Assault","Roof Rider","Slab Master","Pocket Rocket","Crimp Trap","The Campus","Deadpoint","Flagging Fool","Smear Campaign","Gaston Gauntlet","Undercling Union","Kneebar Kingdom","Beta Break","Flash Point","Project X","The Traverse","Highball Hero","Sit Start Special","Mono Madness","Pinch Point","Volume Control","The Committing Move","Sloth Mode","Send It Sunday","Chalk Bag Blues","The Whipper","Gecko Grip","Static Shock"];

const LOCATIONS = [
  { id: "LOC-0001", name: "Vertical Edge Boulder Gym", type: "Indoor Gym", city: "Boulder", state: "CO", cap: 120 },
  { id: "LOC-0002", name: "Crux Climbing Collective", type: "Indoor Gym", city: "Salt Lake City", state: "UT", cap: 150 },
  { id: "LOC-0003", name: "Sender City", type: "Indoor Gym", city: "Seattle", state: "WA", cap: 110 },
  { id: "LOC-0004", name: "Granite Arch Co-op", type: "Climbing Co-op", city: "Portland", state: "OR", cap: 80 },
  { id: "LOC-0005", name: "Bishop Bouldering Fields", type: "Outdoor Crag", city: "Bishop", state: "CA", cap: 200 },
  { id: "LOC-0006", name: "Iron Peak Climbing", type: "Indoor Gym", city: "Austin", state: "TX", cap: 130 },
  { id: "LOC-0007", name: "Campus Rock Wall", type: "University Wall", city: "Boston", state: "MA", cap: 60 },
  { id: "LOC-0008", name: "Red River Boulders", type: "Outdoor Crag", city: "Slade", state: "NY", cap: 150 },
];
const HOURS = ["6am–11pm daily", "Mon–Fri 6am–10pm, Sat/Sun 8am–8pm", "Dawn to dusk", "24/7 members", "10am–10pm daily", "Seasonal · Apr–Oct"];

const out = { locations: [], boulders: [], reservations: [], comments: [], donations: [] };
const bouldersByLoc = {};
let boSeq = 0, resSeq = 0, cmSeq = 0, dnSeq = 0;
const usedBoulderNames = new Set();

for (const loc of LOCATIONS) {
  bouldersByLoc[loc.name] = [];
  const count = int(12, 18);
  for (let i = 0; i < count; i++) {
    boSeq++;
    let bn; let guard = 0;
    do { bn = chance(0.5) ? pick(BOULDER_NAMES) : `${pick(ADJ)} ${pick(BOULDER_NAMES)}`; guard++; } while (usedBoulderNames.has(bn) && guard < 8);
    if (usedBoulderNames.has(bn)) bn = `${bn} #${boSeq}`;
    usedBoulderNames.add(bn);
    const status = chance(0.82) ? "Open" : (chance(0.5) ? "Project" : (chance(0.5) ? "Closed" : "Stripped"));
    const rec = { id: `BO-${pad(boSeq, 4)}`, name: bn, grade: pickGrade(), color: pick(COLORS), style: pick(STYLES), status };
    bouldersByLoc[loc.name].push(rec);
    const setMonth = int(1, 6);
    out.boulders.push({
      "Boulder ID": rec.id, "Name": bn, "Location": loc.name, "Grade": rec.grade,
      "Hold Color": rec.color, "Wall Section": pick(WALLS), "Style": rec.style,
      "Setter": SETTERS(), "Set Date": dateStr(2026, setMonth, int(1, 28)),
      "Avg Rating": "", "Rating Count": "0", "Send Count": "0", "Status": status,
      "Description": `A ${rec.grade} ${rec.style.toLowerCase()} problem on the ${pick(WALLS).toLowerCase()}.`,
    });
  }
  out.locations.push({
    "Location ID": loc.id, "Name": loc.name, "Type": loc.type,
    "Address": `${int(100, 9999)} ${pick(["Granite","Summit","Chalk","Boulder","Cliff","Ridge","Quarry"])} ${pick(["Ave","St","Rd","Way","Blvd"])}`,
    "City": loc.city, "State": loc.state, "Phone": `(${int(200, 989)}) ${int(200, 989)}-${pad(int(0, 9999), 4)}`,
    "Hours": pick(HOURS), "Capacity": String(loc.cap), "Boulder Count": String(bouldersByLoc[loc.name].length),
    "Description": `${loc.type} in ${loc.city}, ${loc.state}. Fresh sets weekly.`,
    "Status": loc.type === "Outdoor Crag" ? (chance(0.5) ? "Seasonal" : "Open") : "Open",
  });
}

// ── comments / board posts (drive ratings + sends) ────────────────────────
const COMMENT_TEXT = {
  hi: ["Instant classic — perfect movement top to bottom.","So good I did it twice. Chef's kiss beta.","Best problem in the gym right now, go send it!","Flowy and fun, felt easier than the grade.","Amazing setting, that heel hook is genius."],
  mid: ["Solid problem, crux is a bit reachy.","Fun but the start is awkward for shorter folks.","Good burn, felt stiff for the grade.","Decent, holds were a little greasy today.","Nice moves but the topout is sketchy."],
  lo: ["Sandbagged hard, felt two grades up.","Not a fan — the crux is pure luck.","Holds spin, needs a re-set.","Meh, boring slab plod.","Hurt my finger on that mono, be careful."],
};
const ratingByLoc = {};
for (const loc of LOCATIONS) {
  const boulders = bouldersByLoc[loc.name];
  for (const b of boulders) {
    if (b.status === "Stripped") continue;
    const nPosts = int(0, 7);
    let sum = 0, cnt = 0, sends = 0;
    for (let i = 0; i < nPosts; i++) {
      cmSeq++;
      const rating = chance(0.6) ? int(4, 5) : (chance(0.6) ? 3 : int(1, 2));
      const bucket = rating >= 4 ? "hi" : rating === 3 ? "mid" : "lo";
      const sent = chance(0.55) ? "Yes" : "No";
      if (sent === "Yes") sends++;
      sum += rating; cnt++;
      const gi = GRADES.indexOf(b.grade);
      const suggested = chance(0.4) ? GRADES[Math.max(0, Math.min(GRADES.length - 1, gi + int(-1, 1)))] : "";
      out.comments.push({
        "Comment ID": `CM-${pad(cmSeq, 4)}`, "Boulder": b.name, "Location": loc.name,
        "Author": name(), "Rating": String(rating), "Suggested Grade": suggested,
        "Attempts": String(sent === "Yes" ? int(1, 12) : int(3, 30)), "Sent": sent,
        "Comment": pick(COMMENT_TEXT[bucket]), "Date": dateStr(2026, int(2, 6), int(1, 28)),
      });
    }
    // write back computed rating onto the boulder record
    const rec = out.boulders.find(x => x["Boulder ID"] === b.id);
    if (cnt) { rec["Avg Rating"] = (sum / cnt).toFixed(1); rec["Rating Count"] = String(cnt); }
    rec["Send Count"] = String(sends);
  }
}

// ── reservations ──────────────────────────────────────────────────────────
const TIMES = ["7:00 AM","8:00 AM","9:00 AM","10:00 AM","11:00 AM","12:00 PM","1:00 PM","2:00 PM","3:00 PM","4:00 PM","5:00 PM","6:00 PM","7:00 PM","8:00 PM"];
function addHour(t) { const idx = TIMES.indexOf(t); return TIMES[Math.min(TIMES.length - 1, idx + int(1, 2))]; }
for (let i = 0; i < 160; i++) {
  resSeq++;
  const loc = pick(LOCATIONS);
  const boulders = bouldersByLoc[loc.name].filter(b => b.status === "Open" || b.status === "Project");
  if (!boulders.length) continue;
  const b = pick(boulders);
  const mm = int(6, 8), day = int(1, 28);
  const future = mm > 7 || (mm === 7 && day >= 1);
  let status;
  if (future) status = chance(0.75) ? "Confirmed" : "Pending";
  else status = pick(["Completed", "Completed", "Completed", "No-Show", "Cancelled"]);
  const start = pick(TIMES);
  out.reservations.push({
    "Reservation ID": `RS-${pad(resSeq, 4)}`, "Boulder": b.name, "Location": loc.name,
    "Reserved By": name(), "Email": `climber${resSeq}@example.com`,
    "Reserve Date": dateStr(2026, mm, day), "Start Time": start, "End Time": addHour(start),
    "Party Size": String(int(1, 6)), "Status": status,
    "Notes": chance(0.2) ? "Working a project, need the pads." : "",
  });
}

// ── donations to the Boulder Training Fund ────────────────────────────────
const TIERS = [[5, "Chalk Up"], [10, "Send Supporter"], [20, "Crux Crusher"]];
const DON_MSG = ["Send it! 🧗", "Love this gym.", "For the youth clinics!", "Keep setting great problems.", "Chalk up!", "", "", "Best community around.", "Happy to help.", ""];
for (let i = 0; i < 85; i++) {
  dnSeq++;
  const [amt, tier] = TIERS[Math.floor(Math.pow(rnd(), 1.3) * 3) % 3];
  const anon = chance(0.18);
  const loc = chance(0.65) ? pick(LOCATIONS).name : "";
  out.donations.push({
    "Donation ID": `DN-${pad(dnSeq, 4)}`, "Donor Name": anon ? "Anonymous" : name(),
    "Email": anon ? "" : `donor${dnSeq}@example.com`, "Amount": String(amt), "Tier": tier,
    "Fund": "Boulder Training Fund", "Location": loc, "Message": pick(DON_MSG),
    "Anonymous": anon ? "Yes" : "No", "Date": dateStr(2026, int(1, 7), int(1, 28)),
    "Status": chance(0.9) ? "Paid" : "Pending",
  });
}

fs.writeFileSync(path.join(DIR, "seed-data.json"), JSON.stringify(out, null, 2));
const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
console.log("Wrote seed-data.json:", JSON.stringify(counts));
