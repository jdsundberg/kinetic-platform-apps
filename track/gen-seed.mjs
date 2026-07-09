/**
 * gen-seed.mjs — realistic seed-data.json for Junior Track & Field (all 50 states).
 * Deterministic PRNG. Pure Node built-ins.
 *   node gen-seed.mjs   →  writes seed-data.json
 */
import fs from "node:fs";
import path from "node:path";
const DIR = path.dirname(new URL(import.meta.url).pathname);

let _s = 0x51ce55ed;
function rnd() { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const pad = (n, w = 4) => String(n).padStart(w, "0");
const dateStr = (y, m, d) => `${y}-${pad(m, 2)}-${pad(d, 2)}`;

const FIRST = ["Liam","Emma","Noah","Olivia","Oliver","Ava","Elijah","Sophia","Mateo","Isabella","Lucas","Mia","Levi","Amelia","Ezra","Harper","Asher","Evelyn","James","Luna","Leo","Aria","Ethan","Ella","Mason","Gianna","Logan","Chloe","Jackson","Nora","Aiden","Riley","Sebastian","Zoey","Jack","Nova","Owen","Layla","Theo","Emilia","Kai","Aurora","Miles","Hazel","Isaiah","Willow","Eli","Scarlett","Nate","Grace","Malik","Priya","Diego","Zara","Omar","Lucia","Andre","Naomi","Cyrus","Maya"];
const LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Perez","Thompson","White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson","Walker","Young","Allen","King","Wright","Scott","Torres","Nguyen","Hill","Flores","Patel","Kim","Nakamura","Okonkwo","Ivanov","Rossi","Cohen","Singh","Diallo","Murphy"];
const name = () => `${pick(FIRST)} ${pick(LAST)}`;

const STATES = [
  ["Alabama","AL","Southeast"],["Alaska","AK","West"],["Arizona","AZ","Southwest"],["Arkansas","AR","Southeast"],["California","CA","West"],
  ["Colorado","CO","West"],["Connecticut","CT","Northeast"],["Delaware","DE","Northeast"],["Florida","FL","Southeast"],["Georgia","GA","Southeast"],
  ["Hawaii","HI","West"],["Idaho","ID","West"],["Illinois","IL","Midwest"],["Indiana","IN","Midwest"],["Iowa","IA","Midwest"],
  ["Kansas","KS","Midwest"],["Kentucky","KY","Southeast"],["Louisiana","LA","Southeast"],["Maine","ME","Northeast"],["Maryland","MD","Northeast"],
  ["Massachusetts","MA","Northeast"],["Michigan","MI","Midwest"],["Minnesota","MN","Midwest"],["Mississippi","MS","Southeast"],["Missouri","MO","Midwest"],
  ["Montana","MT","West"],["Nebraska","NE","Midwest"],["Nevada","NV","West"],["New Hampshire","NH","Northeast"],["New Jersey","NJ","Northeast"],
  ["New Mexico","NM","Southwest"],["New York","NY","Northeast"],["North Carolina","NC","Southeast"],["North Dakota","ND","Midwest"],["Ohio","OH","Midwest"],
  ["Oklahoma","OK","Southwest"],["Oregon","OR","West"],["Pennsylvania","PA","Northeast"],["Rhode Island","RI","Northeast"],["South Carolina","SC","Southeast"],
  ["South Dakota","SD","Midwest"],["Tennessee","TN","Southeast"],["Texas","TX","Southwest"],["Utah","UT","West"],["Vermont","VT","Northeast"],
  ["Virginia","VA","Southeast"],["Washington","WA","West"],["West Virginia","WV","Southeast"],["Wisconsin","WI","Midwest"],["Wyoming","WY","West"],
];
const CITY = { Northeast: ["Boston","Portland","Hartford","Providence","Albany","Buffalo","Newark","Trenton","Concord","Dover"], Southeast: ["Atlanta","Charlotte","Nashville","Memphis","Orlando","Tampa","Richmond","Raleigh","Birmingham","Louisville"], Midwest: ["Chicago","Detroit","Columbus","Indianapolis","Milwaukee","Minneapolis","Des Moines","Omaha","Kansas City","Fargo"], Southwest: ["Phoenix","Austin","Dallas","Houston","Albuquerque","Tucson","Oklahoma City","El Paso","Santa Fe","San Antonio"], West: ["Los Angeles","San Diego","Denver","Seattle","Portland","Sacramento","Las Vegas","Boise","Salt Lake City","Honolulu"] };
const TEAM_NOUN = ["Cheetahs","Comets","Flyers","Roadrunners","Lightning","Rockets","Falcons","Jaguars","Blazers","Strikers","Thunder","Aces","Eagles","Hawks","Tigers","Panthers","Sharks","Wolves","Bolts","Stars","Storm","Cyclones","Mustangs","Gators","Rangers"];
const TEAM_PRE = ["North","South","East","West","Central","Valley","Lake","River","Summit","Metro","Prairie","Harbor","Ridge","Capital","Sunrise"];

const GRADES = ["K","1","2","3","4","5","6"];
const EVENTS_TRACK = ["50m Dash","100m Dash","200m Dash","400m Run","800m Run","1600m Run","4x100m Relay"];
const EVENTS_FIELD = ["Long Jump","Standing Long Jump","High Jump","Softball Throw","Turbo Javelin","Shot Put"];
// baseline mark by event for grade 3 girls; scaled by grade & gender
const BASE = {
  "50m Dash": 9.8, "100m Dash": 17.5, "200m Dash": 37.0, "400m Run": 88.0, "800m Run": 200.0, "1600m Run": 430.0, "4x100m Relay": 68.0,
  "Long Jump": 2.4, "Standing Long Jump": 1.5, "High Jump": 0.95, "Softball Throw": 18.0, "Turbo Javelin": 12.0, "Shot Put": 4.5,
};
const gradeIdx = (g) => g === "K" ? 0 : parseInt(g);
// track: higher grade & boys → faster (lower); field: higher grade & boys → farther (higher)
function markFor(event, grade, gender) {
  const gi = gradeIdx(grade); const isField = EVENTS_FIELD.includes(event);
  const base = BASE[event];
  const gradeFactor = isField ? (1 + gi * 0.11) : (1 - gi * 0.045);
  const genderFactor = gender === "Boys" ? (isField ? 1.06 : 0.97) : 1.0;
  const noise = 0.9 + rnd() * 0.24;
  let val = base * gradeFactor * genderFactor * noise;
  const dec = event.includes("Run") && base > 60 ? 1 : 2;
  return val.toFixed(dec);
}
const unitFor = (event) => EVENTS_TRACK.includes(event) ? "sec" : "m";

const out = { leagues: [], teams: [], coaches: [], athletes: [], meets: [], results: [], feedback: [] };
const teamsByState = {}, athletesByState = {};
let tmSeq = 0, coSeq = 0, atSeq = 0, meSeq = 0, reSeq = 0, fbSeq = 0, lgSeq = 0;

for (const [state, code, region] of STATES) {
  lgSeq++;
  teamsByState[state] = []; athletesByState[state] = [];
  const cities = CITY[region];
  const teamCount = int(2, 3);
  const usedT = new Set();
  for (let t = 0; t < teamCount; t++) {
    tmSeq++;
    let tn; do { tn = `${pick(TEAM_PRE)} ${pick(TEAM_NOUN)}`; } while (usedT.has(tn));
    usedT.add(tn);
    const city = pick(cities);
    const headCoach = name();
    const division = pick(["Coed", "Coed", "Boys", "Girls"]);
    const rec = { id: `TM-${pad(tmSeq)}`, name: tn, city, coach: headCoach, division };
    teamsByState[state].push(rec);
    // athletes for team
    const roster = int(6, 11);
    for (let a = 0; a < roster; a++) {
      atSeq++;
      const gender = division === "Boys" ? "Boys" : division === "Girls" ? "Girls" : pick(["Boys", "Girls"]);
      const grade = pick(GRADES);
      const primary = pick([...EVENTS_TRACK, ...EVENTS_FIELD]);
      const arec = { id: `AT-${pad(atSeq, 5)}`, name: name(), gender, grade, team: tn, primary };
      athletesByState[state].push(arec);
      out.athletes.push({
        "Athlete ID": arec.id, "Name": arec.name, "State": state, "Team": tn,
        "Gender": gender, "Grade": grade, "Age": String(5 + gradeIdx(grade) + int(0, 1)),
        "Bib Number": String(int(1, 899)), "Primary Event": primary, "Guardian": name(),
        "Registration Paid": chance(0.86) ? "Yes" : "No",
        "Status": chance(0.9) ? "Active" : (chance(0.5) ? "Injured" : "Inactive"), "Notes": "",
      });
    }
    out.teams.push({
      "Team ID": rec.id, "Team Name": tn, "State": state, "City": city, "Head Coach": headCoach,
      "Division": division, "Grade Range": pick(["K-6", "K-2", "3-4", "5-6"]),
      "Athlete Count": String(roster), "Home Track": `${city} ${pick(["Elementary", "Community", "Memorial", "Central"])} Track`,
      "Status": chance(0.92) ? "Active" : "Provisional", "Notes": "",
    });
    // coaches: head + 0-2 assistants
    coSeq++;
    out.coaches.push({ "Coach ID": `CO-${pad(coSeq)}`, "Name": headCoach, "Email": emailOf(headCoach), "Phone": phone(),
      "State": state, "Team": tn, "Role": "Head Coach", "Certification": pick(["USATF Level 1", "USATF Level 2", "SafeSport Certified"]),
      "Background Check": pick(["Cleared", "Cleared", "Cleared", "Pending"]), "Years Experience": String(int(2, 20)), "Status": "Active", "Notes": "" });
    for (let c = 0; c < int(0, 2); c++) {
      coSeq++; const cn = name();
      out.coaches.push({ "Coach ID": `CO-${pad(coSeq)}`, "Name": cn, "Email": emailOf(cn), "Phone": phone(),
        "State": state, "Team": tn, "Role": pick(["Assistant Coach", "Sprints Coach", "Distance Coach", "Field Events Coach", "Volunteer"]),
        "Certification": pick(["USATF Level 1", "SafeSport Certified", "First Aid/CPR", "None"]),
        "Background Check": pick(["Cleared", "Cleared", "Pending", "Not Started"]), "Years Experience": String(int(1, 12)),
        "Status": chance(0.9) ? "Active" : "Provisional", "Notes": "" });
    }
  }
  out.leagues.push({
    "League ID": `LG-${pad(lgSeq)}`, "State": state, "State Code": code,
    "League Name": `${state} Youth Track & Field League`, "Region": region,
    "Director": name(), "Director Email": `director@${code.toLowerCase()}youthtf.org`,
    "Season": "2026 Spring", "Team Count": String(teamsByState[state].length),
    "Athlete Count": String(athletesByState[state].length), "Status": chance(0.94) ? "Active" : "Planned",
    "Notes": `${region} region · serves K–6 boys & girls.`,
  });
}

// ── meets (schedule) + results ────────────────────────────────────────────
const MEET_TYPE = ["Spring Opener", "All-Comers Meet", "Regional Qualifier", "Invitational", "League Championship", "Developmental Meet", "Twilight Meet"];
for (const [state, code, region] of STATES) {
  const teams = teamsByState[state]; const athletes = athletesByState[state].filter(a => true);
  const nMeets = int(1, 2);
  for (let m = 0; m < nMeets; m++) {
    meSeq++;
    const host = pick(teams);
    const mm = int(3, 6), day = int(1, 28);
    const past = mm < 5 || (mm === 5 && day < 15);
    const status = past ? "Completed" : pick(["Scheduled", "Scheduled", "Registration Open"]);
    const meetName = `${state} ${pick(MEET_TYPE)}`;
    out.meets.push({
      "Meet ID": `ME-${pad(meSeq)}`, "Meet Name": meetName, "State": state, "Meet Date": dateStr(2026, mm, day),
      "Start Time": pick(["8:00 AM", "9:00 AM", "10:00 AM", "4:00 PM", "5:00 PM"]), "Location": `${host.city} Athletic Complex`,
      "Host Team": host.name, "Divisions": "Boys & Girls", "Grade Range": "K-6", "Status": status,
      "Notes": past ? "" : "Register by the Friday before.",
    });
    // results only for completed meets
    if (status !== "Completed") continue;
    const participants = athletes.filter(a => a.grade).sort(() => rnd() - 0.5).slice(0, int(8, 16));
    for (const a of participants) {
      // each athlete does 1-2 events (primary + maybe one more)
      const evs = [a.primary]; if (chance(0.5)) evs.push(pick([...EVENTS_TRACK, ...EVENTS_FIELD]));
      [...new Set(evs)].forEach((event, idx) => {
        reSeq++;
        const mark = markFor(event, a.grade, a.gender);
        out.results.push({
          "Result ID": `RE-${pad(reSeq, 5)}`, "Meet": meetName, "State": state, "Team": a.team, "Athlete": a.name,
          "Event": event, "Event Type": EVENTS_TRACK.includes(event) ? "Track" : "Field",
          "Gender": a.gender, "Grade": a.grade, "Mark": mark, "Unit": unitFor(event),
          "Place": String(int(1, 8)), "Personal Best": chance(0.28) ? "Yes" : "No", "Date": dateStr(2026, mm, day),
        });
      });
    }
  }
}

// ── feedback ──────────────────────────────────────────────────────────────
const FB_CATS = ["Coaching", "Officiating", "Facilities", "Scheduling", "Communication", "Safety", "Registration", "Sportsmanship"];
const FB_ROLES = ["Parent", "Parent", "Parent", "Coach", "Athlete", "Official", "Volunteer"];
const FB_STATUS = ["New", "Reviewed", "Responded", "Follow Up Needed", "Resolved"];
const CMT = {
  hi: ["Wonderful program — my kid can't wait for practice every week.", "Coaches are patient and encouraging with the little ones.", "So well organized, meets run right on time.", "Great intro to track for K–6, very inclusive.", "Loved the ribbons for every finisher!"],
  mid: ["Good overall, but parking at meets is rough.", "Fun season, wish there were more heats for the younger grades.", "Communication about schedule changes could be quicker.", "Decent facilities, restrooms need attention.", "Nice coaches, sometimes practices feel a bit large."],
  lo: ["Meet was delayed over an hour with no updates.", "Registration site was confusing and glitchy.", "Felt like the younger kids got less attention.", "Not enough officials, results took forever.", "Safety concern: no shade or water at the last meet."],
};
for (let i = 0; i < 130; i++) {
  fbSeq++;
  const [state] = pick(STATES);
  const team = pick(teamsByState[state]);
  const rating = chance(0.6) ? int(4, 5) : (chance(0.6) ? 3 : int(1, 2));
  const bucket = rating >= 4 ? "hi" : rating === 3 ? "mid" : "lo";
  out.feedback.push({
    "Feedback ID": `FB-${pad(fbSeq)}`, "Date": dateStr(2026, int(3, 6), int(1, 28)), "State": state, "Team": team.name,
    "Submitted By": name(), "Role": pick(FB_ROLES), "Category": pick(FB_CATS), "Rating": String(rating),
    "Would Recommend": rating >= 3 ? "Yes" : "No", "Comment": pick(CMT[bucket]),
    "Response": chance(0.3) ? "Thank you — we're following up with the coordinator." : "", "Status": pick(FB_STATUS),
  });
}

function emailOf(n) { return n.toLowerCase().replace(/[^a-z]+/g, ".") + "@example.com"; }
function phone() { return `(${int(200, 989)}) ${int(200, 989)}-${pad(int(0, 9999), 4)}`; }

fs.writeFileSync(path.join(DIR, "seed-data.json"), JSON.stringify(out, null, 2));
console.log("Wrote seed-data.json:", JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]))));
