#!/usr/bin/env python3
"""Seed 1000 realistic small-business assets into Kinetic."""
import json, random, string, urllib.request, ssl, base64, datetime, os
from concurrent.futures import ThreadPoolExecutor, as_completed

KINETIC_URL = os.environ.get("KINETIC_URL", "https://localhost")
KINETIC_USER = os.environ.get("KINETIC_USER", "admin")
KINETIC_PASS = os.environ.get("KINETIC_PASS", "admin")
URL = f"{KINETIC_URL}/app/api/v1/kapps/asset-management/forms/assets/submissions"
AUTH = "Basic " + base64.b64encode(f"{KINETIC_USER}:{KINETIC_PASS}".encode()).decode()
CTX = ssl._create_unverified_context()

random.seed(42)

DEPARTMENTS = ["IT", "Sales", "Marketing", "Finance", "HR", "Operations", "Engineering", "Executive", "Legal", "Facilities"]
LOCATIONS = ["HQ-1F-101", "HQ-1F-102", "HQ-1F-103", "HQ-2F-201", "HQ-2F-202", "HQ-2F-203", "HQ-3F-301", "HQ-3F-302", "Branch-East-101", "Branch-East-102", "Branch-West-101", "Branch-West-102", "Warehouse-A", "Warehouse-B", "Remote"]

PEOPLE = [
    "john.doe", "jane.smith", "mike.johnson", "sarah.williams", "david.brown",
    "lisa.jones", "chris.davis", "emily.miller", "james.wilson", "amanda.moore",
    "robert.taylor", "jennifer.anderson", "william.thomas", "jessica.jackson", "daniel.white",
    "ashley.harris", "matthew.martin", "nicole.thompson", "andrew.garcia", "stephanie.martinez",
    "ryan.robinson", "megan.clark", "kevin.lewis", "laura.lee", "brian.walker",
    "rachel.hall", "jason.allen", "kimberly.young", "joshua.hernandez", "michelle.king",
    "tyler.wright", "heather.lopez", "jacob.hill", "amber.scott", "nathan.green",
    "christina.adams", "justin.baker", "samantha.nelson", "brandon.carter", "tiffany.mitchell",
    "patrick.perez", "vanessa.roberts", "sean.turner", "monica.phillips", "eric.campbell",
    "katherine.parker", "adam.evans", "courtney.edwards", "mark.collins", "hannah.stewart"
]

STATUS_WEIGHTS = [("Active", 70), ("In Storage", 10), ("Maintenance", 5), ("Retired", 10), ("Disposed", 3), ("Lost", 2)]
CONDITION_MAP = {"Active": ["Excellent", "Good", "Good", "Fair"], "In Storage": ["Good", "Good", "Fair"], "Maintenance": ["Fair", "Poor"], "Retired": ["Fair", "Poor", "Poor"], "Disposed": ["Poor"], "Lost": ["Unknown"]}

def pick_status():
    r = random.randint(1, 100)
    cum = 0
    for s, w in STATUS_WEIGHTS:
        cum += w
        if r <= cum:
            return s
    return "Active"

def rand_date(start_year=2019, end_year=2025):
    d = datetime.date(start_year, 1, 1) + datetime.timedelta(days=random.randint(0, (datetime.date(end_year, 12, 31) - datetime.date(start_year, 1, 1)).days))
    return d.isoformat()

def money(lo, hi):
    return f"${random.randint(lo, hi):,}"

def make_serial():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=12))

# Asset templates: (category, subcategory, manufacturer_pool, model_pool, cost_range, useful_life, warranty_years)
TEMPLATES = []

# Hardware - Laptops (150)
for _ in range(150):
    mfg = random.choice(["Dell", "Lenovo", "HP", "Apple"])
    models = {"Dell": ["Latitude 5540", "Latitude 7440", "XPS 15", "XPS 13", "Precision 5680"],
              "Lenovo": ["ThinkPad X1 Carbon", "ThinkPad T14s", "ThinkPad E16", "IdeaPad 5 Pro"],
              "HP": ["EliteBook 860", "ProBook 450", "ZBook Studio", "Dragonfly G4"],
              "Apple": ["MacBook Pro 14\"", "MacBook Pro 16\"", "MacBook Air M3", "MacBook Air 15\""]}
    TEMPLATES.append(("Hardware", "Laptop", mfg, random.choice(models[mfg]), (800, 3200), 4, random.choice([1, 3])))

# Hardware - Desktops (80)
for _ in range(80):
    mfg = random.choice(["Dell", "HP", "Lenovo", "Apple"])
    models = {"Dell": ["OptiPlex 7010", "OptiPlex 5000", "Precision 3660"],
              "HP": ["ProDesk 400", "EliteDesk 800", "Z2 Tower"],
              "Lenovo": ["ThinkCentre M70q", "ThinkCentre M90s", "ThinkStation P3"],
              "Apple": ["Mac Mini M3", "iMac 24\"", "Mac Studio", "Mac Pro"]}
    TEMPLATES.append(("Hardware", "Desktop", mfg, random.choice(models[mfg]), (600, 4500), 5, random.choice([1, 3])))

# Hardware - Monitors (120)
for _ in range(120):
    mfg = random.choice(["Dell", "LG", "Samsung", "ASUS", "BenQ"])
    models = {"Dell": ["U2723QE 27\"", "P2722H 27\"", "U3423WE 34\"", "S2422HG 24\""],
              "LG": ["27UL850 27\"", "34WN80C 34\"", "27GP850 27\"", "32UN880 32\""],
              "Samsung": ["S27A800 27\"", "CJ791 34\"", "M8 32\"", "ViewFinity S9"],
              "ASUS": ["ProArt PA279CRV", "VG27AQ1A", "PA348CGV 34\""],
              "BenQ": ["PD2725U 27\"", "EW3280U 32\"", "GW2480 24\""]}
    TEMPLATES.append(("Hardware", "Monitor", mfg, random.choice(models[mfg]), (200, 1200), 6, random.choice([1, 3])))

# Hardware - Printers (30)
for _ in range(30):
    mfg = random.choice(["HP", "Brother", "Canon", "Epson"])
    models = {"HP": ["LaserJet Pro M404", "Color LaserJet Pro M454", "OfficeJet Pro 9025"],
              "Brother": ["HL-L8360CDW", "MFC-L3770CDW", "MFC-J4535DW"],
              "Canon": ["imageCLASS MF743Cdw", "PIXMA TR8620", "imageRUNNER 2625i"],
              "Epson": ["WorkForce Pro WF-4830", "EcoTank ET-5850", "Expression XP-5200"]}
    TEMPLATES.append(("Hardware", "Printer", mfg, random.choice(models[mfg]), (200, 2500), 5, random.choice([1, 2])))

# Hardware - Servers (15)
for _ in range(15):
    mfg = random.choice(["Dell", "HPE", "Lenovo"])
    models = {"Dell": ["PowerEdge R760", "PowerEdge R660", "PowerEdge T560"],
              "HPE": ["ProLiant DL380 Gen11", "ProLiant DL360 Gen11", "ProLiant ML350 Gen11"],
              "Lenovo": ["ThinkSystem SR650 V3", "ThinkSystem SR630 V3"]}
    TEMPLATES.append(("Hardware", "Server", mfg, random.choice(models[mfg]), (5000, 25000), 7, 3))

# Hardware - Phones (60)
for _ in range(60):
    typ = random.choice(["mobile", "mobile", "desk"])
    if typ == "mobile":
        mfg = random.choice(["Apple", "Samsung", "Google"])
        models = {"Apple": ["iPhone 15", "iPhone 15 Pro", "iPhone 14", "iPhone SE"],
                  "Samsung": ["Galaxy S24", "Galaxy A54", "Galaxy S23 FE"],
                  "Google": ["Pixel 8", "Pixel 8 Pro", "Pixel 7a"]}
        TEMPLATES.append(("Hardware", "Mobile Phone", mfg, random.choice(models[mfg]), (400, 1400), 3, 1))
    else:
        mfg = random.choice(["Cisco", "Polycom", "Yealink"])
        models = {"Cisco": ["IP Phone 8845", "IP Phone 7841", "Webex Desk Pro"],
                  "Polycom": ["VVX 450", "VVX 350", "CCX 600"],
                  "Yealink": ["T54W", "T57W", "MP56"]}
        TEMPLATES.append(("Hardware", "Desk Phone", mfg, random.choice(models[mfg]), (150, 800), 7, 1))

# Hardware - Tablets (25)
for _ in range(25):
    mfg = random.choice(["Apple", "Samsung", "Microsoft"])
    models = {"Apple": ["iPad Pro 12.9\"", "iPad Air 11\"", "iPad 10th Gen", "iPad Mini 6"],
              "Samsung": ["Galaxy Tab S9", "Galaxy Tab A9+", "Galaxy Tab S9 FE"],
              "Microsoft": ["Surface Pro 10", "Surface Go 4"]}
    TEMPLATES.append(("Hardware", "Tablet", mfg, random.choice(models[mfg]), (350, 1800), 4, 1))

# Hardware - Network (25)
for _ in range(25):
    typ = random.choice(["Switch", "Access Point", "Firewall", "Router"])
    mfg_map = {"Switch": [("Cisco", ["Catalyst 9200L-24", "Catalyst 9300-48", "CBS350-24"]), ("HPE", ["Aruba 6100 24G", "Aruba 6300M"])],
               "Access Point": [("Ubiquiti", ["U6 Pro", "U6 Enterprise", "U6 Lite"]), ("Cisco", ["Meraki MR46", "Meraki MR56"]), ("Aruba", ["AP-535", "AP-505"])],
               "Firewall": [("Fortinet", ["FortiGate 60F", "FortiGate 100F", "FortiGate 200F"]), ("Palo Alto", ["PA-440", "PA-450", "PA-460"])],
               "Router": [("Cisco", ["ISR 1100", "ISR 4331", "Catalyst 8200"]), ("Juniper", ["SRX345", "SRX380"])]}
    choice = random.choice(mfg_map[typ])
    TEMPLATES.append(("Hardware", typ, choice[0], random.choice(choice[1]), (300, 8000), 7, random.choice([1, 3, 5])))

# Software Licenses (200)
sw_items = [
    ("Microsoft", "Microsoft 365 Business Premium", (132, 264)),
    ("Microsoft", "Microsoft 365 E3", (264, 432)),
    ("Microsoft", "Windows 11 Pro License", (150, 200)),
    ("Microsoft", "Visio Plan 2", (120, 180)),
    ("Microsoft", "Project Plan 3", (180, 360)),
    ("Adobe", "Creative Cloud All Apps", (600, 840)),
    ("Adobe", "Acrobat Pro DC", (180, 240)),
    ("Atlassian", "Jira Software Cloud", (84, 168)),
    ("Atlassian", "Confluence Cloud", (60, 120)),
    ("Slack", "Slack Business+", (150, 252)),
    ("Zoom", "Zoom Workplace Business", (132, 220)),
    ("Salesforce", "Sales Cloud Enterprise", (1800, 3600)),
    ("Autodesk", "AutoCAD LT", (440, 880)),
    ("JetBrains", "IntelliJ IDEA Ultimate", (500, 600)),
    ("GitHub", "GitHub Enterprise", (252, 252)),
    ("Okta", "Okta Identity Cloud", (72, 144)),
    ("CrowdStrike", "Falcon Pro", (100, 200)),
    ("ServiceNow", "ITSM Standard", (1200, 2400)),
    ("Tableau", "Tableau Creator", (840, 840)),
    ("DocuSign", "DocuSign Business Pro", (300, 480)),
]
for _ in range(200):
    item = random.choice(sw_items)
    TEMPLATES.append(("Software", "License", item[0], item[1], item[2], 3, 1))

# Furniture (150)
furn = [
    ("Desk", [("Herman Miller", "Nevi Sit-Stand", (800, 1500)), ("Steelcase", "Migration SE", (600, 1200)), ("IKEA", "BEKANT", (200, 500)), ("Uplift", "V2 Standing Desk", (500, 900))]),
    ("Chair", [("Herman Miller", "Aeron", (1200, 1800)), ("Steelcase", "Leap V2", (1000, 1600)), ("Steelcase", "Think", (700, 1000)), ("IKEA", "MARKUS", (200, 300)), ("Humanscale", "Freedom", (900, 1400))]),
    ("Filing Cabinet", [("HON", "310 Series 4-Drawer", (300, 600)), ("Steelcase", "Lateral File", (400, 800)), ("IKEA", "GALANT", (100, 250))]),
    ("Whiteboard", [("Quartet", "Prestige 2 6x4", (150, 300)), ("VIVO", "Mobile 48x36", (80, 200))]),
    ("Conference Table", [("Steelcase", "MediaScape 8ft", (2000, 5000)), ("HON", "Preside 10ft", (1500, 3500))]),
]
furn_dist = [("Desk", 55), ("Chair", 55), ("Filing Cabinet", 20), ("Whiteboard", 12), ("Conference Table", 8)]
for subcat, count in furn_dist:
    pool = [x for x in furn if x[0] == subcat][0][1]
    for _ in range(count):
        item = random.choice(pool)
        TEMPLATES.append(("Furniture", subcat, item[0], item[1], item[2], random.choice([8, 10, 12]), 0))

# Vehicles (20)
for _ in range(20):
    mfg = random.choice(["Toyota", "Ford", "Honda", "Chevrolet", "Ram"])
    models = {"Toyota": [("Camry", (25000, 32000)), ("RAV4", (28000, 38000)), ("Tacoma", (30000, 45000))],
              "Ford": [("F-150", (33000, 55000)), ("Transit Connect", (28000, 35000)), ("Escape", (27000, 38000))],
              "Honda": [("Civic", (23000, 30000)), ("CR-V", (29000, 38000))],
              "Chevrolet": [("Silverado 1500", (35000, 55000)), ("Equinox", (27000, 35000))],
              "Ram": [("1500", (36000, 58000)), ("ProMaster City", (30000, 38000))]}
    choice = random.choice(models[mfg])
    TEMPLATES.append(("Vehicle", random.choice(["Company Car", "Fleet Van", "Delivery Truck", "Company Car"]),
                       mfg, choice[0], choice[1], 5, 3))

# Equipment (105)
equip = [
    ("Projector", [("Epson", "PowerLite 2250U", (700, 2000)), ("BenQ", "MH733", (500, 1200)), ("Optoma", "UHD38x", (900, 1800))]),
    ("Camera", [("Canon", "EOS R6 II", (1800, 2500)), ("Sony", "A7 IV", (2000, 2800)), ("Logitech", "Brio 4K Webcam", (150, 200))]),
    ("UPS", [("APC", "Smart-UPS 1500VA", (400, 900)), ("CyberPower", "CP1500PFCLCD", (200, 400)), ("Eaton", "5P 1550iR", (500, 1000))]),
    ("Conference System", [("Poly", "Studio X50", (2000, 4000)), ("Logitech", "Rally Plus", (3000, 5000)), ("Cisco", "Room Kit Mini", (4000, 8000))]),
    ("Scanner", [("Fujitsu", "ScanSnap iX1600", (350, 500)), ("Epson", "DS-530 II", (300, 450)), ("Brother", "ADS-4900W", (500, 800))]),
    ("Docking Station", [("Dell", "WD19TBS Thunderbolt", (200, 350)), ("Lenovo", "ThinkPad USB-C Dock", (150, 300)), ("CalDigit", "TS4", (350, 400))]),
    ("External Storage", [("Synology", "DS920+", (500, 700)), ("QNAP", "TS-464", (450, 650)), ("WD", "My Cloud EX2 Ultra", (200, 400))]),
]
equip_dist = [("Projector", 12), ("Camera", 10), ("UPS", 20), ("Conference System", 15), ("Scanner", 15), ("Docking Station", 20), ("External Storage", 13)]
for subcat, count in equip_dist:
    pool = [x for x in equip if x[0] == subcat][0][1]
    for _ in range(count):
        item = random.choice(pool)
        TEMPLATES.append(("Equipment", subcat, item[0], item[1], item[2], random.choice([5, 7]), random.choice([1, 2, 3])))

print(f"Generated {len(TEMPLATES)} asset templates")

# Build 1000 assets
assets = []
for i, t in enumerate(TEMPLATES[:1000]):
    cat, subcat, mfg, model, cost_range, useful_life, warranty_years = t
    asset_id = f"AST-{i+1:04d}"
    status = pick_status()
    condition = random.choice(CONDITION_MAP.get(status, ["Good"]))
    purchase_date = rand_date(2019, 2025)
    cost = random.randint(cost_range[0], cost_range[1])
    salvage = round(cost * random.uniform(0.05, 0.15))
    warranty_start = purchase_date
    if warranty_years > 0:
        wd = datetime.date.fromisoformat(purchase_date) + datetime.timedelta(days=warranty_years * 365)
        warranty_exp = wd.isoformat()
        warranty_type = random.choice(["Standard", "Extended"]) if warranty_years > 1 else "Standard"
        warranty_provider = mfg
    else:
        warranty_exp = ""
        warranty_type = "None"
        warranty_provider = ""
        warranty_start = ""

    assigned_to = ""
    department = random.choice(DEPARTMENTS)
    if status == "Active" and cat != "Software":
        assigned_to = random.choice(PEOPLE) if random.random() < 0.85 else ""

    location = random.choice(LOCATIONS)
    if status in ("Disposed", "Lost"):
        location = ""
        assigned_to = ""
    if status == "In Storage":
        location = random.choice(["Warehouse-A", "Warehouse-B"])
        assigned_to = ""
    if cat == "Software":
        location = "N/A"
    if cat == "Vehicle":
        location = random.choice(["Parking-A", "Parking-B", "Field", "Branch-East", "Branch-West"])

    # related assets: ~20% chance to link to 1-3 nearby assets
    related = ""
    if random.random() < 0.2 and i > 5:
        rel_count = random.randint(1, 3)
        rel_ids = [f"AST-{random.randint(max(1,i-50), i):04d}" for _ in range(rel_count)]
        related = ", ".join(set(rel_ids))

    pd = datetime.date.fromisoformat(purchase_date)
    audit_offset = random.randint(30, 365)
    last_audit = (pd + datetime.timedelta(days=random.randint(180, 900))).isoformat()
    if datetime.date.fromisoformat(last_audit) > datetime.date(2026, 2, 12):
        last_audit = "2026-01-15"

    name = f"{mfg} {model}"
    if cat == "Software":
        name = model  # e.g., "Microsoft 365 Business Premium"

    assets.append({
        "Asset ID": asset_id,
        "Asset Name": name,
        "Category": cat,
        "Subcategory": subcat,
        "Manufacturer": mfg,
        "Model": model,
        "Serial Number": make_serial() if cat != "Software" else f"LIC-{make_serial()[:8]}",
        "Purchase Date": purchase_date,
        "Purchase Cost": f"${cost:,}",
        "Salvage Value": f"${salvage:,}",
        "Useful Life": f"{useful_life} years",
        "Depreciation Method": "Straight Line",
        "Warranty Start": warranty_start,
        "Warranty Expiration": warranty_exp,
        "Warranty Provider": warranty_provider,
        "Warranty Type": warranty_type,
        "Status": status,
        "Condition": condition,
        "Assigned To": assigned_to,
        "Department": department,
        "Location": location,
        "Related Assets": related,
        "Notes": "",
        "Last Audit Date": last_audit
    })

print(f"Built {len(assets)} assets, starting upload...")

ok = 0
fail = 0

def post_asset(asset):
    data = json.dumps({"values": asset}).encode()
    req = urllib.request.Request(URL, data=data, headers={
        "Authorization": AUTH,
        "Content-Type": "application/json",
        "Accept": "application/json"
    })
    resp = urllib.request.urlopen(req, context=CTX, timeout=30)
    return resp.status

with ThreadPoolExecutor(max_workers=10) as pool:
    futures = {pool.submit(post_asset, a): a["Asset ID"] for a in assets}
    for i, f in enumerate(as_completed(futures), 1):
        aid = futures[f]
        try:
            f.result()
            ok += 1
        except Exception as e:
            fail += 1
            print(f"  FAIL {aid}: {e}")
        if i % 100 == 0:
            print(f"  Progress: {i}/1000 ({ok} ok, {fail} fail)")

print(f"\nDone! {ok} created, {fail} failed.")
