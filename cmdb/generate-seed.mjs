#!/usr/bin/env node
/**
 * CMDB seed generator. Outputs apps/cmdb/seed-data.json with:
 *   - 8 CI classes
 *   - 5 environments, 6 locations, 5 discovery sources
 *   - 4 datacenters, 6 clusters, ~30 servers, ~12 databases,
 *     ~16 applications, ~10 services, ~8 network devices, ~5 storage
 *   - ~160 relationships forming a coherent service map
 *
 * Run:  node apps/cmdb/generate-seed.mjs
 */

import fs from "node:fs";
import path from "node:path";

const __dir = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(__dir, "seed-data.json");

// Deterministic RNG so re-runs match
let _s = 1337;
function rand() { _s = (_s * 16807) % 2147483647; return _s / 2147483647; }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
function pickN(arr, n) {
  const c = arr.slice();
  const out = [];
  while (out.length < n && c.length) out.push(c.splice(Math.floor(rand() * c.length), 1)[0]);
  return out;
}
function pad(n, w = 4) { return String(n).padStart(w, "0"); }
function iso(daysAgo = 0) { return new Date(Date.now() - daysAgo * 86400000).toISOString(); }

const data = {
  "ci-classes": [],
  "environments": [],
  "locations": [],
  "discovery-sources": [],
  "datacenters": [],
  "clusters": [],
  "servers": [],
  "databases": [],
  "applications": [],
  "services": [],
  "network-devices": [],
  "storage": [],
  "relationships": [],
  "ci-change-log": []
};

/* ─── CI Classes ─── */
const CLASSES = [
  { name: "Datacenter",     slug: "datacenters",     category: "Infrastructure", icon: "building",  color: "#5B6B82", crit: "High" },
  { name: "Cluster",        slug: "clusters",        category: "Infrastructure", icon: "layers",    color: "#7C3AED", crit: "High" },
  { name: "Server",         slug: "servers",         category: "Hardware",       icon: "server",    color: "#0EA5E9", crit: "Medium" },
  { name: "Network Device", slug: "network-devices", category: "Hardware",       icon: "router",    color: "#F59E0B", crit: "High" },
  { name: "Storage",        slug: "storage",         category: "Hardware",       icon: "database",  color: "#10B981", crit: "High" },
  { name: "Database",       slug: "databases",       category: "Software",       icon: "database",  color: "#F43F5E", crit: "Critical" },
  { name: "Application",    slug: "applications",    category: "Software",       icon: "box",       color: "#3B82F6", crit: "Medium" },
  { name: "Service",        slug: "services",        category: "Logical",        icon: "globe",     color: "#EC4899", crit: "Critical" }
];
for (const c of CLASSES) {
  data["ci-classes"].push({
    "Class Name": c.name,
    "Form Slug": c.slug,
    "Parent Class": "",
    "Category": c.category,
    "Icon": c.icon,
    "Color": c.color,
    "Description": `${c.name} configuration items — ${c.category.toLowerCase()} layer.`,
    "Default Criticality": c.crit,
    "Status": "Active"
  });
}

/* ─── Environments ─── */
const ENVS = [
  { name: "Production",  tier: "1", desc: "Customer-facing production environment." },
  { name: "Staging",     tier: "2", desc: "Pre-production validation environment." },
  { name: "Development", tier: "3", desc: "Engineering development environment." },
  { name: "Test",        tier: "3", desc: "QA / automated test environment." },
  { name: "DR",          tier: "1", desc: "Disaster recovery — warm standby for Production." }
];
for (const e of ENVS) data["environments"].push({ "Name": e.name, "Tier": e.tier, "Status": "Active", "Description": e.desc });

/* ─── Locations ─── */
const LOCS = [
  { name: "us-east-1",   type: "Cloud Region", provider: "AWS",    region: "us-east-1",  city: "Ashburn",  country: "USA",     tier: "Tier 3" },
  { name: "us-west-2",   type: "Cloud Region", provider: "AWS",    region: "us-west-2",  city: "Hillsboro", country: "USA",    tier: "Tier 3" },
  { name: "eu-west-1",   type: "Cloud Region", provider: "AWS",    region: "eu-west-1",  city: "Dublin",   country: "Ireland", tier: "Tier 3" },
  { name: "azure-east",  type: "Cloud Region", provider: "Azure",  region: "eastus2",    city: "Boydton",  country: "USA",     tier: "Tier 3" },
  { name: "dc1-mpls",    type: "Datacenter",   provider: "On-Prem", region: "north",     city: "Minneapolis", country: "USA",  tier: "Tier 3" },
  { name: "dc2-phx",     type: "Datacenter",   provider: "On-Prem", region: "south",     city: "Phoenix",     country: "USA",  tier: "Tier 2" }
];
for (const l of LOCS) data["locations"].push({
  "Name": l.name, "Type": l.type, "Provider": l.provider, "Region": l.region,
  "City": l.city, "Country": l.country, "Tier": l.tier, "Status": "Active"
});

/* ─── Discovery Sources ─── */
const SRCS = [
  { name: "Manual",          type: "Manual",      desc: "Manually entered by IT operations." },
  { name: "AWS Config",      type: "Cloud API",   desc: "AWS Config + CloudFormation inventory feed." },
  { name: "Azure Resource Graph", type: "Cloud API", desc: "Azure Resource Graph API." },
  { name: "ServiceNow Discovery", type: "Scanner", desc: "Network scan + agent-based discovery." },
  { name: "Kubernetes API",  type: "Agent",       desc: "kube-state-metrics + operator-pushed inventory." }
];
for (const s of SRCS) data["discovery-sources"].push({
  "Name": s.name, "Type": s.type, "Status": "Active",
  "Last Run": iso(Math.floor(rand() * 7)), "Description": s.desc
});

/* ─── ID generator ─── */
const counters = {};
function ciNum(prefix) {
  counters[prefix] = (counters[prefix] || 0) + 1;
  return `${prefix}-${pad(counters[prefix])}`;
}

/* ─── Datacenters ─── */
const datacenters = [
  { name: "AWS-USE1",  type: "Cloud Region", prov: "AWS",   region: "us-east-1",  loc: "us-east-1",  tier: "Tier 3" },
  { name: "AWS-USW2",  type: "Cloud Region", prov: "AWS",   region: "us-west-2",  loc: "us-west-2",  tier: "Tier 3" },
  { name: "AWS-EUW1",  type: "Cloud Region", prov: "AWS",   region: "eu-west-1",  loc: "eu-west-1",  tier: "Tier 3" },
  { name: "DC1-MPLS",  type: "Physical",     prov: "On-Prem", region: "north",    loc: "dc1-mpls",   tier: "Tier 3" }
];
for (const d of datacenters) {
  const id = ciNum("DC");
  data["datacenters"].push({
    "CI Number": id, "Name": d.name, "DC Type": d.type, "Provider": d.prov, "Region": d.region,
    "City": LOCS.find(l => l.name === d.loc)?.city || "", "Country": LOCS.find(l => l.name === d.loc)?.country || "",
    "Tier": d.tier, "Status": "Active", "Owner": "platform-eng",
    "Discovery Source": d.prov === "On-Prem" ? "Manual" : (d.prov === "AWS" ? "AWS Config" : "Azure Resource Graph"),
    "Description": `${d.name} — ${d.tier} ${d.type} (${d.prov}).`
  });
  d.id = id;
}

/* ─── Clusters ─── */
const clusters = [
  { name: "k8s-prod-use1",    type: "Kubernetes",      env: "Production",  loc: "us-east-1",  ver: "1.29.4", nodes: 12, crit: "Critical" },
  { name: "k8s-prod-euw1",    type: "Kubernetes",      env: "Production",  loc: "eu-west-1",  ver: "1.29.4", nodes: 6,  crit: "Critical" },
  { name: "k8s-staging",      type: "Kubernetes",      env: "Staging",     loc: "us-east-1",  ver: "1.30.0", nodes: 4,  crit: "Medium" },
  { name: "pg-cluster-prod",  type: "Database",        env: "Production",  loc: "us-east-1",  ver: "PG16",   nodes: 3,  crit: "Critical" },
  { name: "redis-cluster-prod", type: "Cache",         env: "Production",  loc: "us-east-1",  ver: "7.2",    nodes: 6,  crit: "High" },
  { name: "kafka-prod",       type: "Messaging",       env: "Production",  loc: "us-east-1",  ver: "3.7",    nodes: 5,  crit: "High" }
];
for (const c of clusters) {
  c.id = ciNum("CLU");
  data["clusters"].push({
    "CI Number": c.id, "Name": c.name, "Cluster Type": c.type, "Version": c.ver,
    "Node Count": String(c.nodes), "Status": "Active", "Environment": c.env, "Location": c.loc,
    "Owner": pick(["sre-team", "platform-eng", "data-platform"]), "Owner Team": pick(["SRE", "Platform Engineering", "Data Platform"]),
    "Criticality": c.crit, "Discovery Source": c.type === "Kubernetes" ? "Kubernetes API" : "AWS Config",
    "Last Discovered": iso(Math.floor(rand() * 3)),
    "Description": `${c.type} cluster — ${c.nodes} nodes, ${c.env}, ${c.loc}.`
  });
}

/* ─── Servers (~30) ─── */
const OS_OPTIONS = [
  { os: "Ubuntu", ver: "22.04 LTS" },
  { os: "Ubuntu", ver: "20.04 LTS" },
  { os: "Amazon Linux", ver: "2023" },
  { os: "RHEL", ver: "9.3" },
  { os: "Windows Server", ver: "2022" }
];
const SERVER_ROLES = ["web", "app", "db", "cache", "worker", "proxy", "bastion"];
const servers = [];
function addServer(env, loc, role, hypervisor, crit, idx) {
  const o = pick(OS_OPTIONS);
  const id = ciNum("SRV");
  const num = pad(idx, 3);
  const envCode = env === "Production" ? "prod" : env === "Staging" ? "stg" : env === "DR" ? "dr" : env.toLowerCase();
  const hostBase = `${role}-${envCode}-${num}`;
  const ipBase = env === "Production" ? "10.10" : env === "Staging" ? "10.20" : env === "DR" ? "10.40" : "10.30";
  const s = {
    "CI Number": id, "Name": hostBase, "FQDN": `${hostBase}.kinetic.internal`,
    "IP Address": `${ipBase}.${1 + (idx >> 8)}.${idx & 0xff}`,
    "Status": rand() < 0.93 ? "Active" : (rand() < 0.5 ? "Maintenance" : "Retired"),
    "Environment": env, "Location": loc,
    "Owner": pick(["sre-team", "platform-eng", "app-team", "data-platform"]),
    "Owner Team": pick(["SRE", "Platform Engineering", "App Engineering", "Data Platform"]),
    "Criticality": crit, "OS": o.os, "OS Version": o.ver,
    "CPU Cores": String(pick([2, 4, 8, 16, 32, 64])),
    "RAM GB": String(pick([8, 16, 32, 64, 128, 256])),
    "Storage GB": String(pick([100, 250, 500, 1000, 2000])),
    "Virtual": "Yes", "Hypervisor": hypervisor, "Serial Number": `SN-${Math.floor(rand() * 1e10).toString(16).toUpperCase()}`,
    "Discovery Source": pick(["AWS Config", "ServiceNow Discovery", "Manual"]),
    "Last Discovered": iso(Math.floor(rand() * 5)),
    "Description": `${role} node #${num} in ${env} (${loc}).`
  };
  data["servers"].push(s);
  servers.push({ id, role, env, loc, name: hostBase });
}
let srvIdx = 1;
for (const role of SERVER_ROLES) {
  for (let i = 0; i < (role === "bastion" ? 1 : role === "web" || role === "app" ? 4 : 3); i++) {
    addServer("Production", pick(["us-east-1", "eu-west-1"]), role, "AWS EC2",
              role === "db" || role === "proxy" ? "Critical" : (role === "cache" || role === "worker" ? "High" : "Medium"), srvIdx++);
  }
}
for (const role of ["web", "app", "db"]) {
  addServer("Staging", "us-east-1", role, "AWS EC2", "Medium", srvIdx++);
}
for (const role of ["web", "app"]) {
  addServer("Development", "us-east-1", role, "AWS EC2", "Low", srvIdx++);
}
addServer("DR", "us-west-2", "db", "AWS EC2", "Critical", srvIdx++);
addServer("DR", "us-west-2", "app", "AWS EC2", "High", srvIdx++);

/* ─── Databases (~12) ─── */
const databases = [];
function addDB(name, engine, ver, env, crit, sizeGB, ha) {
  const id = ciNum("DB");
  const host = `${name.toLowerCase()}.${env === "Production" ? "prod" : env.toLowerCase()}.db.kinetic.internal`;
  const port = engine === "PostgreSQL" ? 5432 : engine === "MySQL" ? 3306 : engine === "MS SQL" ? 1433 :
               engine === "MongoDB" ? 27017 : engine === "Redis" ? 6379 : engine === "Oracle" ? 1521 : 5432;
  data["databases"].push({
    "CI Number": id, "Name": name, "Engine": engine, "Version": ver, "Host": host, "Port": String(port),
    "Database Name": name.toLowerCase().replace(/-/g, "_"),
    "Status": "Active", "Environment": env, "Location": env === "DR" ? "us-west-2" : "us-east-1",
    "Owner": "data-platform", "Owner Team": "Data Platform", "Criticality": crit, "Size GB": String(sizeGB),
    "HA Mode": ha, "Backup Policy": "Daily snapshot, 30-day retention",
    "Discovery Source": "ServiceNow Discovery", "Last Discovered": iso(Math.floor(rand() * 5)),
    "Description": `${engine} ${ver} — ${env} (${ha})`
  });
  databases.push({ id, name, engine, env });
}
addDB("orders-pg",       "PostgreSQL", "16.2",  "Production", "Critical", 850,  "Streaming Replication");
addDB("catalog-pg",      "PostgreSQL", "16.2",  "Production", "Critical", 420,  "Streaming Replication");
addDB("identity-pg",     "PostgreSQL", "16.2",  "Production", "Critical", 180,  "Streaming Replication");
addDB("payments-pg",     "PostgreSQL", "16.2",  "Production", "Critical", 320,  "Streaming Replication");
addDB("analytics-mysql", "MySQL",      "8.0.36","Production", "High",     1200, "InnoDB Cluster");
addDB("logs-mongo",      "MongoDB",    "7.0",   "Production", "Medium",   2400, "Replica Set");
addDB("sessions-redis",  "Redis",      "7.2",   "Production", "High",     32,   "Sentinel");
addDB("queue-redis",     "Redis",      "7.2",   "Production", "High",     16,   "Sentinel");
addDB("dwh-snowflake",   "Snowflake",  "8.x",   "Production", "Critical", 8400, "Snowflake-managed");
addDB("orders-pg-stg",   "PostgreSQL", "16.2",  "Staging",    "Medium",   120,  "Single");
addDB("orders-pg-dev",   "PostgreSQL", "16.2",  "Development","Low",      40,   "Single");
addDB("orders-pg-dr",    "PostgreSQL", "16.2",  "DR",         "Critical", 850,  "Async Replica");

/* ─── Applications (~16) ─── */
const applications = [];
function addApp(name, ver, vendor, type, env, owner, team, crit, stack, port) {
  const id = ciNum("APP");
  data["applications"].push({
    "CI Number": id, "Name": name, "Version": ver, "Vendor": vendor || "In-house", "App Type": type,
    "Status": "Active", "Environment": env, "Owner": owner, "Owner Team": team, "Criticality": crit,
    "Tech Stack": stack, "Repository URL": `https://github.com/kineticdata/${name.toLowerCase()}`,
    "Documentation URL": `https://docs.kinetic.internal/${name.toLowerCase()}`,
    "Port": port ? String(port) : "", "URL": env === "Production" ? `https://${name.toLowerCase()}.kineticdata.com` : "",
    "Discovery Source": "Kubernetes API", "Last Discovered": iso(Math.floor(rand() * 3)),
    "Description": `${type} application — ${stack}.`
  });
  applications.push({ id, name, env, team });
}
addApp("Checkout API",     "2.14.3", "", "Service",     "Production", "app-team",      "Commerce",    "Critical", "Node.js + Express", 8080);
addApp("Catalog API",      "3.2.1",  "", "Service",     "Production", "app-team",      "Commerce",    "Critical", "Go + gRPC",        8081);
addApp("Identity Service", "4.5.0",  "", "Service",     "Production", "platform-eng",  "Platform",    "Critical", "Kotlin + Spring",  8082);
addApp("Payments Gateway", "1.9.7",  "", "Service",     "Production", "app-team",      "Commerce",    "Critical", "Java + Spring",    8083);
addApp("Analytics Pipeline","2.3.0", "", "Batch",       "Production", "data-platform", "Data Platform","High",    "Python + Airflow", null);
addApp("Notifications Hub","1.4.2",  "", "Service",     "Production", "platform-eng",  "Platform",    "High",     "Node.js + NATS",   8084);
addApp("Search Service",   "2.0.1",  "", "Service",     "Production", "app-team",      "Commerce",    "High",     "Go + ElasticSearch", 8085);
addApp("Customer Portal",  "5.1.0",  "", "Web",         "Production", "app-team",      "Commerce",    "Critical", "React + Next.js",  443);
addApp("Admin Console",    "3.4.1",  "", "Web",         "Production", "platform-eng",  "Platform",    "High",     "React + Vite",     443);
addApp("Reporting API",    "1.2.0",  "", "Service",     "Production", "data-platform", "Data Platform","Medium",   "Python + FastAPI", 8086);
addApp("Order Worker",     "2.14.3", "", "Worker",      "Production", "app-team",      "Commerce",    "High",     "Node.js + BullMQ", null);
addApp("Email Sender",     "1.1.0",  "", "Worker",      "Production", "platform-eng",  "Platform",    "Medium",   "Go + AWS SES",     null);
addApp("Mobile API",       "4.0.2",  "", "Service",     "Production", "app-team",      "Commerce",    "Critical", "Node.js + Fastify",8087);
addApp("Fraud Detector",   "1.0.5",  "", "Service",     "Production", "data-platform", "Data Platform","Critical","Python + scikit",  8088);
addApp("Checkout API",     "2.14.3", "", "Service",     "Staging",    "app-team",      "Commerce",    "Medium",   "Node.js + Express", 8080);
addApp("Checkout API",     "2.14.3", "", "Service",     "DR",         "app-team",      "Commerce",    "Critical", "Node.js + Express", 8080);

/* ─── Services (~10) ─── */
const services = [];
function addService(name, type, crit, sla, biz, owner, team, desc) {
  const id = ciNum("SVC");
  data["services"].push({
    "CI Number": id, "Name": name, "Service Type": type, "Status": "Active",
    "Owner": owner, "Owner Team": team, "Business Owner": biz,
    "Criticality": crit, "SLA Tier": sla, "Lifecycle Stage": "Operational",
    "URL": `https://status.kineticdata.com/${name.toLowerCase().replace(/\s+/g, "-")}`,
    "Discovery Source": "Manual",
    "Description": desc
  });
  services.push({ id, name, type });
}
addService("Online Storefront",  "Business",    "Critical", "Tier 1", "VP Commerce",       "app-team",     "Commerce",     "Customer-facing online shopping experience.");
addService("Checkout & Payments","Business",    "Critical", "Tier 1", "VP Commerce",       "app-team",     "Commerce",     "Order placement, payment processing, refunds.");
addService("Customer Identity",  "Technical",   "Critical", "Tier 1", "VP Platform",       "platform-eng", "Platform",     "Authentication, authorization, profile.");
addService("Product Search",     "Application", "High",     "Tier 2", "VP Commerce",       "app-team",     "Commerce",     "Catalog search and faceted browsing.");
addService("Order Fulfillment",  "Business",    "Critical", "Tier 1", "VP Operations",     "app-team",     "Commerce",     "Order pipeline from cart to shipped.");
addService("Mobile Experience",  "Business",    "Critical", "Tier 1", "VP Commerce",       "app-team",     "Commerce",     "iOS + Android mobile shopping.");
addService("Analytics & BI",     "Technical",   "High",     "Tier 2", "VP Data",           "data-platform","Data Platform","Data pipeline, warehouse, and reporting.");
addService("Fraud Prevention",   "Technical",   "Critical", "Tier 1", "VP Trust & Safety", "data-platform","Data Platform","Real-time fraud detection.");
addService("Internal Admin",     "Application", "High",     "Tier 2", "VP Platform",       "platform-eng", "Platform",     "Internal back-office tooling.");
addService("Customer Notifications","Technical","High",     "Tier 2", "VP Platform",       "platform-eng", "Platform",     "Email/SMS/push delivery.");

/* ─── Network Devices (~8) ─── */
const netDevices = [];
function addNet(name, type, vendor, model, ip, env, loc, crit) {
  const id = ciNum("NET");
  data["network-devices"].push({
    "CI Number": id, "Name": name, "Device Type": type, "Vendor": vendor, "Model": model,
    "Management IP": ip, "Status": "Active", "Environment": env, "Location": loc,
    "Owner": "network-ops", "Owner Team": "Network Operations", "Criticality": crit,
    "OS Version": vendor === "AWS" ? "managed" : "v17.2.4",
    "Discovery Source": vendor === "AWS" ? "AWS Config" : "ServiceNow Discovery",
    "Last Discovered": iso(Math.floor(rand() * 7)),
    "Description": `${type} — ${vendor} ${model} in ${env} (${loc})`
  });
  netDevices.push({ id, name, env, type });
}
addNet("alb-prod-public",  "Load Balancer", "AWS",     "ALB",       "10.10.0.10",  "Production", "us-east-1", "Critical");
addNet("alb-prod-internal","Load Balancer", "AWS",     "ALB",       "10.10.0.11",  "Production", "us-east-1", "Critical");
addNet("alb-euw1-public",  "Load Balancer", "AWS",     "ALB",       "10.50.0.10",  "Production", "eu-west-1", "Critical");
addNet("fw-prod-edge",     "Firewall",      "Palo Alto","PA-5260",  "10.10.0.1",   "Production", "us-east-1", "Critical");
addNet("fw-corp-edge",     "Firewall",      "Palo Alto","PA-3260",  "10.0.0.1",    "Production", "dc1-mpls",  "Critical");
addNet("sw-core-mpls",     "Switch",        "Cisco",    "Nexus 9504","10.0.1.1",   "Production", "dc1-mpls",  "High");
addNet("tgw-prod",         "Transit Gateway","AWS",     "TGW",      "10.10.0.250", "Production", "us-east-1", "Critical");
addNet("nat-prod",         "NAT Gateway",   "AWS",      "NAT",      "10.10.0.251", "Production", "us-east-1", "High");

/* ─── Storage (~5) ─── */
const storageItems = [];
function addStorage(name, type, vendor, cap, used, env, loc, proto) {
  const id = ciNum("STO");
  data["storage"].push({
    "CI Number": id, "Name": name, "Storage Type": type, "Vendor": vendor,
    "Capacity TB": String(cap), "Used TB": String(used), "Status": "Active",
    "Environment": env, "Location": loc, "Owner": "storage-team", "Owner Team": "Storage",
    "Criticality": "High", "Protocol": proto, "Discovery Source": vendor === "AWS" ? "AWS Config" : "ServiceNow Discovery",
    "Last Discovered": iso(Math.floor(rand() * 7)),
    "Description": `${type} — ${cap}TB ${vendor} ${proto} array in ${env}.`
  });
  storageItems.push({ id, name, env });
}
addStorage("s3-prod-data",   "Object", "AWS",      120, 84,  "Production", "us-east-1", "S3");
addStorage("s3-prod-backup", "Object", "AWS",      400, 220, "Production", "us-east-1", "S3");
addStorage("ebs-prod-pool",  "Block",  "AWS",      80,  58,  "Production", "us-east-1", "EBS");
addStorage("netapp-mpls-01", "NAS",    "NetApp",   240, 142, "Production", "dc1-mpls",  "NFSv4");
addStorage("efs-prod-shared","NAS",    "AWS",      20,  6,   "Production", "us-east-1", "NFSv4");

/* ─── Relationships ─── */
let relIdx = 1;
function relate(srcClass, srcId, srcName, tgtClass, tgtId, tgtName, type, desc) {
  data["relationships"].push({
    "Relationship ID": `REL-${pad(relIdx++)}`,
    "Source Class": srcClass, "Source CI Number": srcId, "Source Name": srcName,
    "Target Class": tgtClass, "Target CI Number": tgtId, "Target Name": tgtName,
    "Type": type, "Direction": "Forward", "Status": "Active",
    "Discovery Source": "Manual", "Description": desc || ""
  });
}

// Clusters hosted in datacenters (by region)
const dcByLoc = {
  "us-east-1": datacenters.find(d => d.region === "us-east-1"),
  "eu-west-1": datacenters.find(d => d.region === "eu-west-1"),
  "us-west-2": datacenters.find(d => d.region === "us-west-2"),
};
for (const c of clusters) {
  const dc = dcByLoc[c.loc];
  if (dc) relate("clusters", c.id, c.name, "datacenters", dc.id, dc.name, "hosted-in", "Cluster runs in datacenter / region");
}

// Servers hosted in datacenters
for (const s of servers) {
  const dc = dcByLoc[s.loc] || datacenters[0];
  relate("servers", s.id, s.name, "datacenters", dc.id, dc.name, "hosted-in");
}

// Servers are member-of a cluster (where it matches)
const k8sUSE1 = clusters.find(c => c.name === "k8s-prod-use1");
const k8sEUW1 = clusters.find(c => c.name === "k8s-prod-euw1");
const k8sStg  = clusters.find(c => c.name === "k8s-staging");
const pgCluster = clusters.find(c => c.name === "pg-cluster-prod");
const redisCluster = clusters.find(c => c.name === "redis-cluster-prod");
const kafkaCluster = clusters.find(c => c.name === "kafka-prod");
for (const s of servers) {
  if (s.role === "db" && s.env === "Production" && s.loc === "us-east-1") {
    relate("servers", s.id, s.name, "clusters", pgCluster.id, pgCluster.name, "member-of");
  } else if (s.role === "cache" && s.env === "Production") {
    relate("servers", s.id, s.name, "clusters", redisCluster.id, redisCluster.name, "member-of");
  } else if (s.role === "worker" && s.env === "Production") {
    relate("servers", s.id, s.name, "clusters", kafkaCluster.id, kafkaCluster.name, "member-of");
  } else if (s.env === "Production" && s.loc === "us-east-1" && ["web", "app"].includes(s.role)) {
    relate("servers", s.id, s.name, "clusters", k8sUSE1.id, k8sUSE1.name, "member-of");
  } else if (s.env === "Production" && s.loc === "eu-west-1") {
    relate("servers", s.id, s.name, "clusters", k8sEUW1.id, k8sEUW1.name, "member-of");
  } else if (s.env === "Staging" && ["web", "app"].includes(s.role)) {
    relate("servers", s.id, s.name, "clusters", k8sStg.id, k8sStg.name, "member-of");
  }
}

// Databases run-on database cluster
for (const d of databases) {
  if (d.engine === "PostgreSQL" && d.env === "Production") {
    relate("databases", d.id, d.name, "clusters", pgCluster.id, pgCluster.name, "runs-on");
  }
  if (d.engine === "Redis" && d.env === "Production") {
    relate("databases", d.id, d.name, "clusters", redisCluster.id, redisCluster.name, "runs-on");
  }
}

// Applications run-on k8s cluster (by env)
for (const a of applications) {
  if (a.env === "Production") {
    relate("applications", a.id, a.name, "clusters", k8sUSE1.id, k8sUSE1.name, "runs-on");
  } else if (a.env === "Staging") {
    relate("applications", a.id, a.name, "clusters", k8sStg.id, k8sStg.name, "runs-on");
  } else if (a.env === "DR") {
    const k8sDR = clusters.find(c => c.name === "k8s-prod-euw1"); // simulate DR target
    if (k8sDR) relate("applications", a.id, a.name, "clusters", k8sDR.id, k8sDR.name, "runs-on");
  }
}

// Application → Database dependencies (depends-on)
function appDep(appName, env, dbName) {
  const a = applications.find(x => x.name === appName && x.env === env);
  const d = databases.find(x => x.name === dbName);
  if (a && d) relate("applications", a.id, a.name, "databases", d.id, d.name, "depends-on", `${a.name} reads/writes ${d.name}`);
}
appDep("Checkout API",     "Production", "orders-pg");
appDep("Checkout API",     "Production", "sessions-redis");
appDep("Catalog API",      "Production", "catalog-pg");
appDep("Catalog API",      "Production", "sessions-redis");
appDep("Identity Service", "Production", "identity-pg");
appDep("Identity Service", "Production", "sessions-redis");
appDep("Payments Gateway", "Production", "payments-pg");
appDep("Payments Gateway", "Production", "queue-redis");
appDep("Analytics Pipeline","Production","analytics-mysql");
appDep("Analytics Pipeline","Production","logs-mongo");
appDep("Analytics Pipeline","Production","dwh-snowflake");
appDep("Notifications Hub","Production", "queue-redis");
appDep("Search Service",   "Production", "catalog-pg");
appDep("Customer Portal",  "Production", "sessions-redis");
appDep("Admin Console",    "Production", "identity-pg");
appDep("Reporting API",    "Production", "dwh-snowflake");
appDep("Order Worker",     "Production", "orders-pg");
appDep("Order Worker",     "Production", "queue-redis");
appDep("Mobile API",       "Production", "orders-pg");
appDep("Mobile API",       "Production", "catalog-pg");
appDep("Mobile API",       "Production", "sessions-redis");
appDep("Fraud Detector",   "Production", "orders-pg");
appDep("Fraud Detector",   "Production", "logs-mongo");

// App-to-app dependencies
function appToApp(srcName, env, tgtName) {
  const s = applications.find(x => x.name === srcName && x.env === env);
  const t = applications.find(x => x.name === tgtName && x.env === env);
  if (s && t) relate("applications", s.id, s.name, "applications", t.id, t.name, "depends-on", `${s.name} calls ${t.name}`);
}
appToApp("Customer Portal", "Production", "Checkout API");
appToApp("Customer Portal", "Production", "Catalog API");
appToApp("Customer Portal", "Production", "Identity Service");
appToApp("Customer Portal", "Production", "Search Service");
appToApp("Mobile API",      "Production", "Checkout API");
appToApp("Mobile API",      "Production", "Catalog API");
appToApp("Mobile API",      "Production", "Identity Service");
appToApp("Checkout API",    "Production", "Payments Gateway");
appToApp("Checkout API",    "Production", "Fraud Detector");
appToApp("Checkout API",    "Production", "Notifications Hub");
appToApp("Checkout API",    "Production", "Order Worker");
appToApp("Order Worker",    "Production", "Notifications Hub");
appToApp("Order Worker",    "Production", "Email Sender");
appToApp("Notifications Hub","Production","Email Sender");
appToApp("Admin Console",   "Production", "Identity Service");
appToApp("Admin Console",   "Production", "Reporting API");

// Service → Application supports
function svcSupp(svcName, appNames) {
  const s = services.find(x => x.name === svcName);
  if (!s) return;
  for (const an of appNames) {
    const a = applications.find(x => x.name === an && x.env === "Production");
    if (a) relate("services", s.id, s.name, "applications", a.id, a.name, "supported-by", `${s.name} is delivered by ${a.name}`);
  }
}
svcSupp("Online Storefront",  ["Customer Portal", "Catalog API", "Search Service"]);
svcSupp("Checkout & Payments",["Checkout API", "Payments Gateway", "Order Worker"]);
svcSupp("Customer Identity",  ["Identity Service"]);
svcSupp("Product Search",     ["Search Service", "Catalog API"]);
svcSupp("Order Fulfillment",  ["Order Worker", "Checkout API", "Notifications Hub"]);
svcSupp("Mobile Experience",  ["Mobile API"]);
svcSupp("Analytics & BI",     ["Analytics Pipeline", "Reporting API"]);
svcSupp("Fraud Prevention",   ["Fraud Detector"]);
svcSupp("Internal Admin",     ["Admin Console"]);
svcSupp("Customer Notifications", ["Notifications Hub", "Email Sender"]);

// Service → Service (composition)
function svcDep(parentName, childName) {
  const p = services.find(x => x.name === parentName);
  const c = services.find(x => x.name === childName);
  if (p && c) relate("services", p.id, p.name, "services", c.id, c.name, "depends-on", `${p.name} requires ${c.name}`);
}
svcDep("Online Storefront",   "Customer Identity");
svcDep("Online Storefront",   "Product Search");
svcDep("Online Storefront",   "Checkout & Payments");
svcDep("Checkout & Payments", "Customer Identity");
svcDep("Checkout & Payments", "Fraud Prevention");
svcDep("Checkout & Payments", "Order Fulfillment");
svcDep("Order Fulfillment",   "Customer Notifications");
svcDep("Mobile Experience",   "Customer Identity");
svcDep("Mobile Experience",   "Product Search");
svcDep("Mobile Experience",   "Checkout & Payments");

// Network: Load balancers connect-to web/app servers
const albPublic = netDevices.find(n => n.name === "alb-prod-public");
const albInternal = netDevices.find(n => n.name === "alb-prod-internal");
const albEuw1 = netDevices.find(n => n.name === "alb-euw1-public");
for (const s of servers) {
  if (s.env === "Production" && s.loc === "us-east-1" && s.role === "web") {
    relate("network-devices", albPublic.id, albPublic.name, "servers", s.id, s.name, "connects-to", "ALB routes to web nodes");
  }
  if (s.env === "Production" && s.loc === "us-east-1" && s.role === "app") {
    relate("network-devices", albInternal.id, albInternal.name, "servers", s.id, s.name, "connects-to", "Internal ALB routes to app nodes");
  }
  if (s.env === "Production" && s.loc === "eu-west-1" && s.role === "web") {
    relate("network-devices", albEuw1.id, albEuw1.name, "servers", s.id, s.name, "connects-to");
  }
}

// Storage attached to services / clusters
const s3Backup = storageItems.find(x => x.name === "s3-prod-backup");
const s3Data = storageItems.find(x => x.name === "s3-prod-data");
const ebsPool = storageItems.find(x => x.name === "ebs-prod-pool");
relate("clusters", pgCluster.id, pgCluster.name, "storage", ebsPool.id, ebsPool.name, "uses", "PG cluster on EBS volumes");
relate("clusters", k8sUSE1.id, k8sUSE1.name, "storage", ebsPool.id, ebsPool.name, "uses");
relate("clusters", kafkaCluster.id, kafkaCluster.name, "storage", ebsPool.id, ebsPool.name, "uses");
relate("applications", applications.find(a => a.name === "Analytics Pipeline" && a.env === "Production").id, "Analytics Pipeline",
       "storage", s3Data.id, s3Data.name, "uses", "Pipeline reads/writes raw zone");
for (const d of databases.filter(x => x.env === "Production" && x.engine === "PostgreSQL")) {
  relate("databases", d.id, d.name, "storage", s3Backup.id, s3Backup.name, "uses", "Daily snapshot backups");
}

// Production → DR (relate prod CIs to DR equivalents)
const ordersProd = databases.find(d => d.name === "orders-pg");
const ordersDR   = databases.find(d => d.name === "orders-pg-dr");
if (ordersProd && ordersDR) relate("databases", ordersProd.id, ordersProd.name, "databases", ordersDR.id, ordersDR.name, "replicated-to", "Async DR replica");
const checkoutProd = applications.find(a => a.name === "Checkout API" && a.env === "Production");
const checkoutDR   = applications.find(a => a.name === "Checkout API" && a.env === "DR");
if (checkoutProd && checkoutDR) relate("applications", checkoutProd.id, checkoutProd.name, "applications", checkoutDR.id, checkoutDR.name, "failover-to");

/* ─── Change Log seed (a few entries) ─── */
function logChange(ciNum, ciClass, ciName, action, field, oldV, newV, actor, daysAgo) {
  data["ci-change-log"].push({
    "CI Number": ciNum, "CI Class": ciClass, "CI Name": ciName,
    "Action": action, "Field": field || "", "Old Value": oldV || "", "New Value": newV || "",
    "Actor": actor, "Source": "Manual", "Timestamp": iso(daysAgo),
    "Notes": ""
  });
}
const sampleSrv = servers[0];
logChange(sampleSrv.id, "servers", sampleSrv.name, "Created", "", "", "", "platform-eng", 90);
logChange(sampleSrv.id, "servers", sampleSrv.name, "Updated", "RAM GB", "32", "64", "platform-eng", 30);
logChange(sampleSrv.id, "servers", sampleSrv.name, "Updated", "OS Version", "20.04 LTS", "22.04 LTS", "sre-team", 12);
const sampleApp = applications[0];
logChange(sampleApp.id, "applications", sampleApp.name, "Updated", "Version", "2.13.0", "2.14.3", "app-team", 3);

/* ─── Write ─── */
fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
console.log(`Wrote ${OUT}`);
console.log("Counts:");
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(22)} ${v}`);
console.log(`Total: ${Object.values(counts).reduce((a, b) => a + b, 0)} records`);
