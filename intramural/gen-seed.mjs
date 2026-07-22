/**
 * gen-seed.mjs — realistic seed-data.json for St. Olaf College Intramural Sports.
 * 9 sports across fall/winter/spring, 10 teams per sport, a game schedule with
 * scores, standings tallied from those games, and player game-feedback.
 * Deterministic PRNG. Pure Node built-ins.
 *   node gen-seed.mjs   →  writes seed-data.json
 */
import fs from "node:fs";
import path from "node:path";
const DIR = path.dirname(new URL(import.meta.url).pathname);

let _s = 0x0a1e5eed;
function rnd() { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const pad = (n, w = 3) => String(n).padStart(w, "0");
const dateStr = (y, m, d) => `${y}-${pad(m, 2)}-${pad(d, 2)}`;
const shuffle = (a) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };

const FIRST = ["Liam","Emma","Noah","Olivia","Oliver","Ava","Elijah","Sophia","Mateo","Isabella","Lucas","Mia","Levi","Amelia","Ezra","Harper","Asher","Evelyn","James","Luna","Leo","Aria","Ethan","Ella","Mason","Gianna","Logan","Chloe","Jackson","Nora","Aiden","Riley","Sebastian","Zoey","Jack","Nova","Owen","Layla","Theo","Emilia","Kai","Sten","Ingrid","Anders","Solveig","Bjorn","Astrid","Lars","Freya","Erik","Sigrid","Malik","Priya","Diego","Zara","Omar","Lucia","Andre","Naomi","Maya"];
const LAST = ["Anderson","Johnson","Olson","Larson","Nelson","Peterson","Carlson","Hansen","Berg","Dahl","Lund","Moen","Haugen","Solberg","Kristiansen","Bakken","Sundberg","Ellingson","Kittelsen","Mohr","Smith","Williams","Garcia","Martinez","Lee","Nguyen","Patel","Kim","Okonkwo","Rossi","Cohen","Singh","Diallo","Murphy","Reyes","Torres","Walker","Young","Brooks","Hayes"];
const name = () => `${pick(FIRST)} ${pick(LAST)}`;

// ── St. Olaf residence halls & campus venues ───────────────────────────────
const HALLS = ["Ytterboe","Mohn","Kildahl","Hoyme","Ellingson","Kittelsby","Larson","Rand","Mellby","Hilleboe","Thorson","Kildahl Annex"];
const HOUSE = ["Ole House","Manitou","Agnes Mellby","St. John's","Honor House","Larson Hall","Hoyme Hall","Thompson"];
const FUN = ["Northfield Nordics","Gnashville","Um Ya Ya's","The Fellowship","Blitzen","Hot Dish Heroes","Lefse Legends","The Manitou Monsters","Cage the Elephants","Screaming Vikings","Ope Sorry","Ctrl Alt Defeat","Net Gains","Pivot!","The Replacements","Bald Spot Ballers","Larson Lightning","Regents of Order","Uff Da United","Kringla Krushers","The Norsemen","Boe Chapel Bells","Cannon River Rats","Skoglund Squad","Tostrud Titans","Cage Free Range","Blue Steel","Just Here for Snacks","Certified Ballers","Frey's Flyers"];

const SEASONS = {
  Fall:   { year: 2025, months: [9, 10] },
  Winter: { year: 2026, months: [1, 2] },
  Spring: { year: 2026, months: [4, 5] },
};

// sport → { season, venue, scoreLo, scoreHi, allowTie, unit }
const SPORTS = [
  { name: "Flag Football", season: "Fall",   venue: "Manitou Field",         lo: 0, hi: 35, tie: false },
  { name: "Soccer",        season: "Fall",   venue: "Manitou Field",         lo: 0, hi: 6,  tie: true  },
  { name: "Volleyball",    season: "Fall",   venue: "Skoglund Gym",          lo: 0, hi: 3,  tie: false },
  { name: "Basketball",    season: "Winter", venue: "Skoglund Center",       lo: 28, hi: 74, tie: false },
  { name: "Broomball",     season: "Winter", venue: "Tostrud Rink",          lo: 0, hi: 7,  tie: true  },
  { name: "Dodgeball",     season: "Winter", venue: "Skoglund Gym B",        lo: 0, hi: 5,  tie: false },
  { name: "Softball",      season: "Spring", venue: "Old Main Field",        lo: 1, hi: 17, tie: false },
  { name: "Ultimate",      season: "Spring", venue: "Manitou Field",         lo: 6, hi: 15, tie: false },
  { name: "Kickball",      season: "Spring", venue: "Tostrud Fields",        lo: 0, hi: 12, tie: false },
];

const DIVISIONS = ["Open A", "Open B", "Rec", "Competitive"];

const CMT = {
  hi: [
    "Super fun game, both teams played hard and clean. Ref was great.",
    "Great vibes on the field — this is why I do intramurals!",
    "Well organized, started on time, everyone got to play.",
    "Competitive but friendly. Loved it.",
    "Best game of the season so far, um ya ya!",
    "Refs kept it fair and the energy was awesome.",
  ],
  mid: [
    "Good game overall, though it ran a little long.",
    "Fun, but the gym was freezing at Tostrud.",
    "Decent officiating, a couple of missed calls but no big deal.",
    "Solid matchup, wish we had more subs.",
    "Fine game — scheduling at 9pm on a weeknight is rough though.",
  ],
  lo: [
    "Other team got pretty chippy, not a lot of sportsmanship.",
    "Ref didn't show up on time and calls were inconsistent.",
    "Too many no-shows, we barely had enough players.",
    "Got heated at the end, could use better officiating.",
    "Court double-booked, started 30 min late.",
  ],
};

const out = { teams: [], games: [], feedback: [] };
let tmSeq = 0, gmSeq = 0, fbSeq = 0;

function scoreFor(s) { return int(s.lo, s.hi); }

for (const sport of SPORTS) {
  const seasonMeta = SEASONS[sport.season];
  // 10 unique team names per sport
  const pool = shuffle([...HALLS.map(h => `${h} ${pick(["Vikings","Lions","Bears","Owls","Foxes"])}`), ...HOUSE, ...FUN]);
  const usedNames = new Set();
  const teams = [];
  for (let t = 0; t < 10; t++) {
    let nm; let gi = 0;
    do { nm = pool[(t + gi) % pool.length]; gi++; } while (usedNames.has(nm) && gi < pool.length * 2);
    usedNames.add(nm);
    tmSeq++;
    const captain = name();
    teams.push({
      seq: tmSeq, id: `TM-${pad(tmSeq)}`, name: nm, captain,
      email: emailOf(captain), roster: int(6, 14), division: pick(DIVISIONS),
      w: 0, l: 0, ti: 0, pf: 0, pa: 0,
    });
  }

  // ── round-robin-ish schedule: each team plays ~5-7 games ──
  const rounds = shuffle(teams);
  const pairings = [];
  for (let r = 0; r < 6; r++) {
    const order = shuffle(teams);
    for (let i = 0; i + 1 < order.length; i += 2) {
      pairings.push([order[i], order[i + 1]]);
    }
  }
  // trim to a believable schedule and de-dup exact repeat matchups a bit
  const seenPair = new Set();
  const schedule = [];
  for (const [a, b] of pairings) {
    const key = [a.seq, b.seq].sort().join("-");
    if (seenPair.has(key) && chance(0.6)) continue;
    seenPair.add(key);
    schedule.push([a, b]);
    if (schedule.length >= 26) break;
  }

  const [m0, m1] = seasonMeta.months;
  schedule.forEach(([home, away], gi) => {
    gmSeq++;
    // spread games across the two season months; ~65% completed
    const month = chance(0.5) ? m0 : m1;
    const day = int(1, 27);
    const completed = chance(0.68);
    const status = completed ? "Final" : pick(["Scheduled", "Scheduled", "Postponed"]);
    let hs = "", as = "", winner = "";
    if (completed) {
      let h = scoreFor(sport), a = scoreFor(sport);
      if (!sport.tie && h === a) { if (chance(0.5)) h++; else a = Math.max(sport.lo, a - 1); if (h === a) h++; }
      hs = String(h); as = String(a);
      home.pf += h; home.pa += a; away.pf += a; away.pa += h;
      if (h > a) { home.w++; away.l++; winner = home.name; }
      else if (a > h) { away.w++; home.l++; winner = away.name; }
      else { home.ti++; away.ti++; winner = "Tie"; }
    }
    out.games.push({
      "Game ID": `GM-${pad(gmSeq, 4)}`, "Sport": sport.name, "Season": sport.season,
      "Game Date": dateStr(seasonMeta.year, month, day),
      "Game Time": pick(["6:00 PM", "7:00 PM", "8:00 PM", "9:00 PM", "4:30 PM", "5:15 PM"]),
      "Home Team": home.name, "Away Team": away.name,
      "Home Score": hs, "Away Score": as, "Winner": winner,
      "Location": sport.venue, "Status": status,
      "Notes": status === "Postponed" ? "Rescheduled — check Fusion for new date." : "",
    });

    // ── feedback on completed games (0-2 per game) ──
    if (completed) {
      const nFb = int(0, 2);
      for (let f = 0; f < nFb; f++) {
        fbSeq++;
        const team = chance(0.5) ? home : away;
        const overall = chance(0.62) ? int(4, 5) : (chance(0.6) ? 3 : int(1, 2));
        const bucket = overall >= 4 ? "hi" : overall === 3 ? "mid" : "lo";
        out.feedback.push({
          "Feedback ID": `FB-${pad(fbSeq, 4)}`,
          "Date": dateStr(seasonMeta.year, month, Math.min(28, day + 1)),
          "Game": `${home.name} vs ${away.name}`,
          "Sport": sport.name, "Season": sport.season, "Team": team.name,
          "Submitted By": name(), "Role": pick(["Player", "Player", "Player", "Captain", "Referee"]),
          "Overall Rating": String(overall),
          "Sportsmanship Rating": String(clamp(overall + int(-1, 1))),
          "Officiating Rating": String(clamp(overall + int(-2, 1))),
          "Would Play Again": overall >= 3 ? "Yes" : "No",
          "Comment": pick(CMT[bucket]),
          "Status": pick(["New", "Reviewed", "Reviewed", "Resolved"]),
        });
      }
    }
  });

  // ── emit teams with tallied standings ──
  for (const t of teams) {
    out.teams.push({
      "Team ID": t.id, "Team Name": t.name, "Sport": sport.name, "Season": sport.season,
      "Division": t.division, "Captain": t.captain, "Captain Email": t.email,
      "Roster Size": String(t.roster),
      "Wins": String(t.w), "Losses": String(t.l), "Ties": String(t.ti),
      "Points For": String(t.pf), "Points Against": String(t.pa),
      "Home Venue": sport.venue,
      "Status": chance(0.94) ? "Active" : "Withdrawn",
      "Notes": "",
    });
  }
}

function clamp(n) { return Math.max(1, Math.min(5, n)); }
function emailOf(n) { return n.toLowerCase().replace(/[^a-z]+/g, "") + int(20, 26) + "@stolaf.edu"; }

fs.writeFileSync(path.join(DIR, "seed-data.json"), JSON.stringify(out, null, 2));
console.log("Wrote seed-data.json:", JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]))));
