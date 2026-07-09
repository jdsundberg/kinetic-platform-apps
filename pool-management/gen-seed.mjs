/**
 * Generate seed-data.json for Pool Management.
 *   10 employees · 500 customers · 500 pools · ~300 service visits · ~400 water tests
 * Deterministic (seeded PRNG) so cross-references stay stable across runs.
 * Usage: node gen-seed.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dir = path.dirname(fileURLToPath(import.meta.url));

// ── seeded PRNG (mulberry32) ──
let _s = 0x9e3779b9;
function rnd() { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = a => a[Math.floor(rnd() * a.length)];
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pad = (n, w) => String(n).padStart(w, "0");

const FIRST = ["James","Mary","Robert","Patricia","John","Jennifer","Michael","Linda","David","Elizabeth","William","Barbara","Richard","Susan","Joseph","Jessica","Thomas","Sarah","Charles","Karen","Christopher","Nancy","Daniel","Lisa","Matthew","Betty","Anthony","Margaret","Mark","Sandra","Donald","Ashley","Steven","Kimberly","Paul","Emily","Andrew","Donna","Joshua","Michelle","Erik","Greta","Sven","Astrid","Lars","Ingrid","Nils","Freya","Bjorn","Sofia"];
const LAST = ["Anderson","Johnson","Olson","Peterson","Nelson","Carlson","Larson","Hansen","Erickson","Swanson","Lindgren","Berg","Holm","Dahl","Sorensen","Lund","Moe","Aasen","Hagen","Bakken","Smith","Brown","Miller","Davis","Wilson","Moore","Taylor","Thomas","Jackson","White","Martin","Lee","Walker","Hall","Young","King","Wright","Lopez","Hill","Green"];
const CITIES = ["Minneapolis","St. Paul","Bloomington","Rochester","Duluth","Edina","Plymouth","Maple Grove","Woodbury","Eagan","Eden Prairie","Minnetonka","Burnsville","Lakeville","Apple Valley","Wayzata","Stillwater","Chanhassen","Shakopee","Roseville"];
const STREETS = ["Oak","Maple","Birch","Cedar","Pine","Elm","Lake","River","Hillside","Sunset","Lakeview","Forest","Meadow","Willow","Spruce","Aspen","Linden","Summit","Park","Prairie"];
const SUFFIX = ["St","Ave","Dr","Ln","Rd","Ct","Way","Blvd","Trail","Cir"];
const ZIPS = ["55401","55102","55420","55901","55802","55435","55447","55369","55125","55121","55344","55345","55337","55044","55124","55391","55082","55317","55379","55113"];
const ROLES = ["Cleaning Tech","Repair Tech","Chemical Tech","Service Manager"];
const POOL_TYPES = ["In-Ground","Above-Ground"];
const SURFACES = ["Vinyl","Gunite/Concrete","Fiberglass"];
const HEATERS = ["Hayward","Pentair","Raypak","Jandy","Sta-Rite","None"];
const HEATER_MODELS = { Hayward:["Universal H-Series","HeatPro HP21404T"], Pentair:["MasterTemp 400","UltraTemp 120"], Raypak:["Digital 406A","Avia 824"], Jandy:["JXi 400N","Hi-E2"], "Sta-Rite":["Max-E-Therm 333","SR400NA"], None:[""] };
const POOL_STATUS = ["Active","Active","Active","Winterized","Needs Repair","Inactive"];
const SVC_TYPES = ["Cleaning","Repair","Opening","Closing","Chemical Treatment","Inspection"];
const SVC_STATUS = ["Completed","Completed","Completed","Scheduled","In Progress","Cancelled"];
const CUST_STATUS = ["Active","Active","Active","Active","Inactive"];

function name() { return pick(FIRST) + " " + pick(LAST); }
function addr() { return ri(100, 9999) + " " + pick(STREETS) + " " + pick(SUFFIX); }
function dateIn(y, m0, m1) { return `${y}-${pad(ri(m0, m1), 2)}-${pad(ri(1, 28), 2)}`; }

// ── employees (10) ──
const employees = [];
const empNames = [];
for (let i = 1; i <= 10; i++) {
  const n = name();
  empNames.push(n);
  const role = i === 1 ? "Service Manager" : (i <= 5 ? "Cleaning Tech" : (i <= 8 ? "Repair Tech" : "Chemical Tech"));
  employees.push({
    "Employee Id": "E-" + pad(i, 3), Name: n, Role: role,
    Email: n.toLowerCase().replace(/[^a-z]+/g, ".") + "@northstarpools.com",
    Phone: `612-555-${pad(ri(1000, 9999), 4)}`, City: pick(CITIES),
    Status: i === 10 ? "Active" : "Active", "Hire Date": dateIn(ri(2016, 2024), 1, 12),
    Certifications: pick(["CPO Certified","AFO Certified","CPO, Heater Repair","Chemical Handling","CPO, Vinyl Liner"]),
  });
}
const techNames = empNames; // any employee can be assigned

// ── customers (500) + pools (500, one per customer) ──
const customers = [], pools = [];
for (let i = 1; i <= 500; i++) {
  const cid = "C-" + pad(i, 5);
  const cname = name();
  const city = pick(CITIES);
  const cidx = CITIES.indexOf(city);
  customers.push({
    "Customer Id": cid, Name: cname,
    Email: cname.toLowerCase().replace(/[^a-z]+/g, ".") + ri(1, 99) + "@example.com",
    Phone: `${pick(["612","651","952","763","507","218"])}-555-${pad(ri(1000, 9999), 4)}`,
    Address: addr(), City: city, State: "MN", Zip: ZIPS[cidx] || "55401",
    Status: pick(CUST_STATUS), "Customer Since": dateIn(ri(2012, 2025), 1, 12),
  });
  const heater = pick(HEATERS);
  const ptype = pick(POOL_TYPES);
  pools.push({
    "Pool Id": "P-" + pad(i, 5), "Customer Id": cid, "Customer Name": cname,
    Address: customers[i - 1].Address, City: city, "Pool Type": ptype,
    Surface: ptype === "Above-Ground" ? "Vinyl" : pick(SURFACES),
    Volume: String(ri(8, 40) * 1000),
    "Heating Manufacturer": heater, "Heating Model": pick(HEATER_MODELS[heater]),
    "Skimmer Count": String(ptype === "Above-Ground" ? ri(1, 2) : ri(1, 4)),
    Status: pick(POOL_STATUS), "Assigned Employee": pick(techNames),
    Notes: "",
  });
}

// ── service visits (~300) ──
const visits = [];
for (let i = 1; i <= 300; i++) {
  const p = pools[ri(0, 499)];
  const type = pick(SVC_TYPES);
  const status = pick(SVC_STATUS);
  visits.push({
    "Visit Id": "V-" + pad(i, 5), "Pool Id": p["Pool Id"], "Customer Name": p["Customer Name"], City: p.City,
    Date: dateIn(2026, status === "Scheduled" ? 6 : 4, status === "Scheduled" ? 9 : 6),
    "Service Type": type, Employee: p["Assigned Employee"], Status: status,
    Duration: String(ri(30, 180)),
    Notes: type === "Repair" ? pick(["Replaced pump seal","Patched vinyl liner","Repaired skimmer basket","Heater igniter replaced","Fixed return jet"]) : (type === "Cleaning" ? "Skimmed, brushed, vacuumed" : ""),
  });
}

// ── water tests (~400) ──
const tests = [];
function num(lo, hi, d) { return (lo + rnd() * (hi - lo)).toFixed(d); }
for (let i = 1; i <= 400; i++) {
  const p = pools[ri(0, 499)];
  const ph = parseFloat(num(6.8, 8.0, 1));
  const fc = parseFloat(num(0.2, 4.0, 1));
  const ta = ri(50, 150);
  const balanced = ph >= 7.2 && ph <= 7.6 && fc >= 1 && fc <= 3 && ta >= 80 && ta <= 120;
  const adds = [];
  if (ph > 7.6) adds.push("pH Down"); else if (ph < 7.2) adds.push("pH Up");
  if (fc < 1) adds.push("Chlorine"); else if (fc > 3) adds.push("");
  if (ta < 80) adds.push("Alkalinity Up");
  tests.push({
    "Test Id": "T-" + pad(i, 5), "Pool Id": p["Pool Id"], "Customer Name": p["Customer Name"],
    Date: dateIn(2026, 4, 6), Employee: p["Assigned Employee"],
    pH: ph.toFixed(1), "Free Chlorine": fc.toFixed(1), "Total Alkalinity": String(ta),
    "Calcium Hardness": String(ri(150, 400)), "Cyanuric Acid": String(ri(20, 70)),
    Temperature: String(ri(58, 86)), Result: balanced ? "Balanced" : "Needs Treatment",
    "Chemicals Added": balanced ? "None" : (adds.filter(Boolean).join(", ") || "Chlorine"),
    Notes: "",
  });
}

const out = { employees, customers, pools, "service-visits": visits, "water-tests": tests };
fs.writeFileSync(path.join(__dir, "seed-data.json"), JSON.stringify(out, null, 1));
console.log(`Wrote seed-data.json: ${employees.length} employees, ${customers.length} customers, ${pools.length} pools, ${visits.length} visits, ${tests.length} tests`);
