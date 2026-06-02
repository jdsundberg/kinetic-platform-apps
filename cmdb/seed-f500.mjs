#!/usr/bin/env node
/**
 * Seed ~100,000 Fortune-500-style CIs into the CMDB on ai-labs.kinopsdev.io.
 *
 * Company model: large financial-services firm "Apex Financial".
 *   • 10 lines of business (LOBs)
 *   • 6 environments (Prod, DR, Staging, UAT, Dev, Sandbox)
 *   • 40 locations (8 on-prem datacenters + AWS/Azure/GCP regions + 20 cloud accounts)
 *   • Multiple vendors, OS, and tech stacks
 *
 * Distribution (sums to 100,000):
 *   datacenters       40
 *   clusters         600
 *   servers       55,000
 *   network-devices 6,000
 *   storage        2,000
 *   databases      3,500
 *   applications  28,000
 *   services       4,860
 *
 * Strategy for speed:
 *   1. Drop custom indexes on each form (keep 5 system indexes).
 *   2. Spawn one worker pool per form so all forms ingest in parallel.
 *   3. Restore index definitions and trigger "Build Index" at the end.
 *
 * Usage:
 *   node apps/cmdb/seed-f500.mjs [--concurrency 20] [--per-form-workers 10] [--dry-run]
 *
 * Estimated wall time on ai-labs with custom indexes dropped: 25–40 minutes.
 */
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const args = process.argv.slice(2);
function flag(name) { return args.includes("--" + name); }
function arg(name, dflt) { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : dflt; }

const SERVER = arg("server", "https://ai-labs.kinopsdev.io");
const USER = arg("user", "john");
const PASS = arg("pass", "john7");
const KAPP = "cmdb";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const PER_FORM_WORKERS = parseInt(arg("per-form-workers", "10"), 10);
const DRY_RUN = flag("dry-run");
const SKIP_INDEX = flag("keep-indexes");

const __dir = path.dirname(new URL(import.meta.url).pathname);
const APP_DEF = JSON.parse(fs.readFileSync(path.join(__dir, "app.json"), "utf-8"));

// ─── Deterministic RNG for reproducible runs ────────────────────────────
let _s = 0x1f2e3d;
function rand() { _s = (_s * 16807) % 2147483647; return _s / 2147483647; }
function pick(a) { return a[Math.floor(rand() * a.length)]; }
function pickWeighted(arr) {
  // arr: [[item, weight], ...]
  const total = arr.reduce((s, x) => s + x[1], 0);
  let r = rand() * total;
  for (const [item, w] of arr) { r -= w; if (r <= 0) return item; }
  return arr[arr.length - 1][0];
}
function pad(n, w = 6) { return String(n).padStart(w, "0"); }
function iso(daysAgo = 0) { return new Date(Date.now() - daysAgo * 86400000).toISOString(); }

// ─── Apex Financial company model ───────────────────────────────────────
const COMPANY = "apex";
const LOBS = [
  { code: "rb",   name: "Retail Banking",       team: "Retail Banking Eng" },
  { code: "wm",   name: "Wealth Management",    team: "Wealth Eng" },
  { code: "ib",   name: "Investment Banking",   team: "IB Tech" },
  { code: "cc",   name: "Card Services",        team: "Card Tech" },
  { code: "mg",   name: "Mortgage",             team: "Mortgage Tech" },
  { code: "ins",  name: "Insurance",            team: "Insurance Tech" },
  { code: "cm",   name: "Capital Markets",      team: "Markets Tech" },
  { code: "tr",   name: "Treasury",             team: "Treasury Tech" },
  { code: "risk", name: "Compliance & Risk",    team: "Risk Tech" },
  { code: "corp", name: "Corporate IT",         team: "Platform Eng" },
];
const ENVS = [
  { name: "Production", code: "prod", weight: 35 },
  { name: "DR",         code: "dr",   weight: 18 },
  { name: "Staging",    code: "stg",  weight: 12 },
  { name: "UAT",        code: "uat",  weight: 10 },
  { name: "Development",code: "dev",  weight: 15 },
  { name: "Sandbox",    code: "sbx",  weight: 10 },
];
const ENV_WEIGHTED = ENVS.map(e => [e.name, e.weight]);

// Datacenters: 8 on-prem + 32 cloud regions/accounts = 40
const DATACENTERS = [
  // On-prem (8)
  { code: "CLT01", name: "Charlotte-Primary",    type: "Physical",     provider: "On-Prem", region: "us-east", city: "Charlotte", country: "USA", tier: "Tier 4" },
  { code: "CLT02", name: "Charlotte-Secondary",  type: "Physical",     provider: "On-Prem", region: "us-east", city: "Charlotte", country: "USA", tier: "Tier 3" },
  { code: "PLN01", name: "Plano-Primary",         type: "Physical",     provider: "On-Prem", region: "us-south", city: "Plano",    country: "USA", tier: "Tier 4" },
  { code: "NYC01", name: "NYC-Manhattan",          type: "Physical",     provider: "On-Prem", region: "us-east", city: "New York", country: "USA", tier: "Tier 4" },
  { code: "CHI01", name: "Chicago-Aurora",         type: "Physical",     provider: "On-Prem", region: "us-central", city: "Aurora", country: "USA", tier: "Tier 3" },
  { code: "LDN01", name: "London-Slough",          type: "Physical",     provider: "On-Prem", region: "emea", city: "Slough",     country: "UK",  tier: "Tier 3" },
  { code: "SGP01", name: "Singapore-DC",           type: "Physical",     provider: "On-Prem", region: "apac", city: "Singapore",   country: "Singapore", tier: "Tier 3" },
  { code: "HKG01", name: "Hong Kong-DC",           type: "Physical",     provider: "On-Prem", region: "apac", city: "Hong Kong",   country: "China", tier: "Tier 3" },
  // AWS regions (8)
  ...["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1", "ap-northeast-1", "ca-central-1"].map(r => (
    { code: `AWS-${r.toUpperCase()}`, name: `AWS-${r}`, type: "Cloud Region", provider: "AWS", region: r, city: r, country: r.startsWith("eu") ? "EU" : r.startsWith("ap") ? "APAC" : "USA", tier: "Tier 3" }
  )),
  // Azure regions (6)
  ...["eastus", "eastus2", "westus2", "westeurope", "northeurope", "southeastasia"].map(r => (
    { code: `AZ-${r.toUpperCase()}`, name: `Azure-${r}`, type: "Cloud Region", provider: "Azure", region: r, city: r, country: r.includes("eu") ? "EU" : r.includes("asia") ? "APAC" : "USA", tier: "Tier 3" }
  )),
  // GCP regions (3)
  ...["us-central1", "us-east1", "europe-west2"].map(r => (
    { code: `GCP-${r.toUpperCase()}`, name: `GCP-${r}`, type: "Cloud Region", provider: "GCP", region: r, city: r, country: r.includes("europe") ? "EU" : "USA", tier: "Tier 3" }
  )),
  // Cloud accounts per LOB (15)
  ...LOBS.slice(0, 5).flatMap(lob => [
    { code: `AWS-${lob.code.toUpperCase()}-PROD`, name: `AWS-${lob.code}-prod`, type: "Cloud Account", provider: "AWS", region: "multi", city: "multi", country: "multi", tier: "Tier 3" },
    { code: `AZ-${lob.code.toUpperCase()}-PROD`, name: `Azure-${lob.code}-prod`, type: "Cloud Account", provider: "Azure", region: "multi", city: "multi", country: "multi", tier: "Tier 3" },
    { code: `AWS-${lob.code.toUpperCase()}-NONPROD`, name: `AWS-${lob.code}-nonprod`, type: "Cloud Account", provider: "AWS", region: "multi", city: "multi", country: "multi", tier: "Tier 3" },
  ]),
];

// ─── HTTP helpers ───────────────────────────────────────────────────────
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`/app/api/v1${p}`, SERVER);
    const headers = { "Content-Type": "application/json", Authorization: AUTH };
    const payload = body ? JSON.stringify(body) : null;
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
    const r = https.request(u, { method, headers, agent: keepAliveAgent }, (res) => {
      const c = []; res.on("data", x => c.push(x));
      res.on("end", () => { const t = Buffer.concat(c).toString(); try { resolve({ status: res.statusCode, data: JSON.parse(t) }); } catch { resolve({ status: res.statusCode, data: t }); } });
    });
    r.on("error", e => resolve({ status: 0, error: e.message }));
    if (payload) r.write(payload);
    r.end();
  });
}
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 200 });

// ─── Index management ───────────────────────────────────────────────────
const SYS_IDX = [
  { name: "closedBy", parts: ["closedBy"], unique: false },
  { name: "createdBy", parts: ["createdBy"], unique: false },
  { name: "handle", parts: ["handle"], unique: true },
  { name: "submittedBy", parts: ["submittedBy"], unique: false },
  { name: "updatedBy", parts: ["updatedBy"], unique: false },
];
async function dropCustomIndexes(formSlug) {
  return req("PUT", `/kapps/${KAPP}/forms/${formSlug}`, { indexDefinitions: SYS_IDX });
}
async function restoreAndBuildIndexes(formSlug, indexes) {
  if (!indexes || (!indexes.single?.length && !indexes.compound?.length)) return { skipped: true };
  const idxDefs = [...SYS_IDX];
  const custom = [];
  for (const p of (indexes.single || [])) { idxDefs.push({ parts: [p], unique: false }); custom.push(p); }
  for (const ps of (indexes.compound || [])) { idxDefs.push({ parts: ps, unique: false }); custom.push(ps.join(",")); }
  await req("PUT", `/kapps/${KAPP}/forms/${formSlug}`, { indexDefinitions: idxDefs });
  return req("POST", `/kapps/${KAPP}/forms/${formSlug}/backgroundJobs`, { type: "Build Index", content: { indexes: custom } });
}

// ─── Generators per form ─────────────────────────────────────────────────
// Each generator yields one record at a time.

const DC_BY_PROV = {};

function* genDatacenters() {
  for (let i = 0; i < DATACENTERS.length; i++) {
    const d = DATACENTERS[i];
    const id = `F500-DC-${pad(i + 1, 3)}`;
    DC_BY_PROV[d.provider] = DC_BY_PROV[d.provider] || [];
    DC_BY_PROV[d.provider].push({ id, ...d });
    yield {
      "CI Number": id, "Name": d.name, "DC Type": d.type, "Provider": d.provider,
      "Region": d.region, "City": d.city, "Country": d.country, "Tier": d.tier,
      "Status": "Active", "Owner": "platform-eng",
      "Discovery Source": d.provider === "On-Prem" ? "Manual" : (d.provider === "AWS" ? "AWS Config" : d.provider === "Azure" ? "Azure Resource Graph" : "Manual"),
      "Description": `${d.name} — ${d.tier} ${d.type} (${d.provider})`,
    };
  }
}

function* genClusters(count) {
  const TYPES = [["Kubernetes", 5], ["Database", 2], ["Cache", 1], ["Messaging", 1], ["Compute", 1]];
  for (let i = 0; i < count; i++) {
    const lob = pick(LOBS);
    const env = pickWeighted(ENV_WEIGHTED);
    const t = pickWeighted(TYPES);
    const id = `F500-CLU-${pad(i + 1, 5)}`;
    const provider = pickWeighted([["AWS", 4], ["Azure", 2], ["GCP", 1], ["On-Prem", 1]]);
    yield {
      "CI Number": id,
      "Name": `${lob.code}-${t.toLowerCase()}-${pad(i + 1, 4)}`,
      "Cluster Type": t,
      "Version": pick(["1.27", "1.28", "1.29", "1.30", "PG15", "PG16", "7.2", "8.0", "3.6", "3.7"]),
      "Node Count": String(pick([3, 5, 7, 12, 15, 21, 30])),
      "Status": rand() < 0.97 ? "Active" : "Maintenance",
      "Environment": env, "Location": pick(DATACENTERS).code,
      "Owner": lob.team.toLowerCase().replace(/ /g, "-"),
      "Owner Team": lob.team,
      "Criticality": env === "Production" ? pickWeighted([["Critical", 5], ["High", 3], ["Medium", 1]]) : "Medium",
      "Discovery Source": t === "Kubernetes" ? "Kubernetes API" : (provider !== "On-Prem" ? `${provider} Config` : "Manual"),
      "Last Discovered": iso(Math.floor(rand() * 7)),
      "Description": `${t} cluster for ${lob.name} (${env})`,
    };
  }
}

const OS_LIST = [
  ["Ubuntu", "22.04 LTS", 6], ["Ubuntu", "20.04 LTS", 3], ["RHEL", "9.3", 4], ["RHEL", "8.10", 3],
  ["Amazon Linux", "2023", 5], ["Amazon Linux", "2", 2], ["Windows Server", "2022", 3], ["Windows Server", "2019", 2],
  ["CentOS", "7", 1], ["AIX", "7.2", 1],
];
const SRV_ROLES = ["web", "app", "api", "worker", "db", "cache", "queue", "proxy", "bastion", "etl", "ml", "search", "gw", "lb"];
function* genServers(count) {
  for (let i = 0; i < count; i++) {
    const lob = pick(LOBS);
    const env = pickWeighted(ENV_WEIGHTED);
    const role = pick(SRV_ROLES);
    const dc = pick(DATACENTERS);
    const [os, osVer, _] = pickWeighted(OS_LIST.map(o => [[o[0], o[1]], o[2]]));
    const id = `F500-SRV-${pad(i + 1, 6)}`;
    const oct2 = Math.floor(i / 65536) % 256;
    const oct3 = Math.floor(i / 256) % 256;
    const oct4 = i % 256;
    yield {
      "CI Number": id,
      "Name": `${lob.code}-${role}-${env.slice(0, 3).toLowerCase()}-${pad(i + 1, 6)}`,
      "FQDN": `${lob.code}-${role}-${pad(i + 1, 6)}.${env.toLowerCase()}.${COMPANY}.internal`,
      "IP Address": `${pickWeighted([["10", 70], ["172", 20], ["192", 10]])}.${oct2 || 1}.${oct3}.${oct4}`,
      "Status": rand() < 0.95 ? "Active" : (rand() < 0.4 ? "Maintenance" : "Retired"),
      "Environment": env, "Location": dc.code,
      "Owner": lob.team.toLowerCase().replace(/ /g, "-"),
      "Owner Team": lob.team,
      "Criticality": env === "Production" ? pickWeighted([["Critical", 4], ["High", 4], ["Medium", 2]]) : (env === "DR" ? "Critical" : "Medium"),
      "OS": os, "OS Version": osVer,
      "CPU Cores": String(pickWeighted([[2, 3], [4, 5], [8, 6], [16, 4], [32, 2], [64, 1], [128, 0.3]])),
      "RAM GB": String(pickWeighted([[8, 3], [16, 5], [32, 6], [64, 4], [128, 2], [256, 1], [512, 0.3]])),
      "Storage GB": String(pickWeighted([[100, 4], [250, 5], [500, 4], [1000, 3], [2000, 2], [4000, 1]])),
      "Virtual": dc.provider === "On-Prem" ? pick(["Yes", "No"]) : "Yes",
      "Hypervisor": dc.provider === "On-Prem" ? pick(["VMware vSphere", "Hyper-V", "Bare Metal"]) : `${dc.provider} ${pick(["EC2", "VM", "Compute"])}`,
      "Serial Number": `SN-${Math.floor(rand() * 1e12).toString(16).toUpperCase().slice(0, 12)}`,
      "Discovery Source": dc.provider === "On-Prem" ? "ServiceNow Discovery" : `${dc.provider} Config`,
      "Last Discovered": iso(Math.floor(rand() * 14)),
      "Description": `${role} server in ${lob.name} (${env})`,
    };
  }
}

const NET_TYPES = [
  { type: "Switch",        vendors: [["Cisco", "Nexus 9504"], ["Cisco", "Catalyst 9300"], ["Arista", "7280R3"]], weight: 4 },
  { type: "Router",        vendors: [["Cisco", "ASR 9006"], ["Juniper", "MX204"]], weight: 1 },
  { type: "Firewall",      vendors: [["Palo Alto", "PA-5260"], ["Palo Alto", "PA-3260"], ["Fortinet", "FortiGate 600F"]], weight: 2 },
  { type: "Load Balancer", vendors: [["F5", "BIG-IP i7800"], ["AWS", "ALB"], ["AWS", "NLB"], ["Azure", "Application Gateway"], ["Citrix", "ADC MPX"]], weight: 4 },
  { type: "NAT Gateway",   vendors: [["AWS", "NAT"], ["Azure", "NAT"]], weight: 1 },
  { type: "Transit Gateway", vendors: [["AWS", "TGW"], ["Azure", "vWAN"]], weight: 0.5 },
  { type: "VPN Gateway",   vendors: [["Cisco", "ASA 5585-X"], ["AWS", "VGW"]], weight: 0.5 },
];
function* genNetworkDevices(count) {
  const weighted = NET_TYPES.map(t => [t, t.weight]);
  for (let i = 0; i < count; i++) {
    const t = pickWeighted(weighted);
    const [vendor, model] = pick(t.vendors);
    const lob = pick(LOBS);
    const env = pickWeighted(ENV_WEIGHTED);
    const dc = pick(DATACENTERS);
    const id = `F500-NET-${pad(i + 1, 5)}`;
    yield {
      "CI Number": id,
      "Name": `${dc.code.toLowerCase()}-${t.type.toLowerCase().replace(/\s+/g, "")}-${pad(i + 1, 5)}`,
      "Device Type": t.type, "Vendor": vendor, "Model": model,
      "Management IP": `10.${250 + Math.floor(rand() * 5)}.${Math.floor(i / 256) % 256}.${i % 256}`,
      "Status": rand() < 0.98 ? "Active" : "Maintenance",
      "Environment": env, "Location": dc.code,
      "Owner": "network-ops", "Owner Team": "Network Operations",
      "Criticality": env === "Production" && (t.type === "Firewall" || t.type === "Load Balancer") ? "Critical" : "High",
      "OS Version": vendor === "AWS" || vendor === "Azure" ? "managed" : `v${pick(["16.12.04", "17.2.4", "20.4R3", "10.2.6"])}`,
      "Discovery Source": vendor === "AWS" ? "AWS Config" : vendor === "Azure" ? "Azure Resource Graph" : "ServiceNow Discovery",
      "Last Discovered": iso(Math.floor(rand() * 14)),
      "Description": `${t.type} — ${vendor} ${model} in ${env} (${dc.code})`,
    };
  }
}

function* genStorage(count) {
  const TYPES = [
    { type: "Object", vendors: [["AWS", "S3", "S3"], ["Azure", "Blob", "Azure Blob"], ["GCP", "GCS", "GCS"]], weight: 3 },
    { type: "Block",  vendors: [["AWS", "EBS", "EBS"], ["Azure", "Managed Disk", "Azure Disk"], ["GCP", "Persistent Disk", "PD"]], weight: 3 },
    { type: "NAS",    vendors: [["NetApp", "FAS9000", "NFSv4"], ["NetApp", "AFF A800", "NFSv4"], ["AWS", "EFS", "NFSv4"], ["Azure", "Files", "SMB"], ["Dell EMC", "Isilon F900", "NFSv4"]], weight: 2 },
    { type: "SAN",    vendors: [["Dell EMC", "PowerMax 8500", "FC"], ["IBM", "FlashSystem 9200", "FC"], ["HPE", "Primera A670", "FC"]], weight: 1 },
  ];
  const weighted = TYPES.map(t => [t, t.weight]);
  for (let i = 0; i < count; i++) {
    const t = pickWeighted(weighted);
    const [vendor, model, proto] = pick(t.vendors);
    const lob = pick(LOBS);
    const env = pickWeighted(ENV_WEIGHTED);
    const dc = pick(DATACENTERS);
    const cap = pickWeighted([[10, 4], [50, 3], [100, 3], [500, 2], [1000, 1], [5000, 0.5]]);
    yield {
      "CI Number": `F500-STO-${pad(i + 1, 5)}`,
      "Name": `${lob.code}-${t.type.toLowerCase()}-${pad(i + 1, 5)}`,
      "Storage Type": t.type, "Vendor": vendor,
      "Capacity TB": String(cap), "Used TB": String((cap * (0.2 + rand() * 0.6)).toFixed(1)),
      "Status": "Active", "Environment": env, "Location": dc.code,
      "Owner": "storage-team", "Owner Team": "Storage Engineering",
      "Criticality": env === "Production" ? "High" : "Medium",
      "Protocol": proto,
      "Discovery Source": vendor === "AWS" ? "AWS Config" : vendor === "Azure" ? "Azure Resource Graph" : "ServiceNow Discovery",
      "Last Discovered": iso(Math.floor(rand() * 14)),
      "Description": `${t.type} storage — ${vendor} ${model} for ${lob.name} (${env})`,
    };
  }
}

function* genDatabases(count) {
  const ENGINES = [
    { engine: "PostgreSQL", versions: ["14.10", "15.6", "16.2"], port: 5432, weight: 6 },
    { engine: "Oracle",     versions: ["19c", "21c"],            port: 1521, weight: 4 },
    { engine: "MS SQL",     versions: ["2019", "2022"],          port: 1433, weight: 4 },
    { engine: "MySQL",      versions: ["8.0.36", "5.7"],         port: 3306, weight: 2 },
    { engine: "MongoDB",    versions: ["6.0", "7.0"],            port: 27017, weight: 2 },
    { engine: "DB2",        versions: ["11.5", "12.1"],          port: 50000, weight: 1.5 },
    { engine: "Snowflake",  versions: ["8.x"],                   port: 443, weight: 1 },
    { engine: "Redis",      versions: ["7.2"],                   port: 6379, weight: 2 },
    { engine: "Cassandra",  versions: ["4.1"],                   port: 9042, weight: 0.5 },
  ];
  const weighted = ENGINES.map(e => [e, e.weight]);
  for (let i = 0; i < count; i++) {
    const e = pickWeighted(weighted);
    const ver = pick(e.versions);
    const lob = pick(LOBS);
    const env = pickWeighted(ENV_WEIGHTED);
    const dc = pick(DATACENTERS);
    const dbName = `${lob.code}_${pick(["accounts", "ledger", "orders", "claims", "policies", "positions", "trades", "customer", "audit", "events", "kyc", "fraud"])}_${pad(i + 1, 5)}`;
    yield {
      "CI Number": `F500-DB-${pad(i + 1, 5)}`,
      "Name": dbName, "Engine": e.engine, "Version": ver,
      "Host": `${dbName.replace(/_/g, "-")}.${env.toLowerCase()}.db.${COMPANY}.internal`,
      "Port": String(e.port), "Database Name": dbName,
      "Status": "Active", "Environment": env, "Location": dc.code,
      "Owner": "data-platform", "Owner Team": `${lob.team} - Data`,
      "Criticality": env === "Production" ? pickWeighted([["Critical", 6], ["High", 3]]) : "Medium",
      "Size GB": String(pickWeighted([[10, 3], [50, 4], [200, 4], [1000, 3], [4000, 2], [10000, 1]])),
      "HA Mode": env === "Production" ? pick(["Streaming Replication", "InnoDB Cluster", "AlwaysOn AG", "Data Guard"]) : "Single",
      "Backup Policy": env === "Production" ? "Daily snapshot, 30-day retention" : "Weekly snapshot",
      "Discovery Source": "ServiceNow Discovery",
      "Last Discovered": iso(Math.floor(rand() * 7)),
      "Description": `${e.engine} ${ver} — ${lob.name} ${env}`,
    };
  }
}

function* genApplications(count) {
  const APP_TYPES = [["Service", 6], ["Web", 3], ["Batch", 2], ["Worker", 3], ["Mobile", 0.5], ["API", 5]];
  const STACKS = [
    "Java + Spring Boot", "Java + Quarkus", "Kotlin + Spring",
    "Node.js + Express", "Node.js + Fastify", "Node.js + NestJS",
    "Go + gRPC", "Go + Echo",
    "Python + FastAPI", "Python + Django", "Python + Flask",
    "C# + .NET 8", "C# + ASP.NET Core",
    "Ruby on Rails", "Scala + Akka",
    "React + Next.js", "Vue + Nuxt", "Angular",
  ];
  const APP_NAMES = ["accounts", "ledger", "transactions", "payments", "transfers", "deposits", "withdrawals", "billing", "invoicing", "statements", "reconciliation", "settlement", "clearing", "compliance", "kyc", "aml", "fraud", "risk-scoring", "credit-scoring", "underwriting", "claims", "policies", "quotes", "positions", "trades", "orders", "market-data", "pricing", "portfolios", "advisor", "wealth-planning", "tax-reporting", "customer-portal", "mobile-banking", "atm-network", "card-processing", "rewards", "loyalty", "notifications", "email-sender", "sms-gateway", "audit-log", "analytics", "reporting", "data-warehouse", "feature-store", "ml-scoring", "auth", "identity", "session-mgr", "rate-limiter", "circuit-breaker", "api-gateway", "service-mesh"];
  for (let i = 0; i < count; i++) {
    const lob = pick(LOBS);
    const env = pickWeighted(ENV_WEIGHTED);
    const baseName = pick(APP_NAMES);
    const type = pickWeighted(APP_TYPES);
    yield {
      "CI Number": `F500-APP-${pad(i + 1, 5)}`,
      "Name": `${lob.code}-${baseName}-${pad(i + 1, 5)}`,
      "Version": `${1 + Math.floor(rand() * 9)}.${Math.floor(rand() * 30)}.${Math.floor(rand() * 50)}`,
      "Vendor": rand() < 0.85 ? "In-house" : pick(["Salesforce", "SAP", "Oracle", "Microsoft", "IBM", "Workday", "Adobe"]),
      "App Type": type,
      "Status": "Active", "Environment": env,
      "Owner": lob.team.toLowerCase().replace(/ /g, "-"),
      "Owner Team": lob.team,
      "Criticality": env === "Production" ? pickWeighted([["Critical", 4], ["High", 4], ["Medium", 2]]) : "Medium",
      "Tech Stack": pick(STACKS),
      "Repository URL": `https://github.com/${COMPANY}-financial/${lob.code}-${baseName}`,
      "Documentation URL": `https://docs.${COMPANY}.internal/${lob.code}/${baseName}`,
      "Port": type === "Web" || type === "API" || type === "Service" ? String(pick([8080, 8443, 443, 80, 9000])) : "",
      "URL": env === "Production" && (type === "Web" || type === "API") ? `https://${baseName}.${COMPANY}.com` : "",
      "Discovery Source": pick(["Kubernetes API", "ServiceNow Discovery", "AWS Config"]),
      "Last Discovered": iso(Math.floor(rand() * 7)),
      "Description": `${type} application — ${baseName} for ${lob.name} (${env})`,
    };
  }
}

function* genServices(count) {
  const SVC_TYPES = [["Business", 3], ["Technical", 4], ["Application", 3]];
  const SVC_NAMES = ["Online Banking", "Mobile Banking", "Customer Statements", "Bill Pay", "Wire Transfer", "ACH", "Card Authorization", "Card Issuance", "Fraud Prevention", "Customer Identity", "Authentication", "Authorization", "Notifications", "Email Delivery", "SMS Delivery", "Audit Logging", "Analytics & BI", "Data Warehouse", "ML Platform", "API Gateway", "Service Mesh", "Loan Origination", "Loan Servicing", "Underwriting", "Claims Processing", "Policy Administration", "Wealth Advisor", "Portfolio Mgmt", "Trade Execution", "Settlement", "Clearing", "Market Data", "Risk Reporting", "Regulatory Reporting", "KYC", "AML Monitoring", "Treasury Mgmt", "Cash Management", "FX Trading", "Derivatives", "Tax Reporting", "Compliance Mgmt"];
  for (let i = 0; i < count; i++) {
    const lob = pick(LOBS);
    const type = pickWeighted(SVC_TYPES);
    const name = pick(SVC_NAMES);
    yield {
      "CI Number": `F500-SVC-${pad(i + 1, 5)}`,
      "Name": `${name} — ${lob.code.toUpperCase()} #${pad(i + 1, 5)}`,
      "Service Type": type,
      "Status": rand() < 0.97 ? "Active" : "Planned",
      "Owner": lob.team.toLowerCase().replace(/ /g, "-"),
      "Owner Team": lob.team,
      "Business Owner": pick(["VP Operations", "VP Commerce", "VP Trust & Safety", "VP Platform", "VP Risk", "CIO Office", "CTO Office", "VP Data"]),
      "Criticality": type === "Business" ? pickWeighted([["Critical", 5], ["High", 3], ["Medium", 1]]) : pickWeighted([["High", 3], ["Medium", 4], ["Critical", 2]]),
      "SLA Tier": pickWeighted([["Tier 1", 3], ["Tier 2", 5], ["Tier 3", 2]]),
      "Lifecycle Stage": pickWeighted([["Operational", 8], ["Onboarding", 1], ["Retiring", 0.5], ["Pilot", 0.5]]),
      "URL": `https://status.${COMPANY}.com/${lob.code}/${name.toLowerCase().replace(/\s+/g, "-")}-${pad(i + 1, 5)}`,
      "Discovery Source": "Manual",
      "Description": `${type} service — ${name} for ${lob.name}`,
    };
  }
}

// ─── Per-form pipeline ──────────────────────────────────────────────────
const PLAN = [
  { slug: "datacenters",     count: 40,    gen: () => genDatacenters() },
  { slug: "services",        count: 4860,  gen: (n) => genServices(n) },
  { slug: "clusters",        count: 600,   gen: (n) => genClusters(n) },
  { slug: "storage",         count: 2000,  gen: (n) => genStorage(n) },
  { slug: "databases",       count: 3500,  gen: (n) => genDatabases(n) },
  { slug: "network-devices", count: 6000,  gen: (n) => genNetworkDevices(n) },
  { slug: "applications",    count: 28000, gen: (n) => genApplications(n) },
  { slug: "servers",         count: 55000, gen: (n) => genServers(n) },
];

const stats = {};

async function seedForm(formSlug, count, recordIter) {
  stats[formSlug] = { ok: 0, fail: 0, started: Date.now() };
  const buffer = [];
  let exhausted = false;
  const it = recordIter;

  function refill() {
    while (buffer.length < PER_FORM_WORKERS * 4 && !exhausted) {
      const next = it.next();
      if (next.done) { exhausted = true; break; }
      buffer.push(next.value);
    }
  }

  async function worker() {
    while (true) {
      refill();
      if (buffer.length === 0) return;
      const rec = buffer.shift();
      if (!rec) return;
      const r = await req("POST", `/kapps/${KAPP}/forms/${formSlug}/submissions?completed=true`, { values: rec, coreState: "Submitted" });
      if (r.status >= 200 && r.status < 300) stats[formSlug].ok++;
      else stats[formSlug].fail++;
    }
  }

  await Promise.all(Array.from({ length: PER_FORM_WORKERS }, worker));
  stats[formSlug].duration = (Date.now() - stats[formSlug].started) / 1000;
}

// ─── Reporter (periodic progress) ────────────────────────────────────────
let reporting = true;
function startReporter(plan) {
  const reportEvery = 3000;
  const start = Date.now();
  const ticker = setInterval(() => {
    if (!reporting) { clearInterval(ticker); return; }
    let totalDone = 0, totalTarget = 0;
    const lines = [];
    for (const p of plan) {
      const s = stats[p.slug];
      const done = s ? s.ok + s.fail : 0;
      totalDone += done; totalTarget += p.count;
      lines.push(`  ${p.slug.padEnd(17)} ${String(done).padStart(6)}/${String(p.count).padStart(6)}${s?.fail ? ` (fail=${s.fail})` : ""}`);
    }
    const elapsed = (Date.now() - start) / 1000;
    const rate = totalDone / elapsed;
    const remain = totalTarget - totalDone;
    const eta = rate > 0 ? remain / rate : 0;
    console.log(`\n[${(elapsed / 60).toFixed(1)}m elapsed, ${totalDone}/${totalTarget}, ${rate.toFixed(0)} rec/s, ETA ${(eta / 60).toFixed(1)}m]`);
    for (const l of lines) console.log(l);
  }, reportEvery);
  return ticker;
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n  Apex Financial CMDB Seed → ${SERVER}`);
  console.log(`  Workers per form: ${PER_FORM_WORKERS}\n`);

  if (DRY_RUN) {
    console.log("  Dry run — generating samples only.\n");
    for (const p of PLAN) {
      const sample = p.gen(p.count).next().value;
      console.log(`  ${p.slug} sample:`, JSON.stringify(sample).slice(0, 250));
    }
    return;
  }

  // 1. Drop custom indexes
  if (!SKIP_INDEX) {
    console.log("  Dropping custom indexes (preserves system indexes)...");
    for (const p of PLAN) {
      await dropCustomIndexes(p.slug);
      process.stdout.write(".");
    }
    console.log(" done.\n");
  }

  // 2. Seed all forms in parallel
  const ticker = startReporter(PLAN);
  const seedJobs = PLAN.map(p => seedForm(p.slug, p.count, p.gen(p.count)));
  await Promise.all(seedJobs);
  reporting = false;
  clearInterval(ticker);

  // 3. Final per-form summary
  console.log("\n  Per-form results:");
  let totalOk = 0, totalFail = 0;
  for (const p of PLAN) {
    const s = stats[p.slug];
    totalOk += s.ok; totalFail += s.fail;
    console.log(`    ${p.slug.padEnd(17)} ok=${String(s.ok).padStart(6)} fail=${String(s.fail).padStart(4)} in ${s.duration.toFixed(1)}s`);
  }
  console.log(`\n  Total: ${totalOk} ok, ${totalFail} fail`);

  // 4. Restore + rebuild indexes
  if (!SKIP_INDEX) {
    console.log("\n  Restoring custom indexes and triggering build jobs...");
    for (const f of APP_DEF.forms) {
      if (!PLAN.find(p => p.slug === f.slug)) continue;
      await restoreAndBuildIndexes(f.slug, f.indexes);
      process.stdout.write(".");
    }
    console.log(" done. Indexes will rebuild in the background (kapp will catch up over the next 1-10 minutes).\n");
  }
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
