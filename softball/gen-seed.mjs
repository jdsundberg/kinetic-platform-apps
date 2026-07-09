/**
 * gen-seed.mjs — generate realistic seed-data.json for Grand Slam Softball.
 * Deterministic (seeded PRNG) so re-runs are stable. Pure Node built-ins.
 *
 *   node gen-seed.mjs   →  writes seed-data.json
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);

// ── deterministic PRNG (mulberry32) ──────────────────────────────────────
let _s = 0x9e3779b9;
function rnd() { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const pad = (n, w = 4) => String(n).padStart(w, "0");
function dateStr(y, m, d) { return `${y}-${pad(m, 2)}-${pad(d, 2)}`; }

// ── reference data ────────────────────────────────────────────────────────
const FIRST = ["James","Mary","Robert","Patricia","John","Jennifer","Michael","Linda","David","Elizabeth","William","Barbara","Richard","Susan","Joseph","Jessica","Thomas","Sarah","Chris","Karen","Daniel","Nancy","Matthew","Lisa","Anthony","Betty","Mark","Sandra","Donald","Ashley","Steven","Kimberly","Paul","Emily","Andrew","Donna","Josh","Michelle","Kevin","Carol","Brian","Amanda","George","Melissa","Ed","Deborah","Ron","Stephanie","Tim","Rebecca","Jason","Laura","Jeff","Sharon","Ryan","Cynthia","Jacob","Kathleen","Gary","Amy","Nick","Angela","Eric","Shirley","Jon","Anna","Carlos","Maria","Luis","Diana","Tyler","Hannah","Aaron","Olivia","Jose","Sofia"];
const LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Perez","Thompson","White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson","Walker","Young","Allen","King","Wright","Scott","Torres","Nguyen","Hill","Flores","Green","Adams","Nelson","Baker","Hall","Rivera","Campbell","Mitchell","Carter","Roberts"];
const name = () => `${pick(FIRST)} ${pick(LAST)}`;

const POSITIONS = ["Pitcher","Catcher","First Base","Second Base","Third Base","Shortstop","Left Field","Center Field","Right Field","Utility","Designated Player"];
const HAND = ["Right","Right","Right","Left","Switch"];

// Four sub-leagues (divisions)
const LEAGUES = [
  { id: "LG-0001", name: "National Fastpitch League", division: "Fastpitch", region: "Midwest", age: "18U / Open Women", founded: 2003, ageGroups: ["16U","18U","Open"], city: ["Chicago","Detroit","Columbus","Indianapolis","Milwaukee","Minneapolis","Kansas City","St. Louis"], state: ["IL","MI","OH","IN","WI","MN","MO","MO"] },
  { id: "LG-0002", name: "Recreational Slowpitch League", division: "Slowpitch", region: "Southeast", age: "Adult Coed", founded: 1998, ageGroups: ["Open"], city: ["Atlanta","Charlotte","Nashville","Orlando","Tampa","Raleigh","Memphis","Jacksonville"], state: ["GA","NC","TN","FL","FL","NC","TN","FL"] },
  { id: "LG-0003", name: "Youth Development League", division: "Youth", region: "West", age: "10U - 14U", founded: 2011, ageGroups: ["10U","12U","14U"], city: ["Los Angeles","San Diego","Phoenix","Sacramento","Las Vegas","Portland","Seattle","Denver"], state: ["CA","CA","AZ","CA","NV","OR","WA","CO"] },
  { id: "LG-0004", name: "Senior Masters League", division: "Senior", region: "Northeast", age: "50+ / 60+", founded: 2007, ageGroups: ["50+","60+"], city: ["Boston","New York","Philadelphia","Pittsburgh","Buffalo","Hartford","Providence","Newark"], state: ["MA","NY","PA","PA","NY","CT","RI","NJ"] },
];

const TEAM_ADJ = ["Thunder","Blaze","Storm","Sluggers","Aces","Rebels","Titans","Cyclones","Riptide","Outlaws","Bandits","Diamonds","Force","Heat","Renegades","Warriors","Crush","Fury","Rockets","Mavericks","Sharks","Wolves","Bulls","Hawks","Comets"];
const TEAM_PREFIX = ["North","South","East","West","Metro","River","Valley","Lake","Summit","Capital","Coastal","Prairie","Harbor","Ridge","Grand"];
const FIELDS = ["Memorial Park Field","Riverside Diamond","Veterans Complex","Lincoln Park #3","Community Sports Park","Eagle Ridge Fields","Legion Field","Municipal Diamond A","Optimist Park","Heritage Ballfields"];
const CERTS = ["ASA/USA Certified","NFHS Certified","Level 1","Level 2","Level 3","None"];
const BGCHECK = ["Cleared","Cleared","Cleared","Pending","Expired"];
const UMPIRES = () => name();

const out = { leagues: [], teams: [], coaches: [], players: [], schedules: [], feedback: [], finances: [] };

// team registry keyed by league for scheduling / assignment
const teamsByLeague = {};

let teamSeq = 0, coachSeq = 0, playerSeq = 0, gameSeq = 0, fbSeq = 0, txSeq = 0;

for (const lg of LEAGUES) {
  teamsByLeague[lg.name] = [];
  const teamCount = 6; // 6 teams per league → 24 teams total
  const usedNames = new Set();

  for (let t = 0; t < teamCount; t++) {
    let tn; do { tn = `${pick(TEAM_PREFIX)} ${pick(TEAM_ADJ)}`; } while (usedNames.has(tn));
    usedNames.add(tn);
    const ci = t % lg.city.length;
    const city = lg.city[ci], state = lg.state[ci];
    const field = pick(FIELDS);
    const headCoach = name();
    const wins = int(2, 14), losses = int(2, 14), ties = chance(0.2) ? int(1, 2) : 0;
    const roster = int(11, 15);
    teamSeq++;
    const teamId = `TM-${pad(teamSeq)}`;
    const teamRec = { id: teamId, name: tn, city, state, field, headCoach, league: lg.name };
    teamsByLeague[lg.name].push(teamRec);
    out.teams.push({
      "Team ID": teamId, "Team Name": tn, "League": lg.name, "City": city, "State": state,
      "Head Coach": headCoach, "Home Field": field, "Wins": String(wins), "Losses": String(losses),
      "Ties": String(ties), "Roster Size": String(roster), "Founded Year": String(int(lg.founded, 2022)),
      "Status": chance(0.9) ? "Active" : "Provisional",
      "Notes": "",
    });

    // coaches: 1 head + 1-2 assistants
    coachSeq++;
    out.coaches.push({
      "Coach ID": `CO-${pad(coachSeq)}`, "Name": headCoach, "Email": emailOf(headCoach), "Phone": phone(),
      "League": lg.name, "Team": tn, "Role": "Head Coach", "Certification": pick(["ASA/USA Certified","NFHS Certified","Level 2","Level 3"]),
      "Years Experience": String(int(3, 22)), "Background Check": pick(BGCHECK), "Status": "Active", "Notes": "",
    });
    const asstCount = int(1, 2);
    const asstRoles = ["Assistant Coach","Pitching Coach","Hitting Coach","Bench Coach"];
    for (let a = 0; a < asstCount; a++) {
      coachSeq++;
      const cn = name();
      out.coaches.push({
        "Coach ID": `CO-${pad(coachSeq)}`, "Name": cn, "Email": emailOf(cn), "Phone": phone(),
        "League": lg.name, "Team": tn, "Role": pick(asstRoles), "Certification": pick(CERTS),
        "Years Experience": String(int(1, 15)), "Background Check": pick(BGCHECK),
        "Status": chance(0.92) ? "Active" : "Provisional", "Notes": "",
      });
    }

    // players
    for (let p = 0; p < roster; p++) {
      playerSeq++;
      const pn = name();
      const paid = chance(0.85);
      out.players.push({
        "Player ID": `PL-${pad(playerSeq, 5)}`, "Name": pn, "Email": emailOf(pn), "Phone": phone(),
        "League": lg.name, "Team": tn, "Position": POSITIONS[p % POSITIONS.length],
        "Jersey Number": String(int(1, 55)), "Bats": pick(HAND), "Throws": pick(HAND),
        "Age Group": pick(lg.ageGroups), "Batting Avg": (0.180 + rnd() * 0.320).toFixed(3).slice(1),
        "Home Runs": String(int(0, 18)), "RBIs": String(int(2, 45)),
        "Registration Paid": paid ? "Yes" : "No",
        "Status": chance(0.9) ? "Active" : (chance(0.5) ? "Injured" : "Inactive"), "Notes": "",
      });
    }
  }

  // league summary row
  const lgTeams = teamsByLeague[lg.name];
  const lgPlayerCount = out.players.filter(p => p["League"] === lg.name).length;
  out.leagues.push({
    "League ID": lg.id, "League Name": lg.name, "Division": lg.division, "Region": lg.region,
    "Commissioner": name(), "Commissioner Email": `commissioner@${slug(lg.name)}.org`,
    "Season": "2026 Summer", "Founded Year": String(lg.founded),
    "Team Count": String(lgTeams.length), "Player Count": String(lgPlayerCount),
    "Age Range": lg.age, "Status": "Active",
    "Notes": `${lg.division} division · ${lg.region} region.`,
  });
}

// ── schedule: round-robin-ish per league across weeks ─────────────────────
const MONTHS = [[2026, 5], [2026, 6], [2026, 7], [2026, 8]]; // May-Aug 2026
for (const lg of LEAGUES) {
  const teams = teamsByLeague[lg.name];
  let week = 0;
  // generate ~ each team plays ~10 games
  for (let round = 0; round < 8; round++) {
    week++;
    // pair teams: rotate
    const order = teams.slice();
    for (let i = 0; i < Math.floor(order.length / 2); i++) {
      const home = order[i], away = order[order.length - 1 - i];
      if (!home || !away || home.name === away.name) continue;
      gameSeq++;
      const [yy, mm] = MONTHS[Math.min(MONTHS.length - 1, Math.floor(round / 2))];
      const day = int(1, 27);
      const gd = dateStr(yy, mm, day);
      // decide status by date relative to "today" 2026-07-01
      const past = (yy < 2026) || (mm < 7) || (mm === 7 && day < 1);
      let status, hs = "", as = "";
      if (past) {
        if (chance(0.08)) { status = "Postponed"; }
        else if (chance(0.03)) { status = "Forfeit"; hs = "7"; as = "0"; }
        else { status = "Final"; hs = String(int(0, 15)); as = String(int(0, 15)); if (hs === as) hs = String(Number(hs) + 1); }
      } else {
        status = chance(0.05) ? "Postponed" : "Scheduled";
      }
      txSeqNoop();
      out.schedules.push({
        "Game ID": `GM-${pad(gameSeq, 5)}`, "League": lg.name, "Game Date": gd,
        "Game Time": pick(["9:00 AM","10:30 AM","1:00 PM","3:30 PM","6:00 PM","7:30 PM"]),
        "Week": String(week), "Home Team": home.name, "Away Team": away.name,
        "Field": home.field, "City": home.city, "Umpire": UMPIRES(),
        "Home Score": hs, "Away Score": as, "Status": status, "Notes": "",
      });
    }
    // rotate for next round (keep first fixed)
    teams.splice(1, 0, teams.pop());
  }
}
function txSeqNoop() {}

// ── feedback ──────────────────────────────────────────────────────────────
const FB_CATS = ["Officiating","Facilities","Scheduling","Coaching","Communication","Registration","Safety"];
const FB_ROLES = ["Player","Coach","Parent","Umpire","Volunteer","Spectator"];
const FB_STATUS = ["New","Reviewed","Responded","Follow Up Needed","Resolved"];
const COMMENTS = {
  high: ["Great season so far — well organized and the umpires are top notch.","Fields are always in great shape. Kids love it.","Registration was smooth and communication has been excellent.","Coaches are fantastic and really develop the players.","Best run league we've been part of. Keep it up!"],
  mid: ["Overall good, but game start times slip fairly often.","Facilities are decent, could use better dugout shade.","Scheduling conflicts with other divisions a couple times.","Umpiring is inconsistent between crews.","Would like more communication about rain-outs."],
  low: ["Several games postponed with little notice — frustrating.","Registration fees went up but I don't see the added value.","Field conditions were unsafe after the storm.","Officiating errors decided a couple of our games.","Hard to reach anyone when we have a question."],
};
const fbCount = 90;
for (let i = 0; i < fbCount; i++) {
  fbSeq++;
  const lg = pick(LEAGUES);
  const team = pick(teamsByLeague[lg.name]);
  const rating = chance(0.55) ? int(4, 5) : (chance(0.6) ? 3 : int(1, 2));
  const bucket = rating >= 4 ? "high" : rating === 3 ? "mid" : "low";
  const mm = int(5, 7), day = int(1, 28);
  out.feedback.push({
    "Feedback ID": `FB-${pad(fbSeq)}`, "Date": dateStr(2026, mm, day), "League": lg.name, "Team": team.name,
    "Submitted By": name(), "Role": pick(FB_ROLES), "Category": pick(FB_CATS),
    "Rating": String(rating), "Would Recommend": rating >= 3 ? "Yes" : "No",
    "Comments": pick(COMMENTS[bucket]), "Response": chance(0.3) ? "Thanks for the feedback — we're on it." : "",
    "Status": pick(FB_STATUS),
  });
}

// ── finances ──────────────────────────────────────────────────────────────
const INC_CATS = ["Registration","Sponsorship","Concessions","Merchandise","Grants","Donations","Tournament Fees"];
const EXP_CATS = ["Field Rental","Umpire Fees","Equipment","Uniforms","Insurance","Awards","Travel","Marketing","Administration"];
const PAY = ["Credit Card","Check","ACH Transfer","Cash","Online","Invoice"];
const FIN_STATUS_PAID = ["Paid","Cleared"];
const VENDORS = ["Rawlings Team Sales","City Parks Dept","Elite Umpire Assoc","Champion Trophies","Coca-Cola Bottling","ProShade Dugouts","National Youth Sports Ins","BSN Sports","Diamond Pro Supply","Local Print & Signs"];
function finTx(type, lg) {
  txSeq++;
  const cat = type === "Income" ? pick(INC_CATS) : pick(EXP_CATS);
  const base = type === "Income"
    ? (cat === "Sponsorship" ? int(1500, 8000) : cat === "Grants" ? int(2000, 12000) : cat === "Registration" ? int(400, 3500) : int(150, 1800))
    : (cat === "Field Rental" ? int(800, 5000) : cat === "Insurance" ? int(1200, 6000) : cat === "Umpire Fees" ? int(300, 2200) : int(120, 2500));
  const mm = int(3, 7), day = int(1, 28);
  const overdue = type === "Income" && chance(0.12);
  const pending = chance(0.15);
  out.finances.push({
    "Transaction ID": `TX-${pad(txSeq, 5)}`, "Date": dateStr(2026, mm, day), "League": lg.name,
    "Team": chance(0.4) ? pick(teamsByLeague[lg.name]).name : "",
    "Type": type, "Category": cat, "Amount": String(base),
    "Description": `${cat} — ${lg.division} division`,
    "Payment Method": pick(PAY), "Vendor": type === "Expense" ? pick(VENDORS) : "",
    "Status": overdue ? "Overdue" : pending ? "Pending" : pick(FIN_STATUS_PAID),
    "Notes": "",
  });
}
for (const lg of LEAGUES) {
  for (let i = 0; i < 22; i++) finTx("Income", lg);
  for (let i = 0; i < 16; i++) finTx("Expense", lg);
}

// ── helpers ────────────────────────────────────────────────────────────────
function emailOf(n) { return n.toLowerCase().replace(/[^a-z]+/g, ".") + "@example.com"; }
function phone() { return `(${int(200, 989)}) ${int(200, 989)}-${pad(int(0, 9999), 4)}`; }
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18); }

// ── write ──────────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(DIR, "seed-data.json"), JSON.stringify(out, null, 2));
const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
console.log("Wrote seed-data.json:", JSON.stringify(counts));
