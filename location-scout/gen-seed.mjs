#!/usr/bin/env node
/**
 * gen-seed.mjs — emits seed-data.json for Location Scout MN.
 *
 * Generated data is held to the invariants audit.mjs checks:
 *  - Prospect locations have no scout reports (never visited)
 *  - Scouted/Cleared/Restricted locations have >=1 scout report
 *  - Holds only exist on Cleared/Restricted locations; Confirmed holds never overlap
 *  - Every Primary Contact Code resolves to a contact ON that location
 *  - Photo Setting never contradicts the location's own Setting
 *  - Review/issue/expiry fields exist exactly when their status requires them
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));

// Deterministic PRNG so reruns produce identical data (idempotent reseeds).
let _s = 20260901;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const pickN = (a, n) => { const c = [...a]; const o = []; while (o.length < n && c.length) o.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return o; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = p => rnd() < p;
const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const TODAY = new Date('2026-09-01T00:00:00Z');

// [name, city, county, region, category, subType, setting, periodLook, lat, lon]
const LOCS = [
  ['Stone Arch Bridge Overlook','Minneapolis','Hennepin','Twin Cities Metro','Urban Street','Bridge / Riverfront','Exterior','Timeless',44.9803,-93.2564],
  ['Mill City Ruins Courtyard','Minneapolis','Hennepin','Twin Cities Metro','Historic','Ruins / Industrial','Both','Industrial Era',44.9785,-93.2565],
  ['Northeast Arts District Warehouse','Minneapolis','Hennepin','Twin Cities Metro','Industrial','Warehouse','Interior','Industrial Era',44.9990,-93.2560],
  ['Summit Avenue Mansion','Saint Paul','Ramsey','Twin Cities Metro','Residential','Historic Mansion','Both','Victorian',44.9400,-93.1300],
  ['Cathedral Hill Rowhouse','Saint Paul','Ramsey','Twin Cities Metro','Residential','Rowhouse','Both','Victorian',44.9464,-93.1100],
  ['Midtown Global Market Hall','Minneapolis','Hennepin','Twin Cities Metro','Commercial','Market Hall','Interior','Contemporary',44.9483,-93.2620],
  ['Foshay Tower Observation Deck','Minneapolis','Hennepin','Twin Cities Metro','Historic','High Rise','Both','Mid-Century',44.9740,-93.2716],
  ['Como Park Conservatory','Saint Paul','Ramsey','Twin Cities Metro','Institutional','Conservatory','Interior','Victorian',44.9836,-93.1516],
  ['Fort Snelling Parade Ground','Saint Paul','Hennepin','Twin Cities Metro','Historic','Fort / Military','Exterior','Historic',44.8928,-93.1810],
  ['Minnehaha Falls Glen','Minneapolis','Hennepin','Twin Cities Metro','Recreation','Waterfall / Park','Exterior','Timeless',44.9153,-93.2111],
  ['Lake of the Isles Shoreline','Minneapolis','Hennepin','Twin Cities Metro','Waterfront','Urban Lake','Exterior','Timeless',44.9537,-93.3070],
  ['Hennepin Avenue Theatre Marquee','Minneapolis','Hennepin','Twin Cities Metro','Urban Street','Theatre District','Exterior','Mid-Century',44.9784,-93.2757],
  ['Union Depot Concourse','Saint Paul','Ramsey','Twin Cities Metro','Historic','Rail Terminal','Interior','Industrial Era',44.9478,-93.0857],
  ['Uptown Corner Diner','Minneapolis','Hennepin','Twin Cities Metro','Commercial','Diner','Interior','Mid-Century',44.9490,-93.2980],
  ['Midway Rail Yard','Saint Paul','Ramsey','Twin Cities Metro','Industrial','Rail Yard','Exterior','Industrial Era',44.9600,-93.1700],
  ['Nicollet Island Cottages','Minneapolis','Hennepin','Twin Cities Metro','Residential','Cottage Row','Both','Victorian',44.9870,-93.2650],
  ['Bde Maka Ska Boat Launch','Minneapolis','Hennepin','Twin Cities Metro','Waterfront','Urban Lake','Exterior','Contemporary',44.9420,-93.3120],
  ['Bloomington Corporate Atrium','Bloomington','Hennepin','Twin Cities Metro','Commercial','Office Atrium','Interior','Contemporary',44.8408,-93.2983],
  ['Stillwater Lift Bridge','Stillwater','Washington','Twin Cities Metro','Historic','Bridge','Exterior','Industrial Era',45.0560,-92.8040],
  ['Afton Bluff Farmstead','Afton','Washington','Twin Cities Metro','Rural / Farm','Farmstead','Both','Timeless',44.9030,-92.7830],
  ['Northeast Sound Stage','Minneapolis','Hennepin','Twin Cities Metro','Interior Studio','Sound Stage','Interior','Contemporary',45.0010,-93.2480],
  ['Saint Paul Insert Stage','Saint Paul','Ramsey','Twin Cities Metro','Interior Studio','Insert Stage','Interior','Contemporary',44.9530,-93.0900],

  ['Split Rock Lighthouse Cliff','Two Harbors','Lake','North Shore','Waterfront','Lighthouse','Both','Historic',47.2003,-91.3672],
  ['Gooseberry Falls Lower Cascade','Two Harbors','Lake','North Shore','Recreation','Waterfall','Exterior','Timeless',47.1400,-91.4700],
  ['Palisade Head Overlook','Silver Bay','Lake','North Shore','Waterfront','Cliff / Overlook','Exterior','Timeless',47.3200,-91.2100],
  ['Grand Marais Harbor Point','Grand Marais','Cook','North Shore','Waterfront','Harbor','Exterior','Timeless',47.7500,-90.3340],
  ['Duluth Aerial Lift Bridge','Duluth','Saint Louis','North Shore','Historic','Bridge','Exterior','Industrial Era',46.7790,-92.0930],
  ['Canal Park Warehouse Row','Duluth','Saint Louis','North Shore','Industrial','Warehouse','Both','Industrial Era',46.7830,-92.0940],
  ['Glensheen Mansion Great Hall','Duluth','Saint Louis','North Shore','Historic','Historic Mansion','Interior','Victorian',46.8150,-92.0520],
  ['Two Harbors Ore Docks','Two Harbors','Lake','North Shore','Industrial','Ore Dock','Exterior','Industrial Era',47.0180,-91.6700],
  ['Tettegouche Birch Ridge','Silver Bay','Lake','North Shore','Forest / Wilderness','Boreal Forest','Exterior','Timeless',47.3400,-91.1900],
  ['Temperance River Gorge','Schroeder','Cook','North Shore','Forest / Wilderness','River Gorge','Exterior','Timeless',47.5490,-90.8760],

  ['Hull Rust Mahoning Mine View','Hibbing','Saint Louis','Iron Range','Industrial','Open Pit Mine','Exterior','Industrial Era',47.4400,-92.9370],
  ['Soudan Underground Mine Shaft','Soudan','Saint Louis','Iron Range','Industrial','Underground Mine','Interior','Industrial Era',47.8160,-92.2400],
  ['Chisholm Mine Head Frame','Chisholm','Saint Louis','Iron Range','Industrial','Head Frame','Exterior','Industrial Era',47.4890,-92.8840],
  ['Hibbing High School Auditorium','Hibbing','Saint Louis','Iron Range','Institutional','Auditorium','Interior','Historic',47.4270,-92.9380],
  ['Virginia Taconite Plant Yard','Virginia','Saint Louis','Iron Range','Industrial','Processing Plant','Both','Contemporary',47.5230,-92.5360],
  ['Ely Outfitter Cabin','Ely','Saint Louis','Iron Range','Rural / Farm','Cabin','Both','Timeless',47.9030,-91.8670],
  ["Miner's Row House",'Eveleth','Saint Louis','Iron Range','Residential','Company Housing','Both','Industrial Era',47.4630,-92.5400],

  ['Barn Bluff Summit','Red Wing','Goodhue','Southern Minnesota','Recreation','Bluff','Exterior','Timeless',44.5680,-92.5250],
  ['Lanesboro Main Street','Lanesboro','Fillmore','Southern Minnesota','Urban Street','Small Town Main St','Exterior','Victorian',43.7190,-91.9760],
  ['Mantorville Opera House','Mantorville','Dodge','Southern Minnesota','Historic','Opera House','Interior','Victorian',44.0680,-92.7550],
  ['Northfield Mill Race','Northfield','Rice','Southern Minnesota','Historic','Mill','Both','Industrial Era',44.4580,-93.1610],
  ['Winona Bluffside Church','Winona','Winona','Southern Minnesota','Institutional','Church','Both','Victorian',44.0500,-91.6390],
  ['Harmony Amish Farmstead','Harmony','Fillmore','Southern Minnesota','Rural / Farm','Amish Farm','Both','Timeless',43.5540,-92.0100],
  ['Great River Road Overlook','Wabasha','Wabasha','Southern Minnesota','Roadway','Scenic Highway','Exterior','Timeless',44.3840,-92.0320],
  ['Owatonna Grain Elevator','Owatonna','Steele','Southern Minnesota','Industrial','Grain Elevator','Both','Industrial Era',44.0840,-93.2260],
  ['Rochester Clinic Skyway','Rochester','Olmsted','Southern Minnesota','Institutional','Skyway','Interior','Contemporary',44.0230,-92.4660],

  ['Brainerd Lakes Resort Dock','Brainerd','Crow Wing','Central Lakes','Waterfront','Resort','Both','Mid-Century',46.3580,-94.2010],
  ['Nisswa Pine Cabin','Nisswa','Crow Wing','Central Lakes','Rural / Farm','Lake Cabin','Both','Mid-Century',46.5210,-94.2880],
  ['Mille Lacs Ice Village','Isle','Mille Lacs','Central Lakes','Waterfront','Frozen Lake','Exterior','Contemporary',46.1370,-93.4700],
  ['Alexandria Lakeside Ballroom','Alexandria','Douglas','Central Lakes','Commercial','Ballroom','Interior','Mid-Century',45.8850,-95.3770],
  ['Cuyuna Mine Lake','Crosby','Crow Wing','Central Lakes','Waterfront','Flooded Mine Pit','Exterior','Timeless',46.4820,-93.9580],
  ['Little Falls River Mill','Little Falls','Morrison','Central Lakes','Industrial','Mill','Both','Industrial Era',45.9760,-94.3620],
  ['Itasca Headwaters Trail','Park Rapids','Hubbard','Central Lakes','Forest / Wilderness','Old Growth Pine','Exterior','Timeless',47.2410,-95.2070],

  ['Moorhead Grain Terminal','Moorhead','Clay','Red River Valley','Industrial','Grain Terminal','Both','Contemporary',46.8740,-96.7670],
  ['Crookston Sugar Beet Yard','Crookston','Polk','Red River Valley','Rural / Farm','Beet Piling Yard','Exterior','Contemporary',47.7740,-96.6080],
  ['Red River Flood Levee','Moorhead','Clay','Red River Valley','Roadway','Levee','Exterior','Contemporary',46.8600,-96.7810],
  ['Prairie Grain Elevator Row','Ada','Norman','Red River Valley','Rural / Farm','Grain Elevator','Exterior','Industrial Era',47.2990,-96.5150],
  ['Thief River Falls Plant Floor','Thief River Falls','Pennington','Red River Valley','Industrial','Manufacturing Floor','Interior','Contemporary',48.1190,-96.1810],

  ['Pipestone Quarry Ledge','Pipestone','Pipestone','Southwest Prairie','Historic','Quarry','Exterior','Timeless',44.0130,-96.3250],
  ['Blue Mounds Prairie Cliff','Luverne','Rock','Southwest Prairie','Forest / Wilderness','Prairie / Cliff','Exterior','Timeless',43.7080,-96.1900],
  ['Jeffers Petroglyphs Outcrop','Comfrey','Cottonwood','Southwest Prairie','Historic','Petroglyph Site','Exterior','Timeless',44.0640,-95.0360],
  ['Buffalo Ridge Wind Farm','Lake Benton','Lincoln','Southwest Prairie','Rural / Farm','Wind Farm','Exterior','Contemporary',44.2600,-96.2870],
];

const LOC_STATUSES = ['Prospect','Scouted','Cleared','Restricted','Unavailable','Archived'];
// Weighted so every branch is populated but the catalog still looks like real inventory.
const STATUS_PLAN = ['Cleared','Cleared','Scouted','Cleared','Restricted','Scouted','Prospect','Cleared','Scouted','Unavailable','Cleared','Restricted','Scouted','Cleared','Archived','Prospect','Cleared','Scouted','Restricted','Cleared'];

const POWER = ['Shore Power','Generator Required','Limited / 20A'];
const SIGNAL = ['Strong','Moderate','Weak','None'];
const NOISE = ['None','Highway','Flight Path','Rail','Industrial','Seasonal Tourism'];
const RESTROOM = ['On Site','Portable Required','Nearby'];
const ADA = ['Yes','No','Partial'];
const LIGHT = ['Morning','Midday','Afternoon','Golden Hour','Blue Hour','Any'];
const SEASONAL = ['Year Round','Summer Only','Winter Accessible','Spring-Fall'];
const FEE = ['Flat Day Rate','Hourly','Negotiable','Free / Public','Permit Only'];
const HOSPITALS = { 'Twin Cities Metro':'HCMC — Minneapolis','North Shore':'Essentia Health St. Mary’s — Duluth','Iron Range':'Fairview Range — Hibbing','Southern Minnesota':'Mayo Clinic — Rochester','Central Lakes':'Essentia Health St. Joseph’s — Brainerd','Red River Valley':'Sanford Medical Center — Fargo','Southwest Prairie':'Avera Sacred Heart — Pipestone' };
// Features are drawn per category so a North Shore lighthouse never advertises a
// "prairie horizon". Each pool holds >= 5 entries so pickN consumes the same number
// of rnd() calls regardless of category — keeping the PRNG stream (and therefore
// every downstream entity) stable.
const FEATURES_BY_CATEGORY = {
  'Waterfront':          ['water access','open sightlines','natural backlight','dock access','big sky reflections','shoreline rock','boat approach'],
  'Recreation':          ['water access','open sightlines','natural backlight','trail access','picnic infrastructure','tree canopy','public restrooms'],
  'Forest / Wilderness': ['tree canopy','dappled light','gravel approach','remote quiet','deep snow cover','game trails','moss and deadfall'],
  'Industrial':          ['practical power','loading dock','crane clearance','tall ceilings','catwalks and gantries','rust and patina','heavy floor loading'],
  'Rural / Farm':        ['open horizon','gravel approach','weathered timber','livestock present','section-road grid','grain bins','windbreak treeline'],
  'Urban Street':        ['practical power','period storefronts','wide shoulder','streetcar rails','neon and signage','crowd control needed','skyline backdrop'],
  'Commercial':          ['practical power','tall ceilings','period fixtures','plate glass frontage','back-of-house access','freight elevator','after-hours available'],
  'Residential':         ['period fixtures','stone facade','quiet interiors','original millwork','wraparound porch','mature boulevard trees','walk-up staircase'],
  'Historic':            ['period fixtures','historic signage','stone facade','original millwork','quiet interiors','ornamental ironwork','preservation limits'],
  'Institutional':       ['tall ceilings','quiet interiors','long corridors','terrazzo floors','clerestory light','freight elevator','after-hours available'],
  'Roadway':             ['wide shoulder','open horizon','long sightlines','pull-off staging','guardrail runs','crown and camber'],
  'Interior Studio':     ['practical power','tall ceilings','crane clearance','loading dock','blackout capable','pre-rigged grid','freight elevator'],
};
const FEATURES_FALLBACK = ['practical power','open sightlines','natural backlight','gravel approach','quiet interiors','tall ceilings'];

const SCOUTS = ['Dana Whitlock','Marcus Feld','Priya Raman','Tobias Lindgren','Erin McCabe','Sam Ostrand','Nell Petrova','Ray Cortez'];
const PHOTOGS = ['Dana Whitlock','Marcus Feld','Priya Raman','Tobias Lindgren','Jules Arnesen','Sam Ostrand'];
const FIRST = ['Karen','Dale','Marta','Owen','Bev','Curtis','Ingrid','Nils','Rosa','Hank','Lena','Gus','Trina','Arne','Delia','Peter','Sylvia','Kurt','Maren','Otto','Joan','Levi','Astrid','Ben'];
const LAST = ['Halvorsen','Bergstrom','Novak','Thao','Okonkwo','Lindquist','Brekke','Vang','Ramirez','Sundgaard','Iverson','Kowalczyk','Bauer','Yang','Solberg','Ellingson','Moua','Krantz','Aune','Dahl'];
const ROLES = ['Property Owner','Property Manager','Location Agent','Business Owner','City Film Officer','County Clerk','Park Ranger','Facilities Director','Caretaker','Tribal Liaison'];

const PROJECTS = [
  ['Northern Lights','Feature Film','A24','Bright Lake Pictures','Ingmar Solveig','Ruth Kellerman','Shooting','Mid'],
  ['Ore & Ash','Feature Film','Neon','Iron Horse Films','Delia Vasquez','Nate Brandt','Locked','High'],
  ['Target — Fall Home','Commercial','Target Corporation','Periscope','Jo Kimura','Amy Nordstrom','Wrapped','High'],
  ['Land O’Lakes — Harvest','Commercial','Land O’Lakes','Colle McVoy','Rick Bauer','Sasha Lem','Wrapped','Mid'],
  ['The Boundary','TV Series','FX','Wolf River TV','Marta Chen','Owen Reilly','Scouting','Studio'],
  ['Best Buy — Blue Shirt','Commercial','Best Buy','mono','Tess Aldrich','Gil Moran','Prepping','High'],
  ['Frozen Ground','Documentary','PBS','Headwaters Docs','Aaron Tvedt','Kim Larsen','Shooting','Low'],
  ['Mayo — Second Opinion','Commercial','Mayo Clinic','Fallon','Priya Nair','Dev Shah','Locked','Mid'],
  ['Split Rock','Short Film','Independent','Grain Belt Shorts','Nora Fitch','Nora Fitch','Wrapped','Micro'],
  ['3M — Invisible Work','Commercial','3M','BBDO','Luis Herrera','Cass Wren','Scouting','High'],
  ['Prairie Static','Music Video','Sub Pop','Loon Collective','Jaz Ellingson','Marc Duval','Wrapped','Micro'],
  ['The Iron Trail','TV Series','AMC','Range Road Media','Viktor Lund','Sarah Pohl','Development','Studio'],
  ['Polaris — Off Season','Commercial','Polaris','Carmichael Lynch','Ana Duarte','Rob Tiller','Prepping','Mid'],
  ['Wintering','Feature Film','Searchlight','North Star Features','Elena Whitmore','Paul Ojeda','Cancelled','High'],
];
const PROJ_STATUSES = ['Development','Prepping','Scouting','Locked','Shooting','Wrapped','Cancelled'];
const ACTIVE_PROJ = ['Prepping','Scouting','Locked','Shooting'];

// ---------------------------------------------------------------- projects
const projects = PROJECTS.map(([title, type, client, company, dir, prod, status, tier], i) => {
  const code = `PRJ-${String(i + 1).padStart(3, '0')}`;
  // Wrapped shoots are in the past; active ones straddle or follow today.
  let start;
  if (status === 'Wrapped') start = addDays(TODAY, -int(40, 200));
  else if (status === 'Shooting') start = addDays(TODAY, -int(3, 15));
  else if (status === 'Cancelled') start = addDays(TODAY, -int(10, 60));
  else start = addDays(TODAY, int(14, 150));
  const days = type === 'Commercial' ? int(2, 5) : type === 'Music Video' ? int(1, 2) : int(12, 40);
  return {
    'Project Code': code, 'Project Title': title, 'Production Type': type,
    'Client': client, 'Production Company': company, 'Director': dir, 'Producer': prod,
    'Status': status, 'Shoot Start': iso(start), 'Shoot End': iso(addDays(start, days)),
    'Budget Tier': tier,
    'Location Budget': String({ Micro: int(3, 12), Low: int(15, 40), Mid: int(45, 120), High: int(140, 400), Studio: int(450, 900) }[tier] * 1000),
    'Union Status': type === 'Commercial' ? pick(['SAG-AFTRA','Non-Union']) : pick(['SAG-AFTRA','IATSE']),
    'Notes': `${days}-day ${type.toLowerCase()} shoot. Location budget managed by ${prod}.`,
  };
});

// ---------------------------------------------------------------- locations
const locations = LOCS.map((L, i) => {
  const [name, city, county, region, category, subType, setting, period, lat, lon] = L;
  const code = `MN-${String(i + 1).padStart(4, '0')}`;
  const status = STATUS_PLAN[i % STATUS_PLAN.length];
  const interior = setting !== 'Exterior';
  const fee = category === 'Recreation' || category === 'Forest / Wilderness' || subType === 'Scenic Highway'
    ? pick(['Permit Only','Free / Public']) : pick(FEE);
  const dayRate = fee === 'Free / Public' ? '0'
    : fee === 'Permit Only' ? String(int(2, 8) * 50)
    : String(int(6, 60) * 250);
  return {
    'Location Code': code, 'Location Name': name, 'Status': status,
    'Address': `${int(100, 9800)} ${pick(['Main St','2nd Ave','County Rd 7','Lake St','Mill Rd','Water St','Hwy 61','Range Ave'])}`,
    'City': city, 'County': county, 'Region': region,
    'Zip': String(int(55001, 56799)),
    'Latitude': lat.toFixed(4), 'Longitude': lon.toFixed(4),
    'Category': category, 'Sub Type': subType, 'Setting': setting, 'Period Look': period,
    'Square Footage': interior ? String(int(4, 90) * 500) : '',
    'Ceiling Height Ft': interior ? String(int(9, 42)) : '',
    'Max Crew Size': String(int(2, 24) * 5),
    'Parking Spaces': String(int(0, 40) * 5),
    'Base Camp Capacity': String(int(0, 12)),
    'Power Access': pick(POWER), 'Cell Signal': region === 'North Shore' || region === 'Iron Range' ? pick(['Moderate','Weak','None']) : pick(['Strong','Strong','Moderate']),
    'Noise Concerns': pick(NOISE), 'Restrooms': pick(RESTROOM), 'ADA Accessible': pick(ADA),
    'Best Light': pick(LIGHT),
    'Seasonal Access': region === 'North Shore' || region === 'Iron Range' ? pick(['Year Round','Summer Only','Winter Accessible','Spring-Fall']) : pick(['Year Round','Year Round','Spring-Fall']),
    'Nearest Hospital': HOSPITALS[region],
    'Nearest Hospital Miles': String(int(2, 65)),
    'Load In Notes': pick(['Grade-level roll-up door, 12ft clearance.','Street load-in only; permit required for lane closure.','Gravel two-track, 4WD recommended in spring thaw.','Freight elevator to floor 3, 4000 lb limit.','Carry-in 200 ft from lot; no vehicle access on turf.','Dock height 48in, single bay.']),
    'Day Rate': dayRate, 'Fee Structure': fee,
    'Permit Jurisdiction': category === 'Recreation' || category === 'Forest / Wilderness' ? pick(['MN DNR','National Park Service','County Parks']) : `City of ${city}`,
    'Insurance Required': chance(0.8) ? 'Yes' : 'No',
    'Features': pickN(FEATURES_BY_CATEGORY[category] || FEATURES_FALLBACK, int(2, 4)).join(', '),
    'Description': `${subType} in ${city}, ${county} County. ${period} character; ${setting.toLowerCase()} coverage.`,
    'Discovered By': pick(SCOUTS),
    'Discovered On': iso(addDays(TODAY, -int(30, 900))),
    'Primary Contact Code': '', // filled after contacts are generated
  };
});
const byCode = Object.fromEntries(locations.map(l => [l['Location Code'], l]));

// ---------------------------------------------------------------- contacts
const contacts = [];
let cN = 0;
const nextContact = () => `CT-${String(++cN).padStart(4, '0')}`;
for (const loc of locations) {
  // Every location gets a primary contact; ~40% get a second.
  const n = chance(0.4) ? 2 : 1;
  const roles = pickN(ROLES, n);
  let primary = null;
  for (let k = 0; k < n; k++) {
    const code = nextContact();
    const role = roles[k];
    // A location that's been declared Unavailable usually went that way via the contact.
    // The primary contact on an Unavailable location is the reason it's unavailable.
    const status = (loc['Status'] === 'Unavailable' && k === 0) ? 'Do Not Contact'
      : loc['Status'] === 'Unavailable' ? pick(['Unresponsive','Former'])
      : loc['Status'] === 'Archived' ? pick(['Former','Active'])
      : chance(0.12) ? pick(['Unresponsive','Former']) : 'Active';
    contacts.push({
      'Contact Code': code,
      'Full Name': `${pick(FIRST)} ${pick(LAST)}`,
      'Role': role,
      'Organization': role === 'City Film Officer' ? `City of ${loc['City']}` : role === 'Park Ranger' ? 'MN DNR' : role === 'County Clerk' ? `${loc['County']} County` : pick(['Northern Light Properties','Range Holdings LLC','Lakeside Management','Private Owner','Heritage Trust','Mill District Partners']),
      'Email': `${role.split(' ')[0].toLowerCase()}.${loc['Location Code'].toLowerCase()}@example.com`,
      'Phone': `(${pick(['612','651','218','507','320'])}) ${int(200,999)}-${String(int(1000,9999))}`,
      'Preferred Contact': pick(['Phone','Email','Text']),
      'Location Code': loc['Location Code'],
      'City': loc['City'], 'Region': loc['Region'],
      'Best Time To Reach': pick(['Weekday mornings','Afternoons after 2pm','Evenings','Weekends only','Anytime']),
      'Status': status,
      'Notes': pick(['Prefers 2 weeks notice for any crew over 20.','Will not permit shooting during business hours.','Requires COI naming the county as additional insured.','Very responsive; has hosted crews before.','Only reachable by text during the season.','Wants a location fee quote in writing before any visit.']),
    });
    if (k === 0) primary = code;
  }
  loc['Primary Contact Code'] = primary;
}

// ---------------------------------------------------------------- scout reports
// Prospect locations have NEVER been visited -> no reports. Everything else has >=1.
const VISITED = locations.filter(l => l['Status'] !== 'Prospect');
const reports = [];
let rN = 0;
const REC = ['Strong Fit','Possible Fit','Backup Option','Not Suitable'];
const REPORT_STATUSES = ['Draft','Submitted','Under Review','Approved','Rejected','Archived'];
for (let i = 0; i < VISITED.length; i++) {
  const loc = VISITED[i];
  const n = chance(0.35) ? 2 : 1;
  for (let k = 0; k < n; k++) {
    const code = `SR-${String(++rN).padStart(4, '0')}`;
    // Cycle statuses so every branch is represented rather than clustering on the happy path.
    const status = REPORT_STATUSES[(rN + k) % REPORT_STATUSES.length];
    const rec = loc['Status'] === 'Unavailable' ? 'Not Suitable'
      : loc['Status'] === 'Cleared' ? pick(['Strong Fit','Strong Fit','Possible Fit'])
      : pick(REC);
    const visit = addDays(TODAY, -int(10, 500));
    const reviewed = status === 'Approved' || status === 'Rejected';
    const proj = chance(0.75) ? pick(projects)['Project Code'] : '';
    reports.push({
      'Report Code': code, 'Location Code': loc['Location Code'], 'Project Code': proj,
      'Scout Name': pick(SCOUTS), 'Visit Date': iso(visit),
      'Status': status, 'Recommendation': rec,
      'Weather Conditions': pick(['Overcast, 41F','Clear, 68F','Light snow, 18F','Rain, 52F','Windy, 34F','Humid, 81F','Fog off the lake, 45F']),
      'Sun Notes': pick(['Sun clears the ridge by 9:40am; east face is in shade until then.','Full south exposure all day — expect to net the windows.','Golden hour hits the facade dead-on at 6:15pm in October.','Heavy canopy; usable light only midday.','Reflected glare off the water after 3pm.']),
      'Sound Notes': pick(['Quiet except for hourly freight.','Highway wash is constant at ~62dB.','Flight path overhead every 4-6 minutes.','Room tone is excellent — hard surfaces, minimal HVAC.','Tourist foot traffic all summer; shoot shoulder season.']),
      'Access Notes': pick(['Two-track road, dry only.','Loading from the alley; 15 min unload limit.','Gate code required, caretaker must be on site.','Public access — no gate, no control.','Elevator access only, 6ft max load length.']),
      'Power Notes': pick(['200A tie-in available in the basement panel.','No shore power — genny required, 100ft cable run.','Two 20A circuits only; lighting package will need a genny.','House power adequate for small package.']),
      'Crew Fit Notes': pick(['Comfortable for 40; tight above 60.','Base camp must be off-site, 0.4 mi.','Room for 3 trucks and a genny in the lot.','Crew of 15 max — no staging area.']),
      'Risks': pick(['Spring thaw makes the approach impassable.','Owner has declined evening shoots twice before.','Active rail line within 80 ft.','Ice on the ledge Nov-Apr; fall hazard.','Cell dead zone — need radios and a runner.','None material.']),
      'Estimated Prep Days': String(int(0, 5)),
      'Overall Score': String(rec === 'Strong Fit' ? int(8, 10) : rec === 'Possible Fit' ? int(6, 8) : rec === 'Backup Option' ? int(4, 6) : int(1, 4)),
      'Reviewed By': reviewed ? pick(['Ruth Kellerman','Nate Brandt','Owen Reilly','Kim Larsen']) : '',
      'Reviewed On': reviewed ? iso(addDays(visit, int(2, 21))) : '',
      'Summary': `${rec} for ${loc['Sub Type'].toLowerCase()} work. ${loc['Setting']} coverage, ${loc['Best Light'].toLowerCase()} light preferred.`,
    });
  }
}

// ---------------------------------------------------------------- holds
// Bookable only where the owner has actually cleared us: Cleared or Restricted.
const BOOKABLE = locations.filter(l => l['Status'] === 'Cleared' || l['Status'] === 'Restricted');
const holds = [];
let hN = 0;
const HOLD_TYPES = ['Scout Visit','Tech Scout','Prep Day','Shoot Day','Strike Day'];
const EXCLUSIVE = ['Confirmed'];              // hard conflict — never overlap
const CONTENDING = ['Soft Hold','First Refusal']; // may legitimately stack
const confirmedByLoc = {};                     // loc -> [[start,end]] for the exclusivity guard
for (const loc of BOOKABLE) {
  const n = int(1, 3);
  for (let k = 0; k < n; k++) {
    const proj = pick(projects);
    const pStatus = proj['Status'];
    // Hold status must agree with the project's own lifecycle.
    let status;
    if (pStatus === 'Wrapped') status = pick(['Completed','Completed','Released']);
    else if (pStatus === 'Cancelled') status = pick(['Cancelled','Released']);
    else if (pStatus === 'Shooting' || pStatus === 'Locked') status = pick(['Confirmed','Confirmed','Soft Hold']);
    else if (pStatus === 'Development') status = 'Inquiry';
    else status = pick(['Inquiry','Soft Hold','First Refusal','Soft Hold']);

    const pStart = new Date(proj['Shoot Start'] + 'T00:00:00Z');
    let start = addDays(pStart, int(-6, 10));
    let end = addDays(start, int(0, 2));

    // Exclusivity invariant: a Confirmed hold may not overlap another Confirmed hold
    // on the same location. Walk the booking forward until it fits, else downgrade.
    if (EXCLUSIVE.includes(status)) {
      const taken = confirmedByLoc[loc['Location Code']] || [];
      let tries = 0;
      const overlaps = () => taken.some(([s, e]) => !(iso(end) < s || iso(start) > e));
      while (overlaps() && tries < 12) { start = addDays(end, int(1, 4)); end = addDays(start, int(0, 2)); tries++; }
      if (overlaps()) { status = 'Released'; }
      else { (confirmedByLoc[loc['Location Code']] ||= []).push([iso(start), iso(end)]); }
    }

    const locContacts = contacts.filter(c => c['Location Code'] === loc['Location Code']);
    holds.push({
      'Hold Code': `HD-${String(++hN).padStart(4, '0')}`,
      'Location Code': loc['Location Code'], 'Project Code': proj['Project Code'],
      'Status': status, 'Hold Type': pick(HOLD_TYPES),
      'Start Date': iso(start), 'End Date': iso(end),
      'Crew Size': String(int(1, 18) * 5),
      'Day Rate Quoted': loc['Day Rate'],
      'Contact Code': locContacts.length ? locContacts[0]['Contact Code'] : '',
      'Requested By': pick(SCOUTS),
      'Requested On': iso(addDays(start, -int(7, 60))),
      'Notes': pick(['Verbal hold pending owner signature.','Second position behind another production.','Confirmed with COI on file.','Weather cover day — may release 48h prior.','Owner requires a walk-through the morning of.']),
    });
  }
}

// ---------------------------------------------------------------- permits
const permits = [];
let pN = 0;
const PERMIT_TYPES = ['City Film Permit','County Permit','State Park Permit','DNR Permit','Road Closure','Drone / FAA','Parking Reservation','Noise Variance','Fire / Pyro','Tribal Land Permit'];
const PERMIT_STATUSES = ['Not Required','Required','Applied','In Review','Issued','Denied','Expired'];
// A permit belongs to a real booking — derive them from holds so they never dangle.
const permitSources = holds.filter(h => h['Status'] !== 'Cancelled' && h['Status'] !== 'Inquiry');
for (let i = 0; i < permitSources.length; i++) {
  if (!chance(0.72)) continue;
  const h = permitSources[i];
  const loc = byCode[h['Location Code']];
  const status = PERMIT_STATUSES[(++pN) % PERMIT_STATUSES.length];
  const type = loc['Permit Jurisdiction'] === 'MN DNR' ? pick(['DNR Permit','State Park Permit'])
    : loc['Category'] === 'Roadway' ? pick(['Road Closure','City Film Permit'])
    : pick(PERMIT_TYPES);
  const applied = ['Applied','In Review','Issued','Denied','Expired'].includes(status);
  const issued = ['Issued','Expired'].includes(status);
  // An Expired permit must have been ISSUED before it expired, and its expiry is
  // in the past. Derive backwards from the expiry rather than forwards from the
  // shoot date, or the record contradicts itself.
  let appliedOn, issuedOn, expiresOn;
  if (status === 'Expired') {
    expiresOn = addDays(TODAY, -int(5, 90));
    issuedOn = addDays(expiresOn, -int(60, 240));
    appliedOn = addDays(issuedOn, -int(5, 25));
  } else {
    appliedOn = addDays(new Date(h['Start Date'] + 'T00:00:00Z'), -int(14, 60));
    issuedOn = addDays(appliedOn, int(5, 25));
    expiresOn = addDays(issuedOn, int(60, 240));
  }
  permits.push({
    'Permit Code': `PM-${String(pN).padStart(4, '0')}`,
    'Location Code': h['Location Code'], 'Project Code': h['Project Code'],
    'Permit Type': type, 'Jurisdiction': loc['Permit Jurisdiction'], 'Status': status,
    'Applied On': applied ? iso(appliedOn) : '',
    'Issued On': issued ? iso(issuedOn) : '',
    // Expired permits are already past; issued ones are still in the future.
    'Expires On': issued ? iso(expiresOn) : '',
    'Fee': status === 'Not Required' ? '0' : String(int(1, 24) * 25),
    'Insurance Certificate': issued ? 'Yes' : pick(['Pending','Yes','No']),
    'Contact Code': h['Contact Code'],
    'Conditions': pick(['No lane closure between 7-9am.','Crew limited to 25 on park property.','No open flame; fire marshal must be present.','Drone flights below 200ft only, daylight hours.','Restore turf within 5 days of wrap.','None.']),
    'Notes': pick(['Filed through the city film office portal.','Requires council sign-off for closures over 4 hours.','Standard 10-business-day turnaround.','Expedited at additional cost.']),
  });
}

// ------------------------------------------------- deliberate soft contention
// Soft holds and first refusals legitimately stack on the same dates in this
// industry — a second production asking for days already confirmed to someone
// else. The console surfaces these as "contended" (amber), distinct from a real
// double-booking (two Confirmed holds, red). Seed a few so that amber branch is
// actually exercised instead of shipping unrendered.
// NOTE: appended AFTER permits are generated so the PRNG stream for every
// earlier entity is untouched and regeneration stays stable.
const confirmedHolds = holds.filter(h => h['Status'] === 'Confirmed').slice(0, 4);
for (let i = 0; i < confirmedHolds.length; i++) {
  const c = confirmedHolds[i];
  const other = projects.find(p => p['Project Code'] !== c['Project Code'] && ACTIVE_PROJ.includes(p['Status'])) || projects[0];
  const locContacts = contacts.filter(x => x['Location Code'] === c['Location Code']);
  holds.push({
    'Hold Code': `HD-${String(++hN).padStart(4, '0')}`,
    'Location Code': c['Location Code'], 'Project Code': other['Project Code'],
    'Status': i % 2 === 0 ? 'Soft Hold' : 'First Refusal',
    'Hold Type': 'Shoot Day',
    'Start Date': c['Start Date'], 'End Date': c['End Date'],
    'Crew Size': String(int(5, 60)),
    'Day Rate Quoted': byCode[c['Location Code']]['Day Rate'],
    'Contact Code': locContacts.length ? locContacts[0]['Contact Code'] : '',
    'Requested By': pick(SCOUTS),
    'Requested On': iso(addDays(new Date(c['Start Date'] + 'T00:00:00Z'), -int(5, 30))),
    'Notes': 'Second position — competing production wants the same dates.',
  });
}

const out = { projects, locations, contacts, 'scout-reports': reports, holds, permits };
fs.writeFileSync(path.join(__dir, 'seed-data.json'), JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) console.log(String(k).padEnd(16), v.length);
console.log('\nDistribution checks:');
const dist = (rows, f) => Object.entries(rows.reduce((a, r) => (a[r[f]] = (a[r[f]] || 0) + 1, a), {})).map(([k, v]) => `${k}:${v}`).join('  ');
console.log('  location status  ', dist(locations, 'Status'));
console.log('  report status    ', dist(reports, 'Status'));
console.log('  hold status      ', dist(holds, 'Status'));
console.log('  permit status    ', dist(permits, 'Status'));
console.log('  contact status   ', dist(contacts, 'Status'));
console.log('  project status   ', dist(projects, 'Status'));
