#!/usr/bin/env python3
"""Seed the CRM kapp with sample data."""

import json, ssl, base64, urllib.request, urllib.error
import concurrent.futures, random, sys
from datetime import datetime, timedelta

import os
BASE_URL = os.environ.get("KINETIC_URL", "https://localhost")
USERNAME = os.environ.get("KINETIC_USER", "admin")
PASSWORD = os.environ.get("KINETIC_PASS", "admin")
CONCURRENCY = 10

AUTH_HEADER = "Basic " + base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

def post_submission(form_slug, values):
    url = f"{BASE_URL}/app/api/v1/kapps/crm/forms/{form_slug}/submissions"
    body = json.dumps({"values": values}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": AUTH_HEADER, "Content-Type": "application/json", "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=30) as resp:
            return {"ok": True, "status": resp.status}
    except urllib.error.HTTPError as e:
        return {"ok": False, "status": e.code, "error": e.read().decode()[:200]}
    except Exception as e:
        return {"ok": False, "status": 0, "error": str(e)}

def submit_batch(form_slug, records, label):
    print(f"\n  Seeding {label}: {len(records)} records")
    ok = fail = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = {pool.submit(post_submission, form_slug, rec): i for i, rec in enumerate(records)}
        for f in concurrent.futures.as_completed(futures):
            r = f.result()
            if r["ok"]: ok += 1
            else: fail += 1; print(f"    FAIL #{futures[f]}: {r.get('error','')[:100]}")
    print(f"  Done: {ok} ok, {fail} fail")
    return ok, fail

random.seed(42)
TODAY = datetime.now()
def dpast(d): return (TODAY - timedelta(days=random.randint(0, d))).strftime("%Y-%m-%d")
def dfut(d): return (TODAY + timedelta(days=random.randint(1, d))).strftime("%Y-%m-%d")
def drange(b, a): return (TODAY + timedelta(days=random.randint(-b, a))).strftime("%Y-%m-%d")
def phone(): return f"({random.randint(200,999)}) {random.randint(200,999)}-{random.randint(1000,9999)}"

REPS = [("Jake Morrison","West"),("Sarah Chen","East"),("Marcus Williams","Central"),("Priya Patel","Southeast"),("Tom Henderson","Northeast")]
SOURCES = ["Web","Referral","Trade Show","Cold Call","Partner","Inbound"]
LEAD_STATUSES = ["New","Contacted","Qualified","Proposal","Converted","Lost"]
OPP_STAGES = ["Prospecting","Discovery","Proposal","Negotiation","Closed Won","Closed Lost"]
STAGE_PROB = {"Prospecting":10,"Discovery":25,"Proposal":50,"Negotiation":75,"Closed Won":100,"Closed Lost":0}
COMPETITORS = ["Salesforce","HubSpot","Zoho","Monday","None"]
ACTIVITY_TYPES = ["Call","Email","Meeting","Demo","Follow-up","Proposal Sent"]
OUTCOMES = ["Completed","No Answer","Rescheduled","Interested","Not Interested"]

PRODUCTS = [
    {"Product ID":"PROD-001","Name":"CloudSync Pro","Description":"Enterprise SaaS collaboration platform","Category":"SaaS Platform","SKU":"CSP-ENT-001","List Price":"$15,000/yr","Discount Max":"15%","Margin":"82%","Status":"Active","Tier":"Enterprise"},
    {"Product ID":"PROD-002","Name":"CloudSync Basic","Description":"Cloud sync for small teams","Category":"SaaS Platform","SKU":"CSB-SMB-002","List Price":"$5,000/yr","Discount Max":"10%","Margin":"78%","Status":"Active","Tier":"SMB"},
    {"Product ID":"PROD-003","Name":"DataVault Enterprise","Description":"High-availability encrypted data storage","Category":"Data Storage","SKU":"DVE-ENT-003","List Price":"$25,000/yr","Discount Max":"15%","Margin":"75%","Status":"Active","Tier":"Enterprise"},
    {"Product ID":"PROD-004","Name":"DataVault Standard","Description":"Cloud storage for mid-size orgs","Category":"Data Storage","SKU":"DVS-MID-004","List Price":"$8,000/yr","Discount Max":"20%","Margin":"72%","Status":"Active","Tier":"Mid-Market"},
    {"Product ID":"PROD-005","Name":"SecureEdge Firewall","Description":"Next-gen enterprise firewall with AI threat detection","Category":"Security","SKU":"SEF-ENT-005","List Price":"$12,000/yr","Discount Max":"15%","Margin":"80%","Status":"Active","Tier":"Enterprise"},
    {"Product ID":"PROD-006","Name":"SecureEdge Lite","Description":"Lightweight network security for small offices","Category":"Security","SKU":"SEL-SMB-006","List Price":"$3,500/yr","Discount Max":"10%","Margin":"85%","Status":"Active","Tier":"SMB"},
    {"Product ID":"PROD-007","Name":"AnalyticsPro Suite","Description":"Full-featured BI platform with real-time dashboards","Category":"Analytics","SKU":"APS-ENT-007","List Price":"$18,000/yr","Discount Max":"15%","Margin":"77%","Status":"Active","Tier":"Enterprise"},
    {"Product ID":"PROD-008","Name":"AnalyticsPro Starter","Description":"Entry-level analytics with report templates","Category":"Analytics","SKU":"APS-MID-008","List Price":"$6,000/yr","Discount Max":"20%","Margin":"74%","Status":"Active","Tier":"Mid-Market"},
    {"Product ID":"PROD-009","Name":"CommHub Unified","Description":"Unified comms: voice, video, messaging","Category":"Communications","SKU":"CHU-MID-009","List Price":"$9,500/yr","Discount Max":"20%","Margin":"70%","Status":"Active","Tier":"Mid-Market"},
    {"Product ID":"PROD-010","Name":"CommHub Team","Description":"Team messaging and video for small business","Category":"Communications","SKU":"CHT-SMB-010","List Price":"$2,500/yr","Discount Max":"10%","Margin":"83%","Status":"Active","Tier":"SMB"},
]
PROD_NAMES = [p["Name"] for p in PRODUCTS]

COMPANIES = ["Apex Dynamics","BrightPath Solutions","Cascade Technologies","Drift Innovations","EcoSphere Labs",
    "Falcon Ridge Partners","GreenLeaf Systems","Horizon Digital","Ironclad Networks","Jetstream Analytics",
    "Keystone Ventures","Luminary Corp","Meridian Group","NovaTech Industries","Oakmont Financial",
    "Pinnacle Software","Quantum Bridge","Redwood Consulting","Summit Health IT","TerraFirma Solutions",
    "Uplift Robotics","Vanguard Media","Wavelength Comm","Xenith Logistics","YieldPoint Capital",
    "Zenith Manufacturing","Atlas Biotech","Beacon Analytics","Cobalt Data Systems","Deltix Engineering",
    "Ember Security","FrostByte Computing","Granite Cloud","HiveWorks Digital","Indigo Platforms",
    "Jade Systems","Kestrel Aerospace","Lynx Telecom","Mosaic Retail Tech","Nimbus Infrastructure"]

FIRSTS = ["James","Emily","Robert","Jessica","Michael","Ashley","David","Amanda","Daniel","Sophia",
    "Christopher","Olivia","Matthew","Isabella","Andrew","Mia","Joshua","Charlotte","Ryan","Harper",
    "Brandon","Evelyn","Nathan","Abigail","Kevin","Elizabeth","Brian","Avery","Tyler","Ella",
    "Jason","Scarlett","Justin","Grace","Eric","Victoria","Steven","Riley","Patrick","Aria"]

LASTS = ["Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Anderson",
    "Taylor","Thomas","Hernandez","Moore","Martin","Jackson","Thompson","White","Lopez","Lee",
    "Harris","Clark","Lewis","Robinson","Walker","Young","Allen","King","Wright","Scott",
    "Torres","Nguyen","Hill","Flores","Green","Adams","Nelson","Baker","Gonzalez","Campbell"]

SCORE_RANGES = {"New":(10,30),"Contacted":(25,50),"Qualified":(50,75),"Proposal":(70,90),"Converted":(85,100),"Lost":(5,60)}

def build_leads():
    leads = []
    for i in range(40):
        rep, terr = REPS[i % 5]
        st = random.choice(LEAD_STATUSES)
        lo, hi = SCORE_RANGES[st]
        f, l, co = FIRSTS[i], LASTS[i], COMPANIES[i]
        leads.append({"Lead ID":f"LD{i+1:03d}","First Name":f,"Last Name":l,"Company":co,
            "Email":f"{f.lower()}.{l.lower()}@{co.lower().replace(' ','')}.com","Phone":phone(),
            "Source":random.choice(SOURCES),"Status":st,"Assigned To":rep,"Territory":terr,
            "Lead Score":str(random.randint(lo,hi)),"Notes":f"Interested in {random.choice(PROD_NAMES)}.",
            "Last Contact":dpast(30),"Created Date":dpast(60)})
    return leads

AMOUNTS = [5000,8500,12000,15000,18500,22000,25000,32000,38000,45000,52000,60000,72000,85000,95000,
    110000,125000,140000,150000,48000,6500,9800,14500,19000,27500,35000,41000,55000,68000,99000]
NEXT_STEPS = {"Prospecting":"Schedule intro call","Discovery":"Send requirements questionnaire",
    "Proposal":"Deliver formal proposal","Negotiation":"Review contract with legal",
    "Closed Won":"Initiate onboarding","Closed Lost":"Archive and follow up in 6 months"}

def build_opps():
    opps = []
    for i in range(30):
        rep, terr = REPS[i % 5]
        stage = random.choice(OPP_STAGES)
        prod = random.choice(PROD_NAMES)
        co = random.choice(COMPANIES)
        amt = AMOUNTS[i]
        contact = f"{random.choice(FIRSTS)} {random.choice(LASTS)}"
        opps.append({"Opportunity ID":f"OPP{i+1:03d}","Name":f"{co} - {prod} Deal",
            "Account":co,"Contact":contact,"Stage":stage,"Amount":f"${amt:,}",
            "Close Date":drange(30,90),"Probability":f"{STAGE_PROB[stage]}%","Territory":terr,
            "Assigned To":rep,"Product":prod,"Lead Source":random.choice(SOURCES),
            "Description":f"Opportunity for {prod} with {co}.","Next Steps":NEXT_STEPS[stage],
            "Created Date":dpast(45),"Last Activity":dpast(7),
            "Days In Stage":str(random.randint(1,21)),"Competitor":random.choice(COMPETITORS)})
    return opps

SUBJ = {"Call":["Call with {c}","Follow-up call re {p}","Pricing call"],"Email":["Sent overview to {c}","Follow-up email","Shared case study"],
    "Meeting":["Meeting with {co} team","Executive briefing","Planning session"],"Demo":["{p} demo for {co}","Technical deep-dive","Executive demo"],
    "Follow-up":["Post-demo follow-up","Check proposal status","Reconnect"],"Proposal Sent":["Formal proposal for {p}","Revised pricing","Multi-year proposal"]}
DUR = {"Call":(10,45),"Email":(5,15),"Meeting":(30,90),"Demo":(30,60),"Follow-up":(5,30),"Proposal Sent":(15,45)}
REP_WEIGHTS = {"Jake Morrison":16,"Sarah Chen":15,"Marcus Williams":12,"Priya Patel":11,"Tom Henderson":6}

def build_activities(leads, opps):
    acts = []
    pool = []
    for r, w in REP_WEIGHTS.items(): pool.extend([r]*w)
    rep_terr = dict(REPS)
    for i in range(60):
        rep = pool[i % len(pool)]
        terr = rep_terr[rep]
        typ = random.choice(ACTIVITY_TYPES)
        if random.random() < 0.5:
            ld = random.choice(leads)
            rt, rid, co, c, p = "Lead", ld["Lead ID"], ld["Company"], f"{ld['First Name']} {ld['Last Name']}", random.choice(PROD_NAMES)
        else:
            op = random.choice(opps)
            rt, rid, co, c, p = "Opportunity", op["Opportunity ID"], op["Account"], op["Contact"], op["Product"]
        subj = random.choice(SUBJ[typ]).format(c=c, co=co, p=p)
        outcome = random.choice(OUTCOMES)
        lo, hi = DUR[typ]
        fu = dfut(14) if outcome in ("Rescheduled","Interested","No Answer") else ""
        acts.append({"Activity ID":f"ACT{i+1:03d}","Type":typ,"Subject":subj,"Details":f"{typ} activity. {outcome}.",
            "Related To":rt,"Related ID":rid,"Assigned To":rep,"Activity Date":dpast(14),
            "Duration":str(random.randint(lo,hi)),"Outcome":outcome,"Follow Up Date":fu,"Territory":terr})
    return acts

print("CRM Seed Script")
total_ok = total_fail = 0
for slug, data, label in [("products", PRODUCTS, "Products")]:
    ok, fail = submit_batch(slug, data, label)
    total_ok += ok; total_fail += fail

leads = build_leads()
ok, fail = submit_batch("leads", leads, "Leads")
total_ok += ok; total_fail += fail

opps = build_opps()
ok, fail = submit_batch("opportunities", opps, "Opportunities")
total_ok += ok; total_fail += fail

acts = build_activities(leads, opps)
ok, fail = submit_batch("activities", acts, "Activities")
total_ok += ok; total_fail += fail

print(f"\nCOMPLETE: {total_ok} ok, {total_fail} fail (of {total_ok+total_fail} total)")
