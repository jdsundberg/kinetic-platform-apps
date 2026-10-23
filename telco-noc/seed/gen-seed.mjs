/**
 * gen-seed.mjs — deterministic reference data + fiber-cut scenario for Borealis Communications
 * (fictional Twin Cities operator) and a second tenant (Prairie Wholesale) used to prove isolation.
 *
 * Writes:
 *   seed/reference.json         { formSlug: [values, ...] }  — topology, services, customers, SLAs, history
 *   seed/scenario-fiber-cut.json { phases: { cut:[event], restore:[event], reboot:[event] }, metrics:{...}, truth:{...} }
 *
 * Topology (simplified but structurally real):
 *   4-hub DWDM ring MSP–STP–BLN–MTK. Span FIB-MSP-STP-01 (I-94 corridor) carries 8 wavelengths → 8 OTU4 links.
 *     OTU-1  AGG-STP-01 single uplink (design flaw → problem record)  → 12 east-metro cell sites + 8 enterprise circuits
 *     OTU-2  AGG-STP-02 working uplink; protect OTU-2P around the ring  → 6 cell sites (at risk)
 *     OTU-3  wholesale 100G wave (unprotected)                           → Great Lakes Carrier
 *     OTU-4  IP core trunk CR-MSP-01↔CR-STP-01 (alt trunk via BLN)       → IP reroutes
 *     OTU-5  Northloop Financial DCI, 1+1 optical protection (OTU-5P)    → potential
 *     OTU-6..8 lit, no customer traffic
 *   Sites C10–C12 have microwave backup to C13–C15 (→ potential, not down).
 *   Mississippi River CU circuit was re-homed from AGG-STP-01 to AGG-STP-02 six days ago (time-aware edge)
 *   and service inventory still claims the old path (reconciliation conflict).
 * Usage: node seed/gen-seed.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const T = "borealis";
const NOW = new Date("2026-09-27T12:00:00Z"); // reference "seed time"; the replay tool shifts scenario events to real now
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
const daysAgo = (n) => iso(NOW.getTime() - n * 86400000);
const h = (s) => crypto.createHash("sha1").update(s).digest("hex");
let rng = 42; const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];

const out = {}; const add = (form, v) => { (out[form] ||= []).push({ "Tenant ID": v["Tenant ID"] || T, ...v }); return v; };

// ── Tenants, org ──────────────────────────────────────────────────────
add("tenants", { "Tenant ID": T, "Name": "Borealis Communications", "Status": "Active", "Data Region": "us-central", "Default Timezone": "America/Chicago",
  "Retention Policy": JSON.stringify({ rawAlarmsDays: 30, alarmsDays: 400, metricsDays: 30, incidentsYears: 7, auditYears: 7 }) });
add("tenants", { "Tenant ID": "prairie", "Name": "Prairie Wholesale Networks", "Status": "Active", "Data Region": "us-central", "Default Timezone": "America/Chicago",
  "Retention Policy": JSON.stringify({ rawAlarmsDays: 30, alarmsDays: 400, incidentsYears: 7, auditYears: 7 }) });

const TEAMS = [
  ["TEAM-NOC", "Network Operations Center", "NOC", "TEAM-NOC-MGR"], ["TEAM-TRANSPORT", "Transport NOC", "Transport", "TEAM-NOC-MGR"],
  ["TEAM-IP", "IP/MPLS NOC", "IP", "TEAM-NOC-MGR"], ["TEAM-RAN", "RAN NOC", "RAN", "TEAM-NOC-MGR"],
  ["TEAM-FIELD-EAST", "Field Ops — East Metro", "Field Ops", "TEAM-NOC-MGR"], ["TEAM-SVC-MGMT", "Service Management", "Service Mgmt", "TEAM-NOC-MGR"],
  ["TEAM-SUPPORT", "Enterprise Customer Support", "Customer Support", "TEAM-SVC-MGMT"], ["TEAM-NOC-MGR", "NOC Duty Management", "NOC", ""],
];
for (const [id, name, fn, esc] of TEAMS) add("teams", { "Team ID": id, "Name": name, "Organization": "Borealis Network Operations", "Function": fn, "Regions": "North Central", "Escalation Team ID": esc, "Queue Email": `${id.toLowerCase()}@borealis.example`, "Status": "Active" });
add("teams", { "Tenant ID": "prairie", "Team ID": "TEAM-NOC", "Name": "Prairie NOC", "Function": "NOC", "Status": "Active" });

const ONCALL = [
  ["TEAM-TRANSPORT", "noc.borealis", "Dana Okafor", "Primary"], ["TEAM-TRANSPORT", "sam.lindqvist", "Sam Lindqvist", "Secondary"],
  ["TEAM-IP", "arjun.mehta", "Arjun Mehta", "Primary"], ["TEAM-RAN", "keisha.brown", "Keisha Brown", "Primary"],
  ["TEAM-FIELD-EAST", "tech.borealis", "Luis Ortega", "Primary"], ["TEAM-FIELD-EAST", "mei.tanaka", "Mei Tanaka", "Secondary"],
  ["TEAM-SVC-MGMT", "owner.borealis", "Priya Raman", "Primary"], ["TEAM-NOC-MGR", "grace.holm", "Grace Holm", "Manager"],
  ["TEAM-SUPPORT", "support.borealis", "Tom Becker", "Primary"],
];
ONCALL.forEach(([team, user, name, role], i) => add("oncall", { "Assignment ID": `OC-${String(i + 1).padStart(6, "0")}`, "Team ID": team, "User": user, "Display Name": name, "Role": role, "Region": "North Central",
  "Starts At": "2026-09-01T00:00:00Z", "Ends At": "2026-12-31T23:59:59Z", "Escalation Level": role === "Manager" ? "2" : role === "Secondary" ? "1" : "0", "Contact Phone": `+1-612-555-${String(100 + i).padStart(4, "0")}` }));

// ── Geography ─────────────────────────────────────────────────────────
add("geo-areas", { "Area ID": "RGN-NC", "Name": "North Central", "Area Type": "Region", "Parent Area ID": "", "Centroid Lat": "45.5", "Centroid Lon": "-93.5" });
for (const [id, name, lat, lon] of [["MKT-MSP", "Twin Cities", 44.9537, -93.09], ["MKT-DLH", "Duluth", 46.7867, -92.1005], ["MKT-RST", "Rochester", 44.0121, -92.4802]])
  add("geo-areas", { "Area ID": id, "Name": name, "Area Type": "Market", "Parent Area ID": "RGN-NC", "Centroid Lat": String(lat), "Centroid Lon": String(lon) });

const PROV = (src, conf = "0.98", seen = daysAgo(0.5)) => ({ "Source System": src, "Last Seen At": seen, "Confidence": conf });
const site = (id, name, type, mkt, lat, lon, street, city, zip, extra = {}) => add("sites", { "Site ID": id, "Name": name, "Site Type": type, "Market ID": mkt, "Region ID": "RGN-NC",
  "Street": street, "City": city, "State": "MN", "Postal Code": zip, "Latitude": lat.toFixed(5), "Longitude": lon.toFixed(5), "Geo Source": "gis",
  "Access Hours": "24x7", "Lifecycle": "Active", "External IDs": JSON.stringify({ gis: "GIS-" + h(id).slice(0, 6).toUpperCase() }), ...PROV("netinv-a"), ...extra });

site("SITE-MSP-HUB1", "Minneapolis Hub (Northstar CO)", "Hub", "MKT-MSP", 44.9795, -93.2710, "401 N 3rd Ave", "Minneapolis", "55401", { "Access Instructions": "Badge + NOC escort; loading dock on 4th St", "Backup Power": "Generator 72h + battery 8h", "Safety Notes": "Battery room — acid PPE required" });
site("SITE-STP-HUB2", "St Paul Hub (Lowertown CO)", "Hub", "MKT-MSP", 44.9496, -93.0866, "250 E 6th St", "Saint Paul", "55101", { "Access Instructions": "Badge; after-hours call NOC for door release", "Backup Power": "Generator 48h + battery 8h", "Safety Notes": "Raised floor — lift tiles with two people" });
site("SITE-BLN-HUB3", "Bloomington Hub", "Hub", "MKT-MSP", 44.8408, -93.2983, "8100 Penn Ave S", "Bloomington", "55431", { "Backup Power": "Generator 48h" });
site("SITE-MTK-HUB4", "Minnetonka Hub", "Hub", "MKT-MSP", 44.9133, -93.5033, "10901 Red Circle Dr", "Minnetonka", "55343", { "Backup Power": "Generator 48h" });
site("SITE-DLH-HUB1", "Duluth Hub", "Hub", "MKT-DLH", 46.7867, -92.1005, "30 W Superior St", "Duluth", "55802");
site("SITE-RST-HUB1", "Rochester Hub", "Hub", "MKT-RST", 44.0234, -92.4630, "20 1st Ave SW", "Rochester", "55902");
site("SITE-DEPOT-EAST", "East Metro Field Depot", "Depot", "MKT-MSP", 44.9690, -93.0240, "1500 Arcade St", "Saint Paul", "55106");
site("SITE-FH-I94-09", "I-94 Fiber Hut km 9", "Fiber Hut", "MKT-MSP", 44.9540, -93.1210, "I-94 ROW at Lexington Pkwy", "Saint Paul", "55104", { "Access Instructions": "MnDOT right-of-way permit on file (#R-22817); park on Concordia Ave frontage road", "Safety Notes": "Live traffic — Class 3 vest, cones, flagger required on shoulder" });

const EAST = ["Dayton's Bluff", "Payne-Phalen", "Frogtown", "Lowertown", "West Side", "Mounds Park", "Railroad Island", "Hillcrest", "Battle Creek",
  "Highwood", "Conway", "Sunray", "Maplewood Mall", "North St Paul", "Oakdale", "Woodbury North", "Landfall", "Tanners Lake"];
const cellSites = EAST.map((nm, i) => {
  const n = String(i + 1).padStart(2, "0");
  const lat = 44.93 + ((i * 37) % 11) * 0.006 + (i > 11 ? 0.02 : 0), lon = -93.12 + (i % 9) * 0.018 + (i > 11 ? 0.06 : 0);
  return site(`SITE-STP-C${n}`, `${nm} ${pick(["Monopole", "Rooftop", "Water Tower", "Lattice"])}`, "Cell Site", "MKT-MSP", lat, lon, `${1000 + i * 37} ${pick(["E 7th St", "Payne Ave", "Arcade St", "White Bear Ave", "Maryland Ave", "Minnehaha Ave"])}`, "Saint Paul", "55106",
    { "Access Instructions": `Gate code ${4400 + i} (rotate monthly via NOC); key box at base of ${pick(["tower", "stair"])}`, "Access Hours": i % 5 === 3 ? "07:00–19:00 (landlord)" : "24x7",
      "Safety Notes": "RF exposure: power down sector radios before climbing; 100% tie-off", "Landlord": `Tower lease #${88000 + i * 13}`, "Backup Power": i % 4 === 0 ? "Battery 2h" : "Battery 4h" });
});
const otherSites = [];
for (let i = 1; i <= 6; i++) otherSites.push(site(`SITE-MSP-C${String(i).padStart(2, "0")}`, `Minneapolis cell ${i}`, "Cell Site", "MKT-MSP", 44.97 + i * 0.01, -93.27 + i * 0.012, `${200 + i * 50} Hennepin Ave`, "Minneapolis", "55401"));
for (let i = 1; i <= 4; i++) otherSites.push(site(`SITE-DLH-C${String(i).padStart(2, "0")}`, `Duluth cell ${i}`, "Cell Site", "MKT-DLH", 46.78 + i * 0.01, -92.10 - i * 0.01, `${100 + i * 20} London Rd`, "Duluth", "55805"));
for (let i = 1; i <= 3; i++) otherSites.push(site(`SITE-RST-C${String(i).padStart(2, "0")}`, `Rochester cell ${i}`, "Cell Site", "MKT-RST", 44.02 + i * 0.01, -92.46 - i * 0.01, `${300 + i * 20} Broadway Ave N`, "Rochester", "55906"));

// ── Resources + relationships + identifier map ────────────────────────
const RES = {}; let relN = 0, xidN = 0;
function res(id, name, cls, type, o = {}) {
  const v = { "Resource ID": id, "Name": name, "Resource Class": cls, "Resource Type": type, "Admin State": "In Service", "Oper State": "Up", "Health": "Healthy",
    "Health Updated At": daysAgo(0.1), "Criticality": o.crit || "Medium", "Lifecycle": o.lifecycle || "Active", "Site ID": o.site || "", "A Site ID": o.a || "", "Z Site ID": o.z || "",
    "Parent Resource ID": o.parent || "", "Vendor": o.vendor || "", "Model": o.model || "", "Aliases": (o.aliases || []).join(","), "Route Length Km": o.km ? String(o.km) : "",
    "Characteristics": JSON.stringify(o.ch || {}), "External IDs": JSON.stringify(o.ext || {}), ...PROV(o.src || "netinv-a", o.conf || "0.97") };
  RES[id] = add("resources", v);
  xid(id, id, "*", "Exact");
  for (const a of o.aliases || []) xid(a, id, o.aliasSrc || "*", "Alias");
  return v;
}
function xid(ext, internal, src, kind, extra = {}) {
  add("identifiers", { "Mapping ID": `XID-${String(++xidN).padStart(6, "0")}`, "External ID": ext, "Source System": src, "Entity Type": "Resource", "Internal ID": internal,
    "Match Kind": kind, "Valid From": "2024-01-01T00:00:00Z", "Valid To": "", "Confidence": "1", "Last Verified At": daysAgo(1), ...extra });
}
function rel(from, to, type, o = {}) {
  add("relationships", { "Relationship ID": `REL-${String(++relN).padStart(6, "0")}`, "From ID": from, "From Kind": o.kind || "Resource", "To ID": to, "Relationship Type": type,
    "Redundancy Group": o.rg || "", "Protection Role": o.role || "None", "Valid From": o.from || "2024-03-01T00:00:00Z", "Valid To": o.to || "", "Status": o.status || "Active",
    "Last Verified At": o.verified || daysAgo(1), "Source System": o.src || "netinv-a", "Confidence": o.conf || "0.97", "External IDs": "{}", "Last Seen At": o.verified || daysAgo(1) });
}

// Fiber ring + long haul
const SPANS = [["FIB-MSP-STP-01", "SITE-MSP-HUB1", "SITE-STP-HUB2", 14.2, "I-94 corridor", "SRLG-I94"], ["FIB-STP-BLN-01", "SITE-STP-HUB2", "SITE-BLN-HUB3", 21.6, "TH-5 / Mississippi crossing", "SRLG-TH5"],
  ["FIB-BLN-MTK-01", "SITE-BLN-HUB3", "SITE-MTK-HUB4", 17.9, "I-494 west", "SRLG-I494W"], ["FIB-MTK-MSP-01", "SITE-MTK-HUB4", "SITE-MSP-HUB1", 19.4, "I-394", "SRLG-I394"],
  ["FIB-MSP-DLH-01", "SITE-MSP-HUB1", "SITE-DLH-HUB1", 247, "I-35 long haul", "SRLG-I35"], ["FIB-STP-RST-01", "SITE-STP-HUB2", "SITE-RST-HUB1", 128, "US-52 long haul", "SRLG-US52"]];
for (const [id, a, z, km, route, srlg] of SPANS) res(id, `${route} span ${a.replace("SITE-", "")} ↔ ${z.replace("SITE-", "")}`, "Physical", "Fiber Span",
  { a, z, km, crit: "Critical", vendor: "Corning", model: "SMF-28 ULL 144F", ch: { fiberCount: 144, srlg, route }, ext: { gis: "GIS-F-" + h(id).slice(0, 5).toUpperCase(), "netinv-a": "SPAN-" + h(id).slice(0, 4) }, aliases: [id.replace("FIB-", "SPAN-")] });

const ROADMS = [["ROADM-MSP-01", "SITE-MSP-HUB1"], ["ROADM-STP-02", "SITE-STP-HUB2"], ["ROADM-BLN-03", "SITE-BLN-HUB3"], ["ROADM-MTK-04", "SITE-MTK-HUB4"], ["ROADM-DLH-01", "SITE-DLH-HUB1"], ["ROADM-RST-01", "SITE-RST-HUB1"]];
for (const [id, s] of ROADMS) { res(id, `${id} ROADM chassis`, "Physical", "ROADM", { site: s, crit: "Critical", vendor: "Ciena", model: "6500 T-Series", src: "optical-ems-inv" }); }
// OTS degree ports: each span terminates on one port at each end
const PORTS = { "FIB-MSP-STP-01": [["ROADM-MSP-01", "OTS-2"], ["ROADM-STP-02", "OTS-1"]], "FIB-STP-BLN-01": [["ROADM-STP-02", "OTS-2"], ["ROADM-BLN-03", "OTS-1"]],
  "FIB-BLN-MTK-01": [["ROADM-BLN-03", "OTS-2"], ["ROADM-MTK-04", "OTS-1"]], "FIB-MTK-MSP-01": [["ROADM-MTK-04", "OTS-2"], ["ROADM-MSP-01", "OTS-1"]] };
for (const [span, ends] of Object.entries(PORTS)) for (const [ne, aid] of ends) {
  const pid = `${ne}/${aid}`; res(pid, `${ne} ${aid} line port`, "Physical", "Optical Port", { site: RES[ne]["Site ID"], parent: ne, crit: "High", vendor: "Ciena", aliases: [`${ne}:${aid}`], aliasSrc: "optical-ems" });
  rel(pid, span, "terminates_on"); rel(pid, ne, "part_of");
}
xid("ROADM-MSP-01", "ROADM-MSP-01", "optical-ems", "Parent"); xid("ROADM-STP-02", "ROADM-STP-02", "optical-ems", "Parent"); xid("ROADM-BLN-03", "ROADM-BLN-03", "optical-ems", "Parent");

// Wavelengths + OTU links on the cut span
const OTU = [];
for (let c = 1; c <= 8; c++) {
  const ch = 20 + c, wl = `WL-MSP-STP-C${ch}`, otu = `OTU-MSP-STP-${c}`;
  res(wl, `Ch C${ch} MSP↔STP`, "Logical", "Wavelength", { a: "SITE-MSP-HUB1", z: "SITE-STP-HUB2", crit: "High", aliases: [`ROADM-MSP-01:CH-C${ch}`, `ROADM-STP-02:CH-C${ch}`], aliasSrc: "optical-ems", src: "optical-ems-inv" });
  rel(wl, "FIB-MSP-STP-01", "carried_by");
  res(otu, `OTU4 #${c} MSP↔STP (C${ch})`, "Logical", "OTN Link", { a: "SITE-MSP-HUB1", z: "SITE-STP-HUB2", crit: c <= 5 ? "Critical" : "Medium", aliases: [`MSP-TP-01:OTU4-${c}`, `STP-TP-02:OTU4-${c}`], aliasSrc: "optical-ems", src: "optical-ems-inv", ch: { rate: "100G", clientUse: ["AGG-STP-01 uplink", "AGG-STP-02 working uplink", "Wholesale wave", "IP core trunk", "Northloop DCI (working)", "idle", "idle", "idle"][c - 1] } });
  rel(otu, wl, "depends_on"); OTU.push(otu);
}
xid("MSP-TP-01", "ROADM-MSP-01", "optical-ems", "Parent"); xid("STP-TP-02", "ROADM-STP-02", "optical-ems", "Parent");
// Ring protect paths (via STP→BLN→MTK→MSP)
for (const [otu, ch] of [["OTU-STP-MSP-2P", 31], ["OTU-STP-MSP-5P", 32], ["OTU-STP-BLN-9", 33]]) {
  const legs = otu === "OTU-STP-BLN-9" ? [["FIB-STP-BLN-01", "STP-BLN"]] : [["FIB-STP-BLN-01", "STP-BLN"], ["FIB-BLN-MTK-01", "BLN-MTK"], ["FIB-MTK-MSP-01", "MTK-MSP"]];
  res(otu, `${otu} ring path (C${ch})`, "Logical", "OTN Link", { crit: "High", src: "optical-ems-inv", aliases: [`${otu}`] });
  for (const [span, tag] of legs) { const wl = `WL-${tag}-C${ch}`; if (!RES[wl]) { res(wl, `Ch C${ch} ${tag}`, "Logical", "Wavelength", { crit: "High", src: "optical-ems-inv" }); rel(wl, span, "carried_by"); } rel(otu, wl, "depends_on"); }
}

// IP layer
const router = (id, s, model) => res(id, `${id}`, "Physical", "Router", { site: s, crit: "Critical", vendor: "Cisco", model, aliases: [`${id.toLowerCase()}.borealis.net`, id.toLowerCase()], ext: { "ip-nms": id.toLowerCase() } });
router("CR-MSP-01", "SITE-MSP-HUB1", "8812"); router("CR-STP-01", "SITE-STP-HUB2", "8812"); router("AGG-STP-01", "SITE-STP-HUB2", "ASR 9903"); router("AGG-STP-02", "SITE-STP-HUB2", "ASR 9903"); router("AGG-MSP-01", "SITE-MSP-HUB1", "ASR 9903");
const iface = (host, ifn, dep, o = {}) => { const id = `${host}/${ifn}`; res(id, `${host} ${ifn}`, "Logical", "Interface", { site: RES[host]["Site ID"], parent: host, crit: "High", aliases: [`${host.toLowerCase()}.borealis.net|${ifn}`, `${host.toLowerCase()}/${ifn}`] }); if (dep) rel(id, dep, "depends_on", o); return id; };
iface("AGG-STP-01", "Hu0/0/0/0", "OTU-MSP-STP-1"); iface("CR-MSP-01", "Hu0/0/0/5", "OTU-MSP-STP-1");
rel("AGG-STP-01", "AGG-STP-01/Hu0/0/0/0", "depends_on"); // single-homed uplink — the design flaw
iface("AGG-STP-02", "Hu0/0/0/0", "OTU-MSP-STP-2"); iface("AGG-STP-02", "Hu0/0/0/1", "OTU-STP-MSP-2P"); iface("CR-MSP-01", "Hu0/0/0/6", "OTU-MSP-STP-2");
rel("AGG-STP-02", "AGG-STP-02/Hu0/0/0/0", "depends_on", { rg: "RG-AGG2-UPLINK", role: "Working" }); rel("AGG-STP-02", "AGG-STP-02/Hu0/0/0/1", "depends_on", { rg: "RG-AGG2-UPLINK", role: "Protect" });
iface("CR-MSP-01", "Hu0/0/1/0", "OTU-MSP-STP-4"); iface("CR-STP-01", "Hu0/0/1/0", "OTU-MSP-STP-4"); iface("CR-STP-01", "Hu0/0/1/1", "OTU-STP-BLN-9");
rel("CR-STP-01", "CR-STP-01/Hu0/0/1/0", "depends_on", { rg: "RG-CR-STP-CORE", role: "Working" }); rel("CR-STP-01", "CR-STP-01/Hu0/0/1/1", "depends_on", { rg: "RG-CR-STP-CORE", role: "Protect" });
rel("AGG-MSP-01", "CR-MSP-01", "depends_on");
for (const host of ["AGG-STP-01", "AGG-STP-02", "CR-MSP-01", "CR-STP-01"]) { xid(`${host.toLowerCase()}.borealis.net`, host, "*", "Parent"); xid(host.toLowerCase(), host, "*", "Parent"); }

// Cell sites (RAN)
const cellInfo = [];
EAST.forEach((nm, i) => {
  const n = String(i + 1).padStart(2, "0"), s = `SITE-STP-C${n}`;
  const csr = `CSR-STP-C${n}`, gnb = `GNB-STP-C${n}`, pwr = `PWR-STP-C${n}`;
  res(pwr, `${s} DC power plant`, "Physical", "Power Plant", { site: s, crit: "High", vendor: "Eltek", aliases: [`${s}-PWR`], aliasSrc: "power-bms" });
  res(csr, `Cell site router ${nm}`, "Physical", "Cell Site Router", { site: s, crit: "High", vendor: "Cisco", model: "NCS 540", aliases: [`csr-stp-c${n}.borealis.net`, `csr-stp-c${n}`] });
  xid(`csr-stp-c${n}.borealis.net`, csr, "*", "Parent");
  res(gnb, `gNodeB ${nm}`, "Physical", "gNodeB", { site: s, crit: "High", vendor: "Ericsson", model: "Baseband 6648", aliases: [`gNB-STP-C${n}`], aliasSrc: "ran-oss" });
  rel(gnb, csr, "backhauled_by"); rel(gnb, pwr, "powered_by"); rel(csr, pwr, "powered_by");
  for (let k = 1; k <= 3; k++) { const cid = `CELL-STP-C${n}-${k}`; res(cid, `${nm} sector ${k} n71/n41`, "Logical", "Cell", { site: s, parent: gnb, crit: "Medium", aliases: [`gNB-STP-C${n}:cell-${k}`], aliasSrc: "ran-oss" }); rel(cid, gnb, "part_of"); }
  const agg = i < 12 ? "AGG-STP-01" : "AGG-STP-02";
  if (i >= 9 && i <= 11) { // C10–C12: microwave backup hop to C13–C15
    const peer = `CSR-STP-C${String(i + 4).padStart(2, "0")}`, mw = `MW-STP-C${n}-C${String(i + 4).padStart(2, "0")}`;
    res(mw, `Microwave ${n}→${i + 4}`, "Physical", "Microwave Link", { site: s, crit: "Medium", vendor: "Aviat", aliases: [mw.toLowerCase()] });
    rel(mw, peer, "depends_on"); rel(csr, agg, "backhauled_by", { rg: `RG-${csr}-BH`, role: "Working" }); rel(csr, mw, "backhauled_by", { rg: `RG-${csr}-BH`, role: "Protect" });
  } else rel(csr, agg, "backhauled_by");
  cellInfo.push({ n, nm, s, csr, gnb, agg, i });
});
// Other markets (for "not impacted" contrast + history)
otherSites.forEach((s) => {
  const id = s["Site ID"].replace("SITE-", ""), csr = `CSR-${id}`, gnb = `GNB-${id}`;
  const agg = id.startsWith("MSP") ? "AGG-MSP-01" : null;
  res(csr, `Cell site router ${id}`, "Physical", "Cell Site Router", { site: s["Site ID"], vendor: "Cisco", aliases: [`${csr.toLowerCase()}.borealis.net`] });
  res(gnb, `gNodeB ${id}`, "Physical", "gNodeB", { site: s["Site ID"], vendor: "Ericsson", aliases: [gnb.replace("GNB", "gNB")], aliasSrc: "ran-oss" });
  rel(gnb, csr, "backhauled_by"); if (agg) rel(csr, agg, "backhauled_by"); else rel(csr, id.startsWith("DLH") ? "ROADM-DLH-01" : "ROADM-RST-01", "backhauled_by");
});
res("PWR-DLH-HUB1", "Duluth Hub power plant", "Physical", "Power Plant", { site: "SITE-DLH-HUB1", aliases: ["SITE-DLH-HUB1-PWR"], aliasSrc: "power-bms" });
res("PWR-RST-HUB1", "Rochester Hub power plant", "Physical", "Power Plant", { site: "SITE-RST-HUB1", aliases: ["SITE-RST-HUB1-PWR"], aliasSrc: "power-bms" });
res("ROADM-BLN-03/SLOT-7", "ROADM-BLN-03 amplifier card slot 7", "Physical", "Optical Port", { site: "SITE-BLN-HUB3", parent: "ROADM-BLN-03", aliases: ["ROADM-BLN-03:SLOT-7"], aliasSrc: "optical-ems" });
res("AGG-MSP-01/Te0/0/0/14", "AGG-MSP-01 Te0/0/0/14", "Logical", "Interface", { site: "SITE-MSP-HUB1", parent: "AGG-MSP-01", aliases: ["agg-msp-01.borealis.net|Te0/0/0/14"] });

// ── Service catalog, SLAs, customers ─────────────────────────────────
const SLAS = [["SLA-PLAT", "Platinum 99.99", 99.99, 4, 10, 50, 15], ["SLA-GOLD", "Gold 99.95", 99.95, 6, 5, 30, 30], ["SLA-SILVER", "Silver 99.9", 99.9, 8, 3, 20, 60],
  ["SLA-STD", "Standard best-effort 99.5", 99.5, 24, 0, 0, 240], ["SLA-PS", "Public Safety 99.999", 99.999, 2, 10, 100, 5], ["SLA-WHOLESALE", "Wholesale wave 99.98", 99.98, 4, 8, 40, 15]];
for (const [id, nm, av, mttr, cr, cap, resp] of SLAS) add("slas", { "SLA ID": id, "Name": nm, "Availability Target Pct": String(av), "Measurement Window": "Calendar Month", "MTTR Target Hours": String(mttr), "Credit Pct Per Hour": String(cr), "Credit Cap Pct": String(cap), "Response Minutes": String(resp) });
for (const [id, nm, cat, sla] of [["OFF-MOBILE", "Mobile Coverage (RAN)", "Mobile", "SLA-STD"], ["OFF-DIA", "Dedicated Internet Access", "Enterprise Data", "SLA-GOLD"], ["OFF-EVPL", "Ethernet Private Line", "Enterprise Data", "SLA-GOLD"],
  ["OFF-WAVE", "Wholesale Wavelength", "Wholesale", "SLA-WHOLESALE"], ["OFF-PSAP", "911 PSAP Trunk", "Public Safety", "SLA-PS"], ["OFF-DCI", "Data Center Interconnect", "Enterprise Data", "SLA-PLAT"]])
  add("offerings", { "Offering ID": id, "Name": nm, "Category": cat, "Default SLA ID": sla, "Status": "Active" });

let acctN = 1000, subN = 20900, conN = 3300;
const CUST = {};
function customer(name, seg, tier, o = {}) {
  const id = o.id || `ACCT-${++acctN}`;
  CUST[name] = add("customers", { "Account ID": id, "Name": name, "Segment": seg, "Tier": tier, "Public Safety": o.ps ? "Yes" : "No", "Account Manager": o.am || pick(["Priya Raman", "Marcus Webb", "Elena Duarte"]),
    "Region ID": "RGN-NC", "Preferred Channel": o.ch || "Email", "Status Page Opt In": "Yes", "Status": "Active", "External IDs": JSON.stringify({ crm: "CRM-" + h(name).slice(0, 6).toUpperCase(), billing: "BAN-" + (400000 + acctN) }), ...PROV("crm", "0.99") });
  const people = o.contacts ?? 2;
  for (let k = 0; k < people; k++) {
    const first = pick(["Jordan", "Avery", "Morgan", "Casey", "Riley", "Quinn", "Taylor", "Reese"]), last = pick(["Lee", "Nguyen", "Johnson", "Hansen", "Ali", "Kowalski", "Vang", "Olson"]);
    const dom = name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "").slice(0, 18);
    add("contacts", { "Contact ID": `CON-${++conN}`, "Account ID": id, "Name": `${first} ${last}`, "Role": k === 0 ? "IT Director" : "NOC Liaison", "Email": `${first}.${last}@${dom}.example`.toLowerCase(),
      "Phone": `+1-651-555-${String(1000 + conN).slice(-4)}`, "Preferred Channel": k === 0 ? (o.ch || "Email") : "SMS", "Notify On": k === 0 ? "All" : "Major", "Consent Recorded At": "2025-01-14T16:02:00Z" });
  }
  return id;
}
function service(id, name, off, o = {}) {
  add("service-instances", { "Service Instance ID": id, "Name": name, "Offering ID": off, "Service Class": "CFS", "Status": "Active", "Primary Site ID": o.site || "", "Protection": o.prot || "Unprotected",
    "Monitoring": o.mon || "Active Probe", "Bandwidth": o.bw || "", "Health": "Healthy", "Health Updated At": daysAgo(0.05), "External IDs": JSON.stringify({ svcinv: "SI-" + id.split("-").pop() }), ...PROV("svcinv", o.conf || "0.95") });
  return id;
}
function subscribe(acct, svc, sla, o = {}) {
  add("subscriptions", { "Subscription ID": `SUB-${++subN}`, "Account ID": acct, "Service Instance ID": svc, "SLA ID": sla, "Contract ID": o.ctr || `CTR-2024-${String(subN % 1000).padStart(4, "0")}`,
    "Contract End": o.end || "2027-12-31", "Status": o.status || "Active", "Valid From": o.from || "2024-07-01T00:00:00Z", "Valid To": o.to || "", "Monthly Recurring Charge": String(o.mrc ?? 0),
    "Subscriber Count": String(o.count || 1), "External IDs": JSON.stringify({ billing: "SVCACC-" + subN }), ...PROV("bss", "0.99") });
}

// Consumer segment + enterprise mobile
const consumer = customer("Consumer Mobile — East Metro", "Consumer Segment", "Standard", { id: "ACCT-CONS-EM", contacts: 0, ch: "Status Page", am: "Consumer Care" });
const transit = customer("Capitol Region Transit", "Government", "Gold", { ch: "Email" });
const psradio = customer("East Metro Public Safety Radio", "Public Safety", "Platinum", { ps: true, ch: "Phone" });
for (const c of cellInfo) {
  const svc = service(`SVC-RAN-STP-C${c.n}`, `Mobile coverage — ${c.nm}`, "OFF-MOBILE", { site: c.s, mon: "KPI" });
  rel(svc, c.gnb, "depends_on", { kind: "Service Instance", src: "svcinv" });
  subscribe(consumer, svc, "SLA-STD", { count: 1200 + Math.floor(rand() * 2200), mrc: 0 });
  if (["03", "04", "14"].includes(c.n)) subscribe(transit, svc, "SLA-GOLD", { mrc: 1800 });
  if (["05", "06"].includes(c.n)) subscribe(psradio, svc, "SLA-PS", { mrc: 4200 });
}
for (const s of otherSites) { const id = s["Site ID"].replace("SITE-", ""); const svc = service(`SVC-RAN-${id}`, `Mobile coverage — ${s.Name}`, "OFF-MOBILE", { site: s["Site ID"], mon: "KPI" }); rel(svc, `GNB-${id}`, "depends_on", { kind: "Service Instance", src: "svcinv" }); }

// Enterprise circuits on AGG-STP-01 (+ one re-homed)
const ENT = [
  ["SVC-DIA-10442", "Riverbend Medical Center", "Enterprise", "Platinum", "OFF-DIA", "SLA-PLAT", "1 Gbps", "Active Probe", 2450, 12],
  ["SVC-DIA-10451", "Capitol City Schools", "Government", "Gold", "OFF-DIA", "SLA-GOLD", "10 Gbps", "Active Probe", 5200, 13],
  ["SVC-EVPL-20117", "Lowertown Data Co", "Enterprise", "Gold", "OFF-EVPL", "SLA-GOLD", "1 Gbps", "Active Probe", 1900, 14],
  ["SVC-DIA-10467", "Highland Grocers", "Enterprise", "Silver", "OFF-DIA", "SLA-SILVER", "500 Mbps", "None", 890, 15],
  ["SVC-PSAP-30001", "Ramsey East 911 PSAP", "Public Safety", "Platinum", "OFF-PSAP", "SLA-PS", "2x DS3 equiv", "Active Probe", 6100, 16],
  ["SVC-EVPL-20124", "Como Park Clinics", "Enterprise", "Gold", "OFF-EVPL", "SLA-GOLD", "1 Gbps", "Active Probe", 1650, 17],
  ["SVC-DIA-10488", "Selby Avenue Coworking", "Enterprise", "Standard", "OFF-DIA", "SLA-STD", "300 Mbps", "Passive (alarms only)", 540, 18],
  ["SVC-DIA-10479", "Mississippi River Credit Union", "Enterprise", "Gold", "OFF-DIA", "SLA-GOLD", "1 Gbps", "Active Probe", 2100, 19],
];
for (const [svc, cname, seg, tier, off, sla, bw, mon, mrc, port] of ENT) {
  const acct = customer(cname, seg, tier, { ps: seg === "Public Safety", ch: seg === "Public Safety" ? "Phone" : "Email" });
  const ckt = svc.replace("SVC-", "CKT-");
  res(ckt, `${cname} circuit ${bw}`, "Logical", "Circuit", { site: "SITE-STP-HUB2", crit: tier === "Platinum" ? "Critical" : "High", aliases: [`cpe-${svc.split("-").pop()}.borealis.net`, `cpe-${svc.split("-").pop()}`], src: "svcinv" });
  xid(`cpe-${svc.split("-").pop()}.borealis.net`, ckt, "*", "Parent");
  service(svc, `${cname} ${off === "OFF-PSAP" ? "911 trunk" : off.replace("OFF-", "")} ${bw}`, off, { site: "SITE-STP-HUB2", mon, bw, prot: svc === "SVC-PSAP-30001" ? "Protected" : "Unprotected" });
  rel(svc, ckt, "depends_on", { kind: "Service Instance", src: "svcinv" });
  if (svc === "SVC-PSAP-30001") { // diverse: primary AGG-STP-01, secondary AGG-STP-02
    rel(ckt, "AGG-STP-01", "depends_on", { rg: "RG-PSAP-DIVERSE", role: "Working" }); rel(ckt, "AGG-STP-02", "depends_on", { rg: "RG-PSAP-DIVERSE", role: "Protect" });
  } else if (svc === "SVC-DIA-10479") { // re-homed 6 days ago: old edge retired, new edge valid; service inventory still claims old
    rel(ckt, "AGG-STP-01", "depends_on", { to: daysAgo(6), status: "Retired", src: "svcinv" });
    rel(ckt, "AGG-STP-02", "depends_on", { from: daysAgo(6), src: "discovery-lldp", conf: "0.9" });
  } else rel(ckt, "AGG-STP-01", "depends_on");
  subscribe(acct, svc, sla, { mrc });
}
// Wholesale wave + DCI
const glc = customer("Great Lakes Carrier", "Wholesale", "Platinum", { ch: "Email" });
service("SVC-WAVE-3001", "Great Lakes Carrier 100G wave MSP–STP", "OFF-WAVE", { site: "SITE-MSP-HUB1", mon: "Passive (alarms only)", bw: "100G" }); rel("SVC-WAVE-3001", "OTU-MSP-STP-3", "depends_on", { kind: "Service Instance" }); subscribe(glc, "SVC-WAVE-3001", "SLA-WHOLESALE", { mrc: 14500 });
const nlf = customer("Northloop Financial", "Enterprise", "Platinum", { ch: "Email" });
service("SVC-DCI-40010", "Northloop Financial DCI 100G (1+1)", "OFF-DCI", { site: "SITE-MSP-HUB1", mon: "Active Probe", bw: "100G", prot: "Protected" });
rel("SVC-DCI-40010", "OTU-MSP-STP-5", "depends_on", { kind: "Service Instance", rg: "RG-DCI-1P1", role: "Working" }); rel("SVC-DCI-40010", "OTU-STP-MSP-5P", "depends_on", { kind: "Service Instance", rg: "RG-DCI-1P1", role: "Protect" });
subscribe(nlf, "SVC-DCI-40010", "SLA-PLAT", { mrc: 22000 });
// Unaffected enterprise customers elsewhere
for (const [cname, svc, host] of [["North Loop Architects", "SVC-DIA-10501", "AGG-MSP-01"], ["Duluth Harbor Logistics", "SVC-DIA-10502", "ROADM-DLH-01"], ["Mayo Clinic Research Annex", "SVC-EVPL-20190", "ROADM-RST-01"], ["Target Field Events", "SVC-DIA-10503", "AGG-MSP-01"]]) {
  const acct = customer(cname, "Enterprise", "Gold"); const ckt = svc.replace("SVC-", "CKT-");
  res(ckt, `${cname} circuit`, "Logical", "Circuit", { src: "svcinv" }); service(svc, `${cname} ${svc.split("-")[1]}`, svc.includes("EVPL") ? "OFF-EVPL" : "OFF-DIA", { mon: "Active Probe" });
  rel(svc, ckt, "depends_on", { kind: "Service Instance" }); rel(ckt, host, "depends_on"); subscribe(acct, svc, "SLA-GOLD", { mrc: 1500 });
}
// Reconciliation conflict: svcinv still says MRCU rides AGG-STP-01
add("conflicts", { "Conflict ID": "RCN-000001", "Entity Type": "Relationship", "Entity ID": "CKT-DIA-10479", "Field": "depends_on (aggregation router)", "Source A": "svcinv", "Value A": "AGG-STP-01", "Seen A At": daysAgo(0.4),
  "Source B": "discovery-lldp", "Value B": "AGG-STP-02", "Seen B At": daysAgo(0.1), "Resolution Policy": "discovery wins for physical adjacency when fresher; svcinv wins for customer ownership", "Policy Value": "AGG-STP-02", "State": "Open" });
add("conflicts", { "Conflict ID": "RCN-000002", "Entity Type": "Site", "Entity ID": "SITE-STP-C07", "Field": "Latitude/Longitude", "Source A": "gis", "Value A": "44.96010,-93.06620", "Seen A At": daysAgo(3),
  "Source B": "field-survey", "Value B": "44.96044,-93.06581", "Seen B At": daysAgo(40), "Resolution Policy": "gis authoritative; survey older", "Policy Value": "44.96010,-93.06620", "State": "Auto-Resolved", "Resolved By": "engine", "Resolved At": daysAgo(3) });

// Change requests: one in-progress with suppression (BLN amp card), one scheduled (future), one completed
add("changes", { "Change ID": "CHG-4410", "Title": "Replace amplifier card slot 7 on ROADM-BLN-03", "Change Type": "Normal", "State": "In Progress", "Risk": "Medium", "Risk Score": "48",
  "Risk Factors": JSON.stringify(["ring degree carries protect paths OTU-STP-MSP-2P/5P", "no customer traffic on working path"]), "Affected Resource IDs": "ROADM-BLN-03/SLOT-7,ROADM-BLN-03",
  "Window Start": "RELATIVE:-60", "Window End": "RELATIVE:+120", "Suppress Alarms": "Yes", "Owner": "arjun.mehta", "Approver": "grace.holm", "Approved At": daysAgo(2), "Customer Impact Expected": "No",
  "Rollback Plan": "Reinsert original card (serial retained on site)", "Timeline": JSON.stringify([{ at: daysAgo(3), event: "submitted" }, { at: daysAgo(2), event: "approved by grace.holm" }]), "Source System": "ticketing" });
add("changes", { "Change ID": "CHG-4415", "Title": "IOS-XR upgrade AGG-STP-02", "Change Type": "Normal", "State": "Scheduled", "Risk": "High", "Risk Score": "71",
  "Risk Factors": JSON.stringify(["AGG-STP-02 carries 6 cell sites + PSAP secondary", "reboot > 8 min"]), "Affected Resource IDs": "AGG-STP-02", "Window Start": "2026-10-02T07:00:00Z", "Window End": "2026-10-02T09:00:00Z",
  "Suppress Alarms": "Yes", "Owner": "arjun.mehta", "Approver": "grace.holm", "Approved At": daysAgo(1), "Customer Impact Expected": "Yes", "Rollback Plan": "Boot previous image from disk0 (tested in lab)", "Source System": "ticketing" });
add("changes", { "Change ID": "CHG-4391", "Title": "Splice closure re-seal I-94 km 9.4", "Change Type": "Normal", "State": "Completed", "Risk": "Low", "Risk Score": "22", "Affected Resource IDs": "FIB-MSP-STP-01",
  "Window Start": "2026-08-12T06:00:00Z", "Window End": "2026-08-12T08:00:00Z", "Suppress Alarms": "Yes", "Owner": "sam.lindqvist", "Approver": "grace.holm", "Implementation Result": "Successful", "Source System": "ticketing" });

// Runbooks
add("runbooks", { "Runbook ID": "RB-FIBER-CUT", "Title": "Fiber span down — isolate, dispatch, restore", "Version": "3", "Applies To Resource Types": "Fiber Span,Optical Port,Wavelength", "Applies To Alarm Types": "LOS,OMS-LOS,OCH-LOS",
  "Owner Team ID": "TEAM-TRANSPORT", "Requires Approval Steps": "4,6", "Steps": JSON.stringify([
    { n: 1, text: "Confirm LOS on BOTH terminating OTS ports (one-sided LOS points to a card/amp, not the span)." },
    { n: 2, text: "Check change calendar for work on the span or SRLG; check 811/locate tickets along the route." },
    { n: 3, text: "Run remote OTDR from the terminating ROADM to locate the break (distance from A end)." },
    { n: 4, text: "Dispatch fiber repair crew with OTDR distance, nearest hut and ROW permit. (APPROVAL: dispatch)" },
    { n: 5, text: "Verify protected traffic switched (APS) and IP rerouted; identify unprotected services for comms." },
    { n: 6, text: "If restoration > 2h, consider temporary reroute of priority circuits via ring (APPROVAL: config change)." },
    { n: 7, text: "After splice: confirm rx power within −3 dB of baseline on all channels; confirm OTU LOF cleared." },
    { n: 8, text: "Verify customer services (probes, RAN KPIs) — not just link state — before resolving." }]) });
add("runbooks", { "Runbook ID": "RB-CSR-HUNG", "Title": "Cell site router not recovering after backhaul restore", "Version": "2", "Applies To Resource Types": "Cell Site Router,gNodeB", "Applies To Alarm Types": "MGMT-UNREACHABLE,NG-LINK-FAIL",
  "Owner Team ID": "TEAM-RAN", "Requires Approval Steps": "3", "Steps": JSON.stringify([{ n: 1, text: "Check uplink optical levels from AGG side." }, { n: 2, text: "Attempt console access via OOB LTE modem." },
    { n: 3, text: "Remote power-cycle via smart PDU (APPROVAL: config change)" }, { n: 4, text: "If no OOB, dispatch for local reboot." }]) });
add("runbooks", { "Runbook ID": "RB-SITE-POWER", "Title": "Cell site on battery / commercial power loss", "Version": "4", "Applies To Resource Types": "Power Plant", "Applies To Alarm Types": "MAINS-FAIL,RECTIFIER-FAIL",
  "Owner Team ID": "TEAM-FIELD-EAST", "Requires Approval Steps": "2", "Steps": JSON.stringify([{ n: 1, text: "Check battery runtime remaining vs utility ETR." }, { n: 2, text: "Dispatch portable generator if runtime < ETR (APPROVAL: dispatch)" }]) });

// Parts
for (const [id, nm, depot, qty] of [["PRT-SPLICE-144", "144F splice closure kit", "SITE-DEPOT-EAST", 6], ["PRT-FIBER-288-1KM", "288F ULL cable (1 km reel)", "SITE-DEPOT-EAST", 3],
  ["PRT-OTDR-KIT", "OTDR + fusion splicer kit", "SITE-DEPOT-EAST", 2], ["PRT-NCS540-PSU", "NCS 540 power supply", "SITE-DEPOT-EAST", 4], ["PRT-SFP-10G-LR", "SFP+ 10G LR", "SITE-DEPOT-EAST", 20]])
  add("parts", { "Part ID": id, "Name": nm, "Depot": depot, "Qty On Hand": String(qty), "Qty Reserved": "0", "Unit": "ea", "Source System": "erp", "Last Seen At": daysAgo(0.2), "Confidence": "0.99" });

// Integration sources (freshness)
const INTEG = [["optical-ems", "Optical EMS (DWDM)", "Monitoring", "Webhook", "Healthy", 0.002, 5], ["ip-nms", "IP/MPLS NMS", "Monitoring", "Webhook", "Healthy", 0.001, 5],
  ["ran-oss", "RAN OSS", "Monitoring", "Webhook", "Healthy", 0.003, 5], ["mom-sentinel", "Manager-of-managers", "Monitoring", "Webhook", "Healthy", 0.002, 5],
  ["power-bms", "Site power BMS", "Monitoring", "Poll", "Degraded", 0.04, 15], ["netinv-a", "Network inventory", "Network Inventory", "Batch", "Healthy", 0.4, 1440],
  ["svcinv", "Service inventory", "Service Inventory", "Batch", "Healthy", 0.4, 1440], ["discovery-lldp", "Topology discovery (LLDP/ISIS)", "Network Inventory", "Poll", "Healthy", 0.1, 240],
  ["bss", "Billing / subscriptions", "OSS/BSS", "Batch", "Healthy", 0.5, 1440], ["crm", "CRM (accounts & contacts)", "CRM", "Batch", "Healthy", 0.6, 1440],
  ["gis", "GIS (sites, routes)", "GIS", "Batch", "Degraded", 3.1, 1440], ["ticketing", "Change & ticketing", "Ticketing", "Webhook", "Healthy", 0.01, 30],
  ["wfm", "Workforce management", "Workforce", "Webhook", "Not Configured", null, 30], ["notify-gw", "Notification gateway", "Notification", "Webhook", "Not Configured", null, 5]];
for (const [id, nm, type, mode, st, ago, sla] of INTEG) add("integrations", { "Source ID": id, "Name": nm, "Source Type": type, "Mode": mode, "Status": st,
  "Last Success At": ago == null ? "" : `RELATIVE:-${Math.round(ago * 1440)}`, "Last Error": st === "Degraded" ? (id === "gis" ? "Nightly export failed 3 runs: SFTP auth expired" : "Poll timeouts on 4/61 sites") : st === "Not Configured" ? "No connection configured in pilot — Kinetic is system of record for this function" : "",
  "Freshness SLA Minutes": String(sla), "Records Last Run": String(Math.floor(rand() * 900) + 20), "Endpoint": `connection:${id}`, "Authority": type === "Network Inventory" ? "resources,relationships" : type === "Service Inventory" ? "service-instances" : "" });

// History: prior incidents for recurrence detection + eval
const HIST = [
  ["INC-20260612-0003", "Fiber span FIB-MSP-STP-01 down — construction dig I-94 km 6.1", "FIB-MSP-STP-01", "Backhoe cut during MnDOT sound-wall work (locate ticket mis-marked)", 107, "P1"],
  ["INC-20260811-0007", "Fiber span FIB-MSP-STP-01 degraded — water ingress splice km 9.4", "FIB-MSP-STP-01", "Water ingress in splice closure at km 9.4 raised loss 6 dB", 214, "P2"],
  ["INC-20260719-0002", "Commercial power loss SITE-STP-C04 — battery exhausted", "PWR-STP-C04", "Xcel feeder outage 3h10m; 2h battery exhausted", 96, "P2"],
  ["INC-20260903-0011", "AGG-MSP-01 Te0/0/0/14 flapping — dirty optic", "AGG-MSP-01/Te0/0/0/14", "Contaminated connector; cleaned", 41, "P4"],
  ["INC-20260826-0004", "Duluth hub high temperature — HVAC unit 2 failed", "PWR-DLH-HUB1", "HVAC compressor failure", 380, "P3"],
];
for (const [id, title, root, cause, mins, pri] of HIST) {
  const det = id.slice(4, 12), d = `${det.slice(0, 4)}-${det.slice(4, 6)}-${det.slice(6, 8)}T14:05:00Z`, end = iso(new Date(d).getTime() + mins * 60000);
  add("incidents", { "Incident ID": id, "Title": title, "State": "Closed", "Priority": pri, "Major Incident": pri === "P1" ? "Yes" : "No", "Owner": "noc.borealis", "Owner Team ID": "TEAM-TRANSPORT",
    "Root Resource ID": root, "Observed Root Cause": cause, "Cause Confirmed By": "tech.borealis", "Detected At": d, "Acknowledged At": iso(new Date(d).getTime() + 240000), "Network Recovered At": end,
    "Service Recovered At": iso(new Date(end).getTime() + 600000), "Verification State": "Passed", "Resolved At": iso(new Date(end).getTime() + 900000), "Closed At": iso(new Date(end).getTime() + 86400000),
    "Comms State": pri <= "P2" ? "Sent" : "Not Required", "Region ID": "RGN-NC", "Market ID": root.includes("DLH") ? "MKT-DLH" : "MKT-MSP", "Problem ID": root === "FIB-MSP-STP-01" ? "PRB-0012" : "",
    "Impact Summary": JSON.stringify({ historical: true }), "Customers Affected": String(root === "FIB-MSP-STP-01" ? 14 : 1), "Services Affected": String(root === "FIB-MSP-STP-01" ? 19 : 1) });
}
add("problems", { "Problem ID": "PRB-0012", "Title": "Recurring outages on I-94 span FIB-MSP-STP-01", "State": "Investigating", "Related Incident IDs": "INC-20260612-0003,INC-20260811-0007", "Resource IDs": "FIB-MSP-STP-01",
  "Root Cause": "Span shares a construction-heavy corridor; AGG-STP-01 single-homed on it", "Workaround": "None — AGG-STP-01 has no diverse uplink", "Known Error": "No", "Owner": "owner.borealis", "PIR Due At": "2026-10-15T00:00:00Z" });

// Tenant 2 — Prairie (isolation proof)
const P = (v) => ({ "Tenant ID": "prairie", ...v });
out.sites.push(P({ "Site ID": "SITE-FGO-HUB1", "Name": "Fargo Hub", "Site Type": "Hub", "Market ID": "MKT-FGO", "Region ID": "RGN-NC", "Latitude": "46.8772", "Longitude": "-96.7898", "City": "Fargo", "State": "ND", "Lifecycle": "Active", "Source System": "prairie-inv" }));
out.resources.push(P({ "Resource ID": "FIB-FGO-GFK-01", "Name": "Fargo–Grand Forks span", "Resource Class": "Physical", "Resource Type": "Fiber Span", "A Site ID": "SITE-FGO-HUB1", "Health": "Down", "Oper State": "Down", "Lifecycle": "Active", "Source System": "prairie-inv" }));
out.customers.push(P({ "Account ID": "ACCT-P-01", "Name": "Red River Ag Co-op", "Segment": "Enterprise", "Tier": "Gold", "Public Safety": "No", "Status": "Active" }));
out.incidents.push(P({ "Incident ID": "INC-P-20260927-0001", "Title": "Prairie: Fargo–Grand Forks span LOS", "State": "In Progress", "Priority": "P2", "Owner": "noc.prairie", "Root Resource ID": "FIB-FGO-GFK-01", "Detected At": "2026-09-27T09:12:00Z", "Verification State": "Not Started", "Comms State": "None", "Major Incident": "No" }));

// Baseline healthy metrics for monitored services (the "before" picture)
for (const [svc] of ENT) for (const [m, val, unit] of [["packet_loss_pct", "0.0", "%"], ["latency_ms", "2.1", "ms"]])
  add("metrics", { "Observation ID": `OBS-B-${h(svc + m).slice(0, 10)}`, "Subject ID": svc, "Metric": m, "Value": val, "Unit": unit, "Original Value": val, "Original Unit": unit, "Observed At": "RELATIVE:-30", "Source System": "twamp-probe", "Quality": "Good" });
for (const c of cellInfo) add("metrics", { "Observation ID": `OBS-B-${h(c.gnb).slice(0, 10)}`, "Subject ID": `SVC-RAN-STP-C${c.n}`, "Metric": "availability_pct", "Value": "100", "Unit": "%", "Original Value": "1.0", "Original Unit": "ratio", "Observed At": "RELATIVE:-30", "Source System": "ran-oss", "Quality": "Good" });

fs.writeFileSync(path.join(DIR, "reference.json"), JSON.stringify(out, null, 1));
const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
console.log("reference.json", counts, "total", Object.values(counts).reduce((a, b) => a + b, 0));

// ═══════════════════ Scenario: fiber cut ═══════════════════
// Events carry offsets (seconds from cut). The replay tool maps offset → absolute UTC at send time.
const ev = []; let seq = 0;
const E = (src, off, ref, cond, vsev, o = {}) => { const id = o.id || `${src.toUpperCase().slice(0, 3)}-${771000 + (++seq)}`; ev.push({ phase: o.phase || "cut", offset: off, source: src, sourceEventId: id, resourceRef: ref, condition: cond, vendorSeverity: vsev, state: o.state || "raise", relatedResourceRef: o.rel || null, text: o.text || cond, sendLast: !!o.late, eventTimeOverride: o.future ? "FUTURE+600" : null, malformed: o.malformed || null, partition: o.partition || `${ref}|${cond}` }); return id; };
// Optical layer (optical-ems)
E("optical-ems", 0, "ROADM-MSP-01:OTS-2", "LOS", "CR", { text: "OTS LOS — no input power (east degree)" });
E("optical-ems", 1, "ROADM-STP-02:OTS-1", "LOS", "CR", { text: "OTS LOS — no input power (west degree)" });
E("optical-ems", 2, "ROADM-MSP-01:OTS-2", "OMS-LOS", "MJ"); E("optical-ems", 2, "ROADM-STP-02:OTS-1", "OMS-LOS", "MJ");
for (let c = 1; c <= 8; c++) { const ch = 20 + c;
  E("optical-ems", 3, `ROADM-MSP-01:CH-C${ch}`, "OCH-LOS", "MJ"); E("optical-ems", 3, `ROADM-STP-02:CH-C${ch}`, "OCH-LOS", "MJ");
  for (const tp of ["MSP-TP-01", "STP-TP-02"]) { E("optical-ems", 4, `${tp}:OTU4-${c}`, "OTU-LOF", "CR"); E("optical-ems", 5, `${tp}:OTU4-${c}`, "ODU-AIS", "MN"); E("optical-ems", 6, `${tp}:OTU4-${c}`, "OTU-BDI", "MN"); } }
E("optical-ems", 8, "OTU-STP-MSP-2P", "APS-SW", "WR", { text: "Switched to protect path via BLN/MTK" }); E("optical-ems", 8, "OTU-STP-MSP-5P", "APS-SW", "WR", { text: "1+1 switched to protect" });
E("optical-ems", 9, "ROADM-STP-02:OSC-9", "LOS", "MN", { text: "OSC channel LOS (AID not in inventory → parent match)" });
// IP layer (ip-nms syslog) + MoM duplicates
const ip = (off, ref, cond, sev, o) => { E("ip-nms", off, ref, cond, sev, o); };
ip(4, "agg-stp-01.borealis.net|Hu0/0/0/0", "%LINK-3-UPDOWN", "3"); ip(4, "cr-msp-01.borealis.net|Hu0/0/0/5", "%LINK-3-UPDOWN", "3");
ip(4, "agg-stp-02.borealis.net|Hu0/0/0/0", "%LINK-3-UPDOWN", "3"); ip(4, "cr-msp-01.borealis.net|Hu0/0/0/6", "%LINK-3-UPDOWN", "3");
ip(4, "cr-msp-01.borealis.net|Hu0/0/1/0", "%LINK-3-UPDOWN", "3"); ip(4, "cr-stp-01.borealis.net|Hu0/0/1/0", "%LINK-3-UPDOWN", "3");
ip(6, "agg-stp-01.borealis.net", "%BGP-5-ADJCHANGE", "5", { text: "neighbor 10.20.0.1 Down (hold timer expired)" }); ip(6, "agg-stp-01.borealis.net", "%ISIS-5-ADJCHANGE", "5");
ip(7, "cr-stp-01.borealis.net", "%ISIS-5-ADJCHANGE", "5", { text: "adjacency to cr-msp-01 down — rerouted via BLN" });
ip(9, "agg-stp-01.borealis.net", "MGMT-UNREACH", "2", { text: "AGG-STP-01 in-band management unreachable" });
for (const [svc, , , , , , , mon] of ENT) { if (svc === "SVC-DIA-10479" || svc === "SVC-PSAP-30001" || mon === "None") continue; ip(12 + (seq % 20), `cpe-${svc.split("-").pop()}.borealis.net`, "ICMP-UNREACH", "2", { text: "CPE loopback unreachable (5/5 probes)" }); }
for (const c of cellInfo) {
  if (c.agg !== "AGG-STP-01") continue;
  if (c.i >= 9 && c.i <= 11) { ip(14, `csr-stp-c${c.n}.borealis.net|Te0/0/0/0`, "%LINK-3-UPDOWN", "3"); ip(15, `csr-stp-c${c.n}.borealis.net`, "%MW-4-SWITCHOVER", "4", { text: "backhaul switched to microwave (capacity 1G→400M)" }); continue; }
  ip(14, `csr-stp-c${c.n}.borealis.net|Te0/0/0/0`, "%LINK-3-UPDOWN", "3"); ip(15, `csr-stp-c${c.n}.borealis.net`, "%BFD-6-SESSION_DOWN", "3"); ip(40, `csr-stp-c${c.n}.borealis.net`, "MGMT-UNREACH", "2");
}
// Manager-of-managers re-forwards IP alarms with its own IDs/format (cross-source duplicates)
for (const [host, ifn] of [["agg-stp-01", "Hu0/0/0/0"], ["cr-msp-01", "Hu0/0/0/5"], ["agg-stp-02", "Hu0/0/0/0"], ["cr-msp-01", "Hu0/0/0/6"], ["cr-msp-01", "Hu0/0/1/0"], ["cr-stp-01", "Hu0/0/1/0"]]) E("mom-sentinel", 20, `${host}/${ifn}`, "LinkDown", "P2");
E("mom-sentinel", 21, "agg-stp-01", "BgpPeerDown", "P3"); E("mom-sentinel", 22, "agg-stp-01", "NodeUnreachable", "P1");
for (const c of cellInfo) if (c.agg === "AGG-STP-01" && !(c.i >= 9 && c.i <= 11)) E("mom-sentinel", 45, `csr-stp-c${c.n}`, "NodeUnreachable", "P1");
for (const [svc, , , , , , , mon] of ENT) { if (svc === "SVC-DIA-10479" || svc === "SVC-PSAP-30001" || mon === "None") continue; E("mom-sentinel", 30, `cpe-${svc.split("-").pop()}`, "CpeDown", "P1"); }
// RAN (ran-oss)
for (const c of cellInfo) {
  const g = `gNB-STP-C${c.n}`;
  if (c.agg === "AGG-STP-01" && !(c.i >= 9 && c.i <= 11)) {
    E("ran-oss", 18, g, "NG link failure", "critical"); E("ran-oss", 19, g, "PTP sync loss", "major"); E("ran-oss", 60, g, "Heartbeat failure", "major");
    for (let k = 1; k <= 3; k++) E("ran-oss", 25, `${g}:cell-${k}`, "Cell out of service", "critical");
    const peers = cellInfo.filter((p) => p.n !== c.n && Math.abs(p.i - c.i) <= 1);
    for (const p of peers.slice(0, 2)) E("ran-oss", 20, g, "X2 link failure", "major", { rel: `gNB-STP-C${p.n}`, partition: `${g}|X2|${p.n}` });
  }
}
// Neighbours on AGG-STP-02 report X2 failure toward the down sites (explained via related resource)
for (const [a, b] of [["13", "09"], ["14", "08"], ["16", "07"], ["17", "06"], ["18", "05"], ["15", "04"]]) E("ran-oss", 21, `gNB-STP-C${a}`, "X2 link failure", "minor", { rel: `gNB-STP-C${b}`, partition: `x2-${a}-${b}` });
// Resyncs: EMS + RAN periodically re-send active criticals with NEW event IDs (→ occurrence count, not new alarms)
const crit = ev.filter((e) => e.phase === "cut" && ["CR", "critical"].includes(e.vendorSeverity) && ["optical-ems", "ran-oss"].includes(e.source));
for (const e of crit) E(e.source, 150, e.resourceRef, e.condition, e.vendorSeverity, { text: "resync", partition: e.partition });
for (const e of crit.slice(0, 20)) E(e.source, 220, e.resourceRef, e.condition, e.vendorSeverity, { text: "resync", partition: e.partition });
// Exact retransmits (same sourceEventId) → idempotency
const retx = ev.filter((e) => e.phase === "cut" && e.source === "ip-nms").slice(0, 10);
for (const e of retx) ev.push({ ...e, offset: e.offset + 3, text: "retransmit" });
// Unrelated noise + maintenance + data-quality cases
E("power-bms", 30, "SITE-DLH-HUB1-PWR", "HIGH_TEMP", "WARN", { text: "Room temp 29.4C (threshold 28C)" });
E("power-bms", 44, "SITE-RST-HUB1-PWR", "RECT_FAIL", "ALARM", { text: "Rectifier module 3 failed (N+1 remaining)" });
for (let k = 0; k < 4; k++) E("ip-nms", 10 + k * 40, "agg-msp-01.borealis.net|Te0/0/0/14", "%IF-FLAP", "4", { text: `flap ${k + 1}` });
for (const [off, cond] of [[5, "CARD-FAIL"], [6, "LOS"], [7, "OMS-LOS"]]) E("optical-ems", off, "ROADM-BLN-03:SLOT-7", cond, "MJ", { text: "card pulled under CHG-4410" });
E("ran-oss", 26, "gNB-STP-C02:cell-4", "Cell out of service", "P0-EMERGENCY", { text: "unknown severity + unknown sector (data quality)" });
E("optical-ems", 27, "ROADM-STP-02:OTS-1", "LOS", "CR", { future: true, text: "NE clock 10 min fast (skew)" });
E("ip-nms", 3, "csr-stp-c02.borealis.net|Te0/0/0/0", "%LINK-3-UPDOWN", "3", { late: true, id: "IPN-LATE-001", text: "buffered at collector, delivered late" });
E("ip-nms", 31, "", "%LINK-3-UPDOWN", "3", { malformed: "missing resourceRef", text: "malformed — no resource" });
E("optical-ems", 32, "ROADM-MSP-01:OTS-2", "LOS", "CR", { malformed: "missing eventTime", text: "malformed — no event time" });

// ── Restore phase (after splice): clears for everything active, EXCEPT C07's CSR + gNB (hung) ──
const cutKeys = new Map();
for (const e of ev) if (e.phase === "cut" && !e.malformed && e.resourceRef && e.source !== "power-bms" && !e.resourceRef.includes("BLN-03") && !e.resourceRef.includes("agg-msp-01") && !e.eventTimeOverride && e.vendorSeverity !== "P0-EMERGENCY")
  cutKeys.set(`${e.source}|${e.resourceRef}|${e.condition}|${e.relatedResourceRef || ""}`, e);
let rseq = 0;
const clearSev = { "optical-ems": "CL", "ip-nms": "5", "ran-oss": "cleared", "mom-sentinel": "P4", "power-bms": "OK" };
const hung = (ref) => /c07/i.test(ref) && !/Te0\/0\/0\/0/.test(ref);
for (const e of cutKeys.values()) {
  if (hung(e.resourceRef)) continue;
  ev.push({ phase: "restore", offset: 5 + (rseq++ % 40), source: e.source, sourceEventId: `${e.source.slice(0, 3).toUpperCase()}-CLR-${h(e.sourceEventId + e.resourceRef).slice(0, 8)}`, resourceRef: e.resourceRef, condition: e.condition,
    vendorSeverity: clearSev[e.source], state: "clear", relatedResourceRef: e.relatedResourceRef, text: "cleared", partition: e.partition });
}
// the data-quality alarm (unknown sector on C02) is cleared by RAN OSS after the cell restart
ev.push({ phase: "restore", offset: 12, source: "ran-oss", sourceEventId: "RAN-CLR-C02-S4", resourceRef: "gNB-STP-C02:cell-4", condition: "Cell out of service", vendorSeverity: "cleared", state: "clear", text: "cleared", partition: "gNB-STP-C02:cell-4|Cell out of service" });
// out-of-order: a clear whose raise never arrived (orphan) + a clear delivered before its raise in the reboot phase
ev.push({ phase: "restore", offset: 2, source: "ran-oss", sourceEventId: "RAN-CLR-ORPHAN-1", resourceRef: "gNB-STP-C07:cell-2", condition: "Cell out of service", vendorSeverity: "cleared", state: "clear", text: "spurious clear from cell restart", partition: "gNB-STP-C07:cell-2|Cell out of service" });
// ── Reboot phase: C07 CSR remote power-cycle → remaining clears ──
for (const e of cutKeys.values()) if (hung(e.resourceRef))
  ev.push({ phase: "reboot", offset: 5 + (rseq++ % 20), source: e.source, sourceEventId: `${e.source.slice(0, 3).toUpperCase()}-CLR-${h(e.sourceEventId + e.resourceRef).slice(0, 8)}`, resourceRef: e.resourceRef, condition: e.condition,
    vendorSeverity: clearSev[e.source], state: "clear", relatedResourceRef: e.relatedResourceRef, text: "cleared after CSR power-cycle", partition: e.partition });

// Metrics per phase (probe + RAN KPI). Units deliberately mixed to exercise normalization.
const metrics = { cut: [], restore: [], reboot: [] };
const probeSvcs = ENT.filter((x) => x[7] === "Active Probe").map((x) => x[0]);
for (const svc of probeSvcs) {
  const down = !["SVC-DIA-10479", "SVC-PSAP-30001"].includes(svc);
  metrics.cut.push({ subject: svc, metric: "packet_loss_pct", value: down ? 1.0 : 0, unit: "ratio", source: "twamp-probe" });
  metrics.restore.push({ subject: svc, metric: "packet_loss_pct", value: 0, unit: "%", source: "twamp-probe" }, { subject: svc, metric: "latency_ms", value: 2300, unit: "us", source: "twamp-probe" });
}
metrics.cut.push({ subject: "SVC-DCI-40010", metric: "packet_loss_pct", value: 0.0001, unit: "ratio", source: "twamp-probe" }, { subject: "SVC-DCI-40010", metric: "latency_ms", value: 0.41, unit: "ms", source: "twamp-probe" });
metrics.restore.push({ subject: "SVC-DCI-40010", metric: "packet_loss_pct", value: 0, unit: "%", source: "twamp-probe" });
for (const c of cellInfo) {
  const down = c.agg === "AGG-STP-01" && !(c.i >= 9 && c.i <= 11);
  metrics.cut.push({ subject: `SVC-RAN-STP-C${c.n}`, metric: "availability_pct", value: down ? 0 : 1, unit: "ratio", source: "ran-oss" });
  metrics.restore.push({ subject: `SVC-RAN-STP-C${c.n}`, metric: "availability_pct", value: c.n === "07" ? 0 : 100, unit: "%", source: "ran-oss" });
  if (c.n === "07") metrics.reboot.push({ subject: `SVC-RAN-STP-C${c.n}`, metric: "availability_pct", value: 99.7, unit: "%", source: "ran-oss" });
}

// Ground truth for tests / eval
const downRan = cellInfo.filter((c) => c.agg === "AGG-STP-01" && !(c.i >= 9 && c.i <= 11)).map((c) => `SVC-RAN-STP-C${c.n}`);
const truth = {
  rootResource: "FIB-MSP-STP-01",
  mustNotCorrelate: ["SITE-DLH-HUB1-PWR", "SITE-RST-HUB1-PWR", "agg-msp-01.borealis.net|Te0/0/0/14"],
  suppressed: ["ROADM-BLN-03:SLOT-7"],
  impacted: {
    down: [...downRan, "SVC-DIA-10442", "SVC-DIA-10451", "SVC-EVPL-20117", "SVC-DIA-10467", "SVC-EVPL-20124", "SVC-DIA-10488", "SVC-WAVE-3001"],
    confirmed: [...downRan, "SVC-DIA-10442", "SVC-DIA-10451", "SVC-EVPL-20117", "SVC-EVPL-20124", "SVC-DIA-10488", "SVC-WAVE-3001"],
    inferred: ["SVC-DIA-10467"],
    potential: ["SVC-RAN-STP-C10", "SVC-RAN-STP-C11", "SVC-RAN-STP-C12", "SVC-RAN-STP-C13", "SVC-RAN-STP-C14", "SVC-RAN-STP-C15", "SVC-RAN-STP-C16", "SVC-RAN-STP-C17", "SVC-RAN-STP-C18",
      "SVC-PSAP-30001", "SVC-DCI-40010", "SVC-DIA-10479"],
    notImpacted: ["SVC-DIA-10501", "SVC-DIA-10502", "SVC-EVPL-20190", "SVC-RAN-MSP-C01"],
  },
  publicSafetyAccounts: ["East Metro Public Safety Radio", "Ramsey East 911 PSAP"],
  hungAfterRestore: ["SVC-RAN-STP-C07"],
};
const counts2 = ev.reduce((m, e) => ((m[e.phase] = (m[e.phase] || 0) + 1), m), {});
fs.writeFileSync(path.join(DIR, "scenario-fiber-cut.json"), JSON.stringify({ name: "I-94 fiber cut", events: ev, metrics, truth }, null, 1));
console.log("scenario events by phase", counts2, "metrics", Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, v.length])));
