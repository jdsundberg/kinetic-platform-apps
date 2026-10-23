/**
 * BillysBoatWorks — demonstration network generator.
 * Builds a fully cross-referenced Midwest franchise network: destinations -> territories ->
 * franchises -> locations -> fleet -> reservations -> money/ops/safety records.
 * Deterministic. Reservations are generated conflict-free per serialized asset.
 * Usage: node gen-seed.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dir = path.dirname(fileURLToPath(import.meta.url));

let _s = 0xB111B0A7;
function rnd(){_s|=0;_s=(_s+0x6D2B79F5)|0;let t=Math.imul(_s^(_s>>>15),1|_s);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}
const pick=a=>a[Math.floor(rnd()*a.length)];
const pickW=(a,w)=>{const t=w.reduce((s,x)=>s+x,0);let r=rnd()*t;for(let i=0;i<a.length;i++){r-=w[i];if(r<=0)return a[i]}return a[a.length-1]};
const int=(lo,hi)=>lo+Math.floor(rnd()*(hi-lo+1));
const chance=p=>rnd()<p;
const pad=(n,w=4)=>String(n).padStart(w,"0");
const money=n=>String(Math.round(n*100)/100);
const d2s=d=>d.toISOString().slice(0,10);
const shuffle=a=>{const x=[...a];for(let i=x.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[x[i],x[j]]=[x[j],x[i]]}return x};

const TODAY=new Date("2026-08-14T00:00:00Z");
const day=n=>new Date(TODAY.getTime()+n*86400000);
const SEASON_OF=m=>m<=4?"Spring":m<=8?"Summer":m<=10?"Fall":"Winter";

/* ─────────────── destinations ─────────────── */
const DEST_DEFS=[
  ["Rainy Lake","MN","Northern Minnesota","Lake","International Falls",220800,9],
  ["Lake Vermilion","MN","Northern Minnesota","Lake","Tower",39271,8],
  ["Leech Lake","MN","Northern Minnesota","Lake","Walker",111527,8],
  ["Gull Lake","MN","Brainerd Lakes","Lake","Nisswa",9947,10],
  ["Lake Minnetonka","MN","Twin Cities Metro","Lake","Wayzata",14528,10],
  ["Lake Geneva","WI","Southern Wisconsin","Lake","Lake Geneva",5262,10],
  ["Wisconsin Dells","WI","Central Wisconsin","Tourism Area","Wisconsin Dells",1800,9],
  ["Door County","WI","Door Peninsula","Tourism Area","Sturgeon Bay",4200,9],
];
const destinations=DEST_DEFS.map(([name,st,region,type,city,acres,pop],i)=>({
  "Destination ID":`DST-${pad(i+1,3)}`,"Destination Name":name,"State":st,"Region":region,
  "Destination Type":type,"Nearest City":city,"Surface Acres":String(acres),
  "Season Start":"05-01","Season End":"10-15","Locations Count":"0","Popularity Score":String(pop),
  "Hero Image":`/img/${name.toLowerCase().replace(/[^a-z]+/g,"-")}.jpg`,"Status":"Active",
  "Description":`${name} — ${type==="Lake"?`${acres.toLocaleString()} acres of `:""}Midwest water recreation near ${city}, ${st}.`,
}));

/* ─────────────── territories ─────────────── */
const COUNTIES={"Rainy Lake":"Koochiching","Lake Vermilion":"St. Louis","Leech Lake":"Cass","Gull Lake":"Cass",
  "Lake Minnetonka":"Hennepin","Lake Geneva":"Walworth","Wisconsin Dells":"Columbia","Door County":"Door"};
const EXTRA_TERR=[["Mille Lacs Lake","MN","Mille Lacs"],["Lake of the Woods","MN","Lake of the Woods"],
  ["Otter Tail Lakes","MN","Otter Tail"],["Alexandria Lakes","MN","Douglas"],["Whitefish Chain","MN","Crow Wing"],
  ["Green Lake","WI","Green Lake"],["Lake Winnebago","WI","Winnebago"],["Madison Lakes","WI","Dane"],
  ["Lake Okoboji","IA","Dickinson"],["Clear Lake","IA","Cerro Gordo"],["Torch Lake","MI","Antrim"],
  ["Traverse Bay","MI","Grand Traverse"],["Devils Lake","ND","Ramsey"],["Lake Oahe","SD","Hughes"],
  ["Chain O'Lakes","IL","Lake"],["Table Rock","MO","Stone"]];
const territories=[];
destinations.forEach((d,i)=>territories.push({
  "Territory ID":`TER-${pad(i+1,3)}`,"Territory Name":`${d["Destination Name"]} Territory`,
  "Territory Type":d["Destination Type"]==="Lake"?"Lake":"Tourism Area","State":d.State,
  "County":COUNTIES[d["Destination Name"]]||"","Destination":d["Destination Name"],
  "Population":String(int(9000,340000)),"Households":String(int(4000,150000)),
  "Boat Registrations":String(int(3000,42000)),"Tourism Index":String(d["Popularity Score"]),
  "Opportunity Score":String(int(70,96)),"Franchise":"","Reserved For":"","Status":"Sold","Notes":""}));
EXTRA_TERR.forEach(([name,st,county],i)=>{
  const status=pickW(["Available","Available","Reserved","Expansion"],[5,4,2,2]);
  territories.push({"Territory ID":`TER-${pad(destinations.length+i+1,3)}`,"Territory Name":`${name} Territory`,
    "Territory Type":"Lake","State":st,"County":county,"Destination":"",
    "Population":String(int(6000,260000)),"Households":String(int(3000,110000)),
    "Boat Registrations":String(int(2000,38000)),"Tourism Index":String(int(5,10)),
    "Opportunity Score":String(int(55,94)),"Franchise":"","Reserved For":status==="Reserved"?"Application in review":"",
    "Status":status,"Notes":status==="Available"?"Open for franchise award.":""});
});

/* ─────────────── franchises ─────────────── */
const OWNERS=[["Dale Hovland","dale.hovland"],["Marcy Thorsen","marcy.thorsen"],["Ray Petit","ray.petit"],
  ["Jen Kaczmarek","jen.kaczmarek"],["Tom Bergquist","tom.bergquist"],["Angela Ruiz","angela.ruiz"],
  ["Kurt Lindahl","kurt.lindahl"],["Steph Nowak","steph.nowak"],["Bill Okafor","bill.okafor"],["Diane Vue","diane.vue"]];
const TIERS=["Founding","Premier","Standard","Standard","Premier","Standard","Founding","Standard","Premier","Standard"];
const phone=()=>`(${pick([218,320,507,612,651,763,952,715,608,920])}) ${int(200,989)}-${pad(int(0,9999))}`;
const franchises=destinations.slice(0,8).concat(destinations.slice(0,2)).map((d,i)=>{
  const [owner,slug]=OWNERS[i];
  const opened=day(-int(200,1800));
  const status=i===9?"Onboarding":i===8?"Operating":"Operating";
  return {"Franchise ID":`FR-${pad(i+1,3)}`,
    "Franchise Name":`BillysBoatWorks – ${d["Destination Name"]}${i>7?" North":""}`,
    "Owner Name":owner,"Owner Email":`${slug}@billysboatworks.com`,"Owner Phone":phone(),
    "Territory":`${d["Destination Name"]} Territory`,"State":d.State,"Region":d.Region,
    "Opened Date":status==="Onboarding"?"":d2s(opened),"Agreement Date":d2s(day(-int(220,1900))),
    "Franchise Fee":"45000","Royalty Rate":"6","Marketing Fee Rate":"2","Platform Fee":"499",
    "Locations Count":"0","Fleet Size":"0","Employees Count":"0","Tier":TIERS[i],
    "Compliance Score":String(int(72,99)),"Status":status,
    "Notes":status==="Onboarding"?"In launch phase — equipment delivery scheduled.":""};
});
franchises.forEach(fr=>{const t=territories.find(t=>t["Territory Name"]===fr.Territory);if(t&&!t.Franchise)t.Franchise=fr["Franchise Name"]});

/* ─────────────── locations ─────────────── */
const LOC_DEFS=[
  ["Thunderbird Lodge Dock","Rainy Lake","Resort"],["Rainy Lake Visitor Center","Rainy Lake","Visitor Center"],
  ["Island View Landing","Rainy Lake","Public Launch"],
  ["Vermilion Marina","Lake Vermilion","Marina"],["Fortune Bay Dock","Lake Vermilion","Resort"],
  ["Walker Bay Marina","Leech Lake","Marina"],["Federal Dam Campground","Leech Lake","Campground"],
  ["Nisswa Marina","Gull Lake","Marina"],["Gull Lake Narrows","Gull Lake","Public Launch"],
  ["Wayzata Bay Dock","Lake Minnetonka","Marina"],["Excelsior Commons","Lake Minnetonka","Public Launch"],
  ["Geneva Lakefront Marina","Lake Geneva","Marina"],["Fontana Beach House","Lake Geneva","Resort"],
  ["Dells River Landing","Wisconsin Dells","Public Launch"],
  ["Sister Bay Marina","Door County","Marina"],
];
const MGRS=["Pete Halvorsen","Karin Sundquist","Luis Moreno","Abby Fjeld","Nate Brandt","Rosa Delgado",
  "Cody Aanenson","Trina Lindstrom","Marcus Webb","Joy Iverson","Devin Cross","Hana Petrov","Owen Frisk","Lia Nakamura","Seth Barron"];
const locations=LOC_DEFS.map(([name,dest,type],i)=>{
  const fr=franchises.find(f=>f.Territory===`${dest} Territory`);
  const d=destinations.find(x=>x["Destination Name"]===dest);
  return {"Location ID":`LOC-${pad(i+1,3)}`,"Location Name":name,"Franchise":fr["Franchise Name"],
    "Destination":dest,"Location Type":type,"Address":`${int(100,9800)} ${pick(["Lakeshore Dr","Harbor Rd","Marina Way","Bay St","Shoreline Dr","Landing Rd"])}`,
    "City":d["Nearest City"],"State":d.State,"ZIP":String(int(53000,56999)),
    "Latitude":(44+rnd()*4.5).toFixed(4),"Longitude":(-(89+rnd()*5)).toFixed(4),
    "Dock Count":String(int(2,8)),"Hours Open":"07:00","Hours Close":"19:00",
    "Season Start":"05-01","Season End":"10-15","Manager":MGRS[i],"Phone":phone(),
    "Fleet Size":"0","Status":i===13?"Seasonal Closed":"Active","Notes":""};
});
franchises.forEach(fr=>{fr["Locations Count"]=String(locations.filter(l=>l.Franchise===fr["Franchise Name"]).length)});
destinations.forEach(d=>{d["Locations Count"]=String(locations.filter(l=>l.Destination===d["Destination Name"]).length)});

/* ─────────────── employees ─────────────── */
const ROLES=["Owner","General Manager","Location Manager","Dock Manager","Rental Agent","Maintenance Technician","Seasonal Employee"];
const FIRST=["Erik","Anna","Jack","Maria","Ben","Sofia","Luke","Hannah","Tomas","Greta","Sam","Nora","Dan","Ingrid","Paul","Lena","Chris","Maya","Nate","Elsa","Ryan","Clara","Jon","Britta","Cole","Iris","Wes","Freya"];
const LAST=["Anderson","Johnson","Lindgren","Halvorson","Berg","Nyberg","Sorensen","Carlson","Odegard","Thorson","Ellingson","Rasmussen","Kowalczyk","Bergstrom","Salo","Maki","Koskinen","Hartman","Dahl","Fjeld","Novak","Vue","Xiong","Ruiz"];
const person=()=>`${pick(FIRST)} ${pick(LAST)}`;
const emailOf=(n,dom)=>`${n.toLowerCase().replace(/[^a-z]+/g,".")}@${dom}`;
const employees=[];
franchises.forEach(fr=>{
  employees.push({"Employee ID":`EMP-${pad(employees.length+1)}`,"Employee Name":fr["Owner Name"],
    "Email":fr["Owner Email"],"Phone":fr["Owner Phone"],"Franchise":fr["Franchise Name"],"Location":"",
    "Role":"Owner","Hire Date":fr["Agreement Date"],"Certifications":"Franchise Orientation; Water Safety",
    "Training Complete":"Yes","Status":"Active","Notes":""});
});
locations.forEach(loc=>{
  const mk=(name,role,status)=>({"Employee ID":`EMP-${pad(employees.length+1)}`,"Employee Name":name,
    "Email":emailOf(name,"billysboatworks.com"),"Phone":phone(),"Franchise":loc.Franchise,"Location":loc["Location Name"],
    "Role":role,"Hire Date":d2s(day(-int(30,900))),
    "Certifications":role==="Maintenance Technician"?"Marine Systems; Water Safety":"Water Safety; Check-In",
    "Training Complete":chance(0.82)?"Yes":"No","Status":status,"Notes":""});
  employees.push(mk(loc.Manager,"Location Manager","Active"));
  employees.push(mk(person(),"Dock Manager","Active"));
  const agents=int(1,3);
  for(let i=0;i<agents;i++)employees.push(mk(person(),"Rental Agent",chance(0.75)?"Active":"Seasonal"));
  if(chance(0.7))employees.push(mk(person(),"Maintenance Technician","Active"));
  if(chance(0.6))employees.push(mk(person(),"Seasonal Employee","Seasonal"));
});
franchises.forEach(fr=>{fr["Employees Count"]=String(employees.filter(e=>e.Franchise===fr["Franchise Name"]).length)});

/* ─────────────── equipment categories ─────────────── */
const CAT_DEFS=[
  ["22' Pontoon","Watercraft","Serialized",12,"Yes","Yes",21,95,225,350,525,2400,500,45,"Summer"],
  ["24' Luxury Pontoon","Watercraft","Serialized",14,"Yes","Yes",21,125,295,450,695,3100,750,45,"Summer"],
  ["18' Fishing Boat","Watercraft","Serialized",5,"Yes","Yes",18,65,150,225,340,1500,300,30,"Summer"],
  ["16' Deck Boat","Watercraft","Serialized",6,"Yes","Yes",18,70,165,245,365,1650,300,30,"Summer"],
  ["Ski / Wake Boat","Watercraft","Serialized",8,"Yes","Yes",21,145,340,520,780,3600,1000,45,"Summer"],
  ["Jet Ski / PWC","Powersport","Serialized",3,"Yes","Yes",18,85,190,290,430,1900,500,20,"Summer"],
  ["Kayak — Single","Paddle","Serialized",1,"No","No",12,20,35,50,65,260,50,10,"Summer"],
  ["Kayak — Tandem","Paddle","Serialized",2,"No","No",12,28,48,68,88,340,50,10,"Summer"],
  ["Canoe","Paddle","Serialized",3,"No","No",12,25,45,62,80,320,50,10,"Summer"],
  ["Paddleboard","Paddle","Serialized",1,"No","No",12,22,38,55,70,280,50,10,"Summer"],
  ["Paddle Boat","Paddle","Serialized",4,"No","No",12,18,32,45,60,240,40,10,"Summer"],
  ["Water Bike","Paddle","Serialized",2,"No","No",14,24,42,58,75,300,50,10,"Summer"],
  ["E-Bike","Land","Serialized",1,"No","No",16,30,55,75,95,380,75,10,"Any"],
  ["Bicycle","Land","Serialized",1,"No","No",10,15,28,40,52,200,40,10,"Any"],
  ["Floating Dock","Watercraft","Serialized",8,"No","No",0,0,120,180,240,900,200,30,"Summer"],
  ["Lily Pad / Floating Mat","Towable","Quantity",6,"No","No",0,15,25,35,45,180,25,10,"Summer"],
  ["Tube","Towable","Quantity",3,"No","No",0,12,22,32,42,160,25,5,"Summer"],
  ["Water Skis","Towable","Quantity",1,"No","No",0,12,20,28,38,150,25,5,"Summer"],
  ["Wakeboard","Towable","Quantity",1,"No","No",0,14,24,34,44,170,25,5,"Summer"],
  ["Kneeboard","Towable","Quantity",1,"No","No",0,12,20,28,38,150,25,5,"Summer"],
  ["Life Jacket","Safety","Quantity",1,"No","No",0,0,0,0,0,0,0,0,"Any"],
  ["Cooler","Accessory","Quantity",1,"No","No",0,8,12,18,25,90,0,5,"Any"],
  ["Fishing Package","Accessory","Quantity",1,"No","No",0,18,30,45,60,240,25,5,"Summer"],
  ["Tow Rope","Accessory","Quantity",1,"No","No",0,5,8,12,15,60,0,5,"Summer"],
];
const categories=CAT_DEFS.map(([name,cls,track,cap,lic,brief,age,hr,half,full,daily,weekly,dep,buffer,season],i)=>({
  "Category ID":`CAT-${pad(i+1,3)}`,"Category Name":name,"Equipment Class":cls,"Tracking Mode":track,
  "Capacity":String(cap),"Requires License":lic,"Requires Briefing":brief,"Minimum Age":String(age),
  "Hourly Rate":String(hr),"Half Day Rate":String(half),"Full Day Rate":String(full),"Daily Rate":String(daily),
  "Weekly Rate":String(weekly),"Security Deposit":String(dep),"Cleaning Buffer Minutes":String(buffer),
  "Season":season,"Image":`/img/cat/${name.toLowerCase().replace(/[^a-z0-9]+/g,"-")}.jpg`,"Status":"Active",
  "Description":`${name} — ${cls.toLowerCase()} rental${brief==="Yes"?", safety briefing required":""}.`}));
const serialCats=categories.filter(c=>c["Tracking Mode"]==="Serialized");
const qtyCats=categories.filter(c=>c["Tracking Mode"]==="Quantity");
const RENTABLE=serialCats.filter(c=>c["Category Name"]!=="Floating Dock");

/* ─────────────── assets ─────────────── */
const MAKES={"22' Pontoon":[["Bennington","22 SSRX"],["Premier","Sunsation 220"],["Manitou","Aurora 22"]],
  "24' Luxury Pontoon":[["Bennington","24 QSR"],["Harris","Crowne 240"],["Manitou","Explore 24"]],
  "18' Fishing Boat":[["Lund","Pro-V 1875"],["Alumacraft","Competitor 185"],["Crestliner","1850 Fish Hawk"]],
  "16' Deck Boat":[["Bayliner","Element E16"],["Hurricane","SunDeck 165"]],
  "Ski / Wake Boat":[["MasterCraft","NXT22"],["Malibu","Wakesetter 21"],["Nautique","Ski Nautique 200"]],
  "Jet Ski / PWC":[["Sea-Doo","GTI SE 130"],["Yamaha","VX Cruiser"],["Kawasaki","STX 160"]],
  "Kayak — Single":[["Old Town","Loon 106"],["Wilderness","Pungo 105"]],"Kayak — Tandem":[["Old Town","Twin Heron"],["Perception","Tribe 13.5"]],
  "Canoe":[["Old Town","Discovery 158"],["Wenonah","Spirit II"]],"Paddleboard":[["BOTE","Breeze Aero"],["Isle","Pioneer 10.6"]],
  "Paddle Boat":[["Sun Dolphin","Sunslider 5"],["Pelican","Monaco 4"]],"Water Bike":[["Schiller","S1-C"],["Hydrobike","Explorer"]],
  "E-Bike":[["Rad Power","RadCity 5"],["Aventon","Pace 500"]],"Bicycle":[["Trek","Verve 2"],["Specialized","Roll 3.0"]],
  "Floating Dock":[["ShoreMaster","Infinity RS4"],["PlayStar","Pro Dock"]]};
const NAMEWORD=["Loon","Birch","Timber","Granite","Aurora","Boreal","Tamarack","Otter","Walleye","Balsam","Cedar","Moose","Pine","Beaver","Heron","Voyageur","Nokomis","Kettle","Sawtooth","Whitecap"];
const assets=[];
const activeLocs=locations.filter(l=>l.Status!=="Seasonal Closed");
// weight the fleet toward the money-makers
const FLEET_MIX=[["22' Pontoon",4],["24' Luxury Pontoon",2],["18' Fishing Boat",3],["Jet Ski / PWC",3],
  ["Kayak — Single",3],["Paddleboard",2],["Ski / Wake Boat",1],["Kayak — Tandem",1],["Canoe",1],
  ["Paddle Boat",1],["16' Deck Boat",1],["E-Bike",1],["Water Bike",1],["Bicycle",1],["Floating Dock",1]];
let assetN=0;
// Give every location its share of the 150-unit fleet. A flat cap here would let the
// first few locations consume the whole fleet and leave later destinations empty.
const TARGET=150;
const mixTotal=FLEET_MIX.reduce((s2,[,n])=>s2+n,0);
for(let li=0;li<activeLocs.length;li++){
  const loc=activeLocs[li];
  // running target keeps the split even AND makes the fleet total exactly 150
  const quota=Math.round(TARGET*(li+1)/activeLocs.length)-assetN;
  let placed=0;
  for(const [catName,base] of FLEET_MIX){
    const cat=categories.find(c=>c["Category Name"]===catName);
    const share=Math.round(quota*base/mixTotal);
    const n=Math.min(Math.max(catName==="22' Pontoon"||catName==="18' Fishing Boat"?1:0,share),quota-placed);
    for(let i=0;i<n;i++){
      if(placed>=quota||assetN>=TARGET)break;
      assetN++;placed++;
      const [make,model]=pick(MAKES[catName]||[["Generic","Standard"]]);
      const year=int(2019,2026);
      const price=({"22' Pontoon":52000,"24' Luxury Pontoon":78000,"18' Fishing Boat":34000,"16' Deck Boat":29000,
        "Ski / Wake Boat":115000,"Jet Ski / PWC":14500,"Kayak — Single":1100,"Kayak — Tandem":1600,"Canoe":1500,
        "Paddleboard":1200,"Paddle Boat":1400,"Water Bike":3800,"E-Bike":2100,"Bicycle":700,"Floating Dock":9500})[catName]||2000;
      const age=2026-year;
      const hours=cat["Equipment Class"]==="Watercraft"||cat["Equipment Class"]==="Powersport"?int(30,220)*Math.max(1,age):0;
      const status=pickW(["Available","Available","Available","Available","Maintenance","Cleaning","Out of Service"],[60,15,10,8,4,2,1]);
      assets.push({"Asset ID":`AST-${pad(assetN)}`,"Asset Name":`${pick(NAMEWORD)} ${catName.replace(/[^A-Za-z ]/g,"").trim().split(" ").slice(-1)[0]} ${assetN}`,
        "Asset Tag":`BBW-${pad(assetN)}`,"Category":catName,"Equipment Class":cat["Equipment Class"],
        "Franchise":loc.Franchise,"Location":loc["Location Name"],"Manufacturer":make,"Model":model,
        "Model Year":String(year),"Serial Number":`${make.slice(0,3).toUpperCase()}${int(10000,99999)}${year}`,
        "Registration Number":cat["Requires License"]==="Yes"?`${loc.State}-${int(1000,9999)}-${pick("ABCDEFGH")}${pick("JKLMNP")}`:"",
        "HIN":cat["Equipment Class"]==="Watercraft"?`BBW${int(10000,99999)}${String(year).slice(2)}`:"",
        "Purchase Date":d2s(day(-(age*365+int(10,320)))),"Purchase Price":String(price),
        "Current Value":String(Math.round(price*Math.max(0.35,1-age*0.11))),
        "Engine Hours":String(hours),"Next Service Hours":hours?String(Math.ceil((hours+1)/100)*100):"",
        "Condition":pickW(["Excellent","Good","Fair","Poor"],[35,45,17,3]),
        "Fuel Level":cat["Equipment Class"]==="Watercraft"||cat["Equipment Class"]==="Powersport"?pick(["Full","3/4","1/2","1/4"]):"",
        "Last Inspection":d2s(day(-int(1,60))),"Lifetime Revenue":"0","Maintenance Cost":String(int(0,9)*Math.max(1,age)*180),
        "Days Rented":"0","Days Available":String(int(120,165)),
        "Photo":`/img/asset/${catName.toLowerCase().replace(/[^a-z0-9]+/g,"-")}.jpg`,
        "QR Code":`https://billysboatworks.com/a/BBW-${pad(assetN)}`,"Status":status,"Notes":""});
    }
  }
}
locations.forEach(l=>{l["Fleet Size"]=String(assets.filter(a=>a.Location===l["Location Name"]).length)});
franchises.forEach(f=>{f["Fleet Size"]=String(assets.filter(a=>a.Franchise===f["Franchise Name"]).length)});

/* ─────────────── quantity inventory ─────────────── */
const inventory=[];
for(const loc of activeLocs){
  for(const cat of qtyCats){
    const total=cat["Category Name"]==="Life Jacket"?int(30,60):int(4,14);
    const out=int(0,Math.floor(total*0.4)),dmg=chance(0.25)?int(1,2):0;
    inventory.push({"Inventory ID":`INV-${pad(inventory.length+1)}`,"Item Name":cat["Category Name"],
      "Category":cat["Category Name"],"Franchise":loc.Franchise,"Location":loc["Location Name"],
      "Quantity Total":String(total),"Quantity Available":String(total-out-dmg),"Quantity Out":String(out),
      "Quantity Damaged":String(dmg),"Unit Rate":cat["Half Day Rate"],"Security Deposit":cat["Security Deposit"],
      "Status":"Active","Notes":""});
  }
}

/* ─────────────── protection plans ─────────────── */
const protectionPlans=[
  {"Plan ID":"PP-001","Plan Name":"No Protection","Tier":"None","Provider":"","Coverage Limit":"0","Deductible":"0",
   "Daily Premium":"0","Percent Premium":"0","Applies To":"All","Status":"Active",
   "Description":"Customer declines optional protection and remains responsible for damage up to the full repair cost."},
  {"Plan ID":"PP-002","Plan Name":"Basic Protection","Tier":"Basic","Provider":"Northern Shield Underwriters","Coverage Limit":"5000",
   "Deductible":"500","Daily Premium":"29","Percent Premium":"8","Applies To":"Watercraft; Powersport","Status":"Active",
   "Description":"Covers accidental damage to the rented equipment up to $5,000 after a $500 deductible. Underwritten by a licensed third-party carrier."},
  {"Plan ID":"PP-003","Plan Name":"Enhanced Protection","Tier":"Enhanced","Provider":"Northern Shield Underwriters","Coverage Limit":"25000",
   "Deductible":"100","Daily Premium":"59","Percent Premium":"14","Applies To":"All","Status":"Active",
   "Description":"Covers accidental damage up to $25,000 after a $100 deductible, plus towing and on-water assistance. Underwritten by a licensed third-party carrier."},
];

/* ─────────────── pricing rules ─────────────── */
const pricingRules=[];
let ruleN=0;
for(const cat of RENTABLE.slice(0,10)){
  for(const dur of ["Hourly","Half Day","Full Day"]){
    ruleN++;
    pricingRules.push({"Rule ID":`PR-${pad(ruleN,3)}`,"Rule Name":`${cat["Category Name"]} — ${dur} base`,
      "Scope":"Corporate","Franchise":"","Location":"","Category":cat["Category Name"],"Duration Type":dur,
      "Day Type":"Any","Season":"Any",
      "Base Price":dur==="Hourly"?cat["Hourly Rate"]:dur==="Half Day"?cat["Half Day Rate"]:cat["Full Day Rate"],
      "Adjustment Type":"Fixed","Adjustment Value":"0","Minimum Hours":dur==="Hourly"?"2":"","Advance Days":"",
      "Priority":"100","Effective Start":"2026-05-01","Effective End":"2026-10-15","Status":"Active",
      "Explanation":`Corporate recommended ${dur.toLowerCase()} rate for ${cat["Category Name"]}.`});
  }
}
[["Weekend premium","Weekend","Any","Percent",15,"Saturday and Sunday demand premium applied on top of the base rate."],
 ["Holiday premium","Holiday","Any","Percent",25,"Memorial Day, July 4th and Labor Day weekends."],
 ["Peak summer premium","Any","Summer","Percent",10,"Applied July 1 – August 20 during peak season."],
 ["Shoulder season discount","Any","Fall","Percent",-15,"Encourages September and October bookings."],
 ["Spring launch discount","Any","Spring","Percent",-10,"Drives early-season volume in May."],
 ["Last-minute fill","Any","Any","Percent",-12,"Applied inside 24 hours when the asset is still open."],
 ["Advance booking discount","Any","Any","Percent",-8,"Booked 21+ days ahead."],
 ["Multi-day discount","Any","Any","Percent",-10,"Applied to rentals of 3+ days."],
].forEach(([name,dayType,season,adjType,adj,why])=>{
  ruleN++;
  pricingRules.push({"Rule ID":`PR-${pad(ruleN,3)}`,"Rule Name":name,"Scope":"Corporate","Franchise":"","Location":"",
    "Category":"","Duration Type":"Any","Day Type":dayType,"Season":season,"Base Price":"","Adjustment Type":adjType,
    "Adjustment Value":String(adj),"Minimum Hours":"","Advance Days":name.includes("Advance")?"21":name.includes("Last-minute")?"1":"",
    "Priority":"50","Effective Start":"2026-05-01","Effective End":"2026-10-15","Status":"Active","Explanation":why});
});
for(const fr of franchises.slice(0,4)){
  ruleN++;
  pricingRules.push({"Rule ID":`PR-${pad(ruleN,3)}`,"Rule Name":`${fr["Franchise Name"]} pontoon override`,
    "Scope":"Franchise","Franchise":fr["Franchise Name"],"Location":"","Category":"22' Pontoon","Duration Type":"Full Day",
    "Day Type":"Any","Season":"Summer","Base Price":String(int(495,595)),"Adjustment Type":"Fixed","Adjustment Value":"0",
    "Minimum Hours":"","Advance Days":"","Priority":"10","Effective Start":"2026-05-01","Effective End":"2026-10-15",
    "Status":"Active","Explanation":"Local market rate set by the franchisee, overrides the corporate recommendation."});
}

/* ─────────────── customers ─────────────── */
const CUST_CITIES=[["Minneapolis","MN"],["St. Paul","MN"],["Duluth","MN"],["Rochester","MN"],["Brainerd","MN"],
  ["Bemidji","MN"],["Fargo","ND"],["Sioux Falls","SD"],["Des Moines","IA"],["Madison","WI"],["Milwaukee","WI"],
  ["Chicago","IL"],["Eau Claire","WI"],["Green Bay","WI"],["Grand Rapids","MI"],["Omaha","NE"]];
const customers=[];
const seenEmail=new Set();
while(customers.length<500){
  const first=pick(FIRST),last=pick(LAST);
  const email=`${first}.${last}${chance(0.5)?int(1,99):""}`.toLowerCase()+`@${pick(["gmail.com","yahoo.com","outlook.com","comcast.net","icloud.com"])}`;
  if(seenEmail.has(email))continue;
  seenEmail.add(email);
  const [city,st]=pick(CUST_CITIES);
  customers.push({"Customer ID":`CUS-${pad(customers.length+1)}`,"First Name":first,"Last Name":last,
    "Email":email,"Phone":phone(),"City":city,"State":st,"ZIP":String(int(50000,56999)),
    "Emergency Contact":person(),"Emergency Phone":phone(),
    "ID Verified":pickW(["Yes","No"],[82,18]),"License Last4":String(int(1000,9999)),
    "Boater Certification":chance(0.35)?`${st}-${int(100000,999999)}`:"",
    "Loyalty Tier":"Standard","Rentals Count":"0","Lifetime Spend":"0","First Rental":"","Last Rental":"",
    "Marketing Opt In":pickW(["Yes","No"],[72,28]),"Status":"Active","Notes":""});
}

/* ─────────────── reservations (conflict-free per asset) ─────────────── */
const LIFECYCLE_FUTURE=["Draft","Pending Payment","Confirmed","Waiver Required","Ready for Pickup"];
const DURATIONS=[["Hourly",2],["Half Day",4],["Full Day",8],["Multi-Day",24],["Weekly",168]];
const SOURCES=["Web","Marketplace","Phone","Walk-in"];
const booked={}; // asset -> date -> [[startHr,endHr]]
function slotFree(asset,date,s,e){
  const d=(booked[asset]=booked[asset]||{});
  const spans=(d[date]=d[date]||[]);
  return !spans.some(([a,b])=>s<b&&e>a);
}
function hold(asset,date,s,e){booked[asset][date].push([s,e])}

const reservations=[],reservationItems=[],payments=[],waivers=[],reviews=[],notifications=[];
let resN=0,itemN=0,payN=0,waivN=0,revN=0,notifN=0;
const rentableAssets=assets.filter(a=>a.Status!=="Out of Service"&&a.Category!=="Floating Dock");
const custStats={};

let attempts=0;
while(reservations.length<1000&&attempts<40000){
  attempts++;
  const asset=pick(rentableAssets);
  const cat=categories.find(c=>c["Category Name"]===asset.Category);
  const loc=locations.find(l=>l["Location Name"]===asset.Location);
  const offset=int(-105,45);
  const date=day(offset);
  const m=date.getUTCMonth()+1;
  if(m<5||m>10)continue;
  const [durType,durHours]=pickW(DURATIONS,[18,30,38,10,4]);
  const startHr=durType==="Full Day"?8:durType==="Half Day"?pick([8,13]):durType==="Hourly"?pick([8,10,12,14,16]):8;
  const endHr=Math.min(19,startHr+(durHours>12?11:durHours));
  const dateStr=d2s(date);
  if(!slotFree(asset["Asset Name"],dateStr,startHr,endHr))continue;
  hold(asset["Asset Name"],dateStr,startHr,endHr);

  const cust=pick(customers);
  const past=offset<0,today=offset===0;
  let status,exception="";
  if(past){
    status=pickW(["Completed","Completed","Completed","Completed","Customer Cancelled","No Show","Weather Cancelled","Damage Hold"],[70,10,8,5,4,1.5,1.5,1]);
    if(["Customer Cancelled","No Show","Weather Cancelled","Damage Hold"].includes(status)){exception=status;status="Completed"===status?status:status}
  } else if(today){
    status=pickW(["Ready for Pickup","Checked In","Equipment Released","Active Rental","Returning","Returned","Inspection","Completed"],[20,10,10,25,8,10,7,10]);
  } else {
    status=pickW(LIFECYCLE_FUTURE,[4,12,55,15,14]);
  }
  const isCancelled=["Customer Cancelled","Operator Cancelled","Weather Cancelled","No Show"].includes(status);
  const days=durType==="Weekly"?7:durType==="Multi-Day"?int(2,4):1;
  const endDate=d2s(day(offset+(days-1)));

  // price: category rate x duration, then weekend/season adjustments — mirrors the pricing rules
  const dow=date.getUTCDay();
  const base=durType==="Hourly"?+cat["Hourly Rate"]*Math.max(2,durHours)
    :durType==="Half Day"?+cat["Half Day Rate"]
    :durType==="Full Day"?+cat["Full Day Rate"]
    :durType==="Weekly"?+cat["Weekly Rate"]:+cat["Daily Rate"]*days;
  let price=base;
  if(dow===0||dow===6)price*=1.15;
  if(m===7||(m===8&&date.getUTCDate()<=20))price*=1.10;
  if(m===9||m===10)price*=0.85;
  if(m===5)price*=0.90;
  price=Math.round(price);

  // accessories
  const accCount=cat["Equipment Class"]==="Watercraft"?int(0,3):int(0,1);
  const accs=shuffle(qtyCats.filter(c=>c["Category Name"]!=="Life Jacket")).slice(0,accCount);
  const accTotal=accs.reduce((s,a)=>s+ +a["Half Day Rate"],0);

  // protection
  const plan=cat["Equipment Class"]==="Watercraft"||cat["Equipment Class"]==="Powersport"
    ? pickW(protectionPlans,[25,40,35]) : pickW(protectionPlans,[70,20,10]);
  const protFee=plan.Tier==="None"?0:Math.round(price*(+plan["Percent Premium"]/100));

  const sub=price+accTotal+protFee;
  const fees=Math.round(sub*0.06);                 // service + cleaning
  const tax=Math.round((sub+fees)*0.0775);
  const total=sub+fees+tax;
  const conf=`BB${10000+reservations.length}`;
  resN++;

  const startTime=`${String(startHr).padStart(2,"0")}:00`;
  const endTime=`${String(endHr).padStart(2,"0")}:00`;
  const released=["Equipment Released","Active Rental","Returning","Returned","Inspection","Completed"].includes(status);
  const returned=["Returned","Inspection","Completed"].includes(status);
  const late=returned&&chance(0.09)?int(10,95):0;
  const agent=pick(employees.filter(e=>e.Location===loc["Location Name"]&&["Rental Agent","Dock Manager","Location Manager"].includes(e.Role)))||{"Employee Name":loc.Manager};

  const r={"Reservation ID":`RES-${pad(resN)}`,"Confirmation Code":conf,"Customer":cust["Customer ID"],
    "Customer Name":`${cust["First Name"]} ${cust["Last Name"]}`,"Customer Email":cust.Email,"Customer Phone":cust.Phone,
    "Franchise":loc.Franchise,"Location":loc["Location Name"],"Destination":loc.Destination,
    "Category":asset.Category,"Asset":asset["Asset Name"],
    "Asset Assignment":chance(0.75)?"Specific Asset":"Category — auto-assigned",
    "Start Date":dateStr,"Start Time":startTime,"End Date":endDate,"End Time":endTime,
    "Duration Type":durType,"Duration Hours":String(durHours),"Party Size":String(int(1,+cat.Capacity||4)),
    "Base Price":String(price),"Accessories Total":String(accTotal),"Protection Plan":plan["Plan Name"],
    "Protection Fee":String(protFee),"Fees":String(fees),"Tax":String(tax),"Total":String(total),
    "Security Deposit":cat["Security Deposit"],"Balance Due":isCancelled?"0":(status==="Pending Payment"?String(total):"0"),
    "Source":pickW(SOURCES,[45,25,18,12]),
    "Waiver Signed":["Draft","Pending Payment","Waiver Required"].includes(status)?"No":"Yes",
    "Checked In At":released||status==="Checked In"?`${dateStr} ${startTime}`:"",
    "Released At":released?`${dateStr} ${startTime}`:"","Released By":released?agent["Employee Name"]:"",
    "Returned At":returned?`${endDate} ${endTime}`:"","Return Fuel":returned?pick(["Full","3/4","1/2","1/4"]):"",
    "Late Minutes":String(late),"Exception":exception,"Status":status,"Notes":""};
  reservations.push(r);

  // ── line items make the total traceable ──
  const addItem=(type,desc,qty,unit,catName,assetName)=>{
    itemN++;
    reservationItems.push({"Item ID":`RI-${pad(itemN,5)}`,"Reservation":r["Reservation ID"],"Confirmation Code":conf,
      "Item Type":type,"Category":catName||"","Asset":assetName||"","Description":desc,"Quantity":String(qty),
      "Unit Price":String(unit),"Line Total":String(Math.round(unit*qty)),"Franchise":loc.Franchise});
  };
  addItem("Equipment",`${asset.Category} — ${durType} (${asset["Asset Name"]})`,1,price,asset.Category,asset["Asset Name"]);
  accs.forEach(a=>addItem("Accessory",a["Category Name"],1,+a["Half Day Rate"],a["Category Name"]));
  if(protFee)addItem("Protection",plan["Plan Name"],1,protFee);
  addItem("Fee",`Service & cleaning fee + tax`,1,fees+tax);

  // ── payments ──
  const fr=franchises.find(f=>f["Franchise Name"]===loc.Franchise);
  const period=`${dateStr.slice(0,7)}`;
  const mkPay=(type,amount,st)=>{
    payN++;
    const royalty=type==="Capture"?Math.round(amount*(+fr["Royalty Rate"]/100)):0;
    const mkt=type==="Capture"?Math.round(amount*(+fr["Marketing Fee Rate"]/100)):0;
    const procFee=type==="Capture"?Math.round(amount*0.029+0.3):0;
    payments.push({"Payment ID":`PAY-${pad(payN,5)}`,"Reservation":r["Reservation ID"],"Confirmation Code":conf,
      "Customer":cust["Customer ID"],"Franchise":loc.Franchise,"Payment Type":type,"Method":pickW(["Card","Card","Cash","ACH"],[70,15,10,5]),
      "Provider":"PaymentsAbstraction","Provider Reference":`pi_${Math.floor(rnd()*1e12).toString(36)}`,
      "Amount":String(amount),"Royalty Amount":String(royalty),"Marketing Amount":String(mkt),
      "Processing Fee":String(procFee),"Franchise Net":String(amount-royalty-mkt-procFee),
      "Processed At":`${dateStr} ${startTime}`,"Period":period,"Status":st,"Notes":""});
  };
  if(!["Draft","Pending Payment"].includes(status)){
    mkPay("Authorization",total,"Succeeded");
    if(!isCancelled)mkPay("Capture",total,"Succeeded");
    if(+cat["Security Deposit"]>0&&released)mkPay("Deposit",+cat["Security Deposit"],"Succeeded");
    if(isCancelled&&chance(0.7))mkPay("Refund",Math.round(total*(status==="Weather Cancelled"?1:0.8)),"Succeeded");
    if(late>30)mkPay("Additional Charge",Math.round(late/30)*45,"Succeeded");
  }

  // ── waivers (versioned) ──
  if(r["Waiver Signed"]==="Yes"){
    for(const doc of ["Rental Agreement","Liability Waiver",
        ...(plan.Tier!=="None"?["Insurance Acknowledgement"]:[]),
        ...(cat["Requires Briefing"]==="Yes"?["Equipment Rules"]:[])]){
      waivN++;
      waivers.push({"Waiver ID":`WVR-${pad(waivN,5)}`,"Reservation":r["Reservation ID"],"Confirmation Code":conf,
        "Customer":cust["Customer ID"],"Customer Name":r["Customer Name"],"Franchise":loc.Franchise,
        "Location":loc["Location Name"],"Asset":asset["Asset Name"],"Document Type":doc,
        "Document Version":doc==="Rental Agreement"?"2026.2":"2026.1","Signature Name":r["Customer Name"],
        "Signed At":`${dateStr} ${startTime}`,"IP Address":`${int(24,99)}.${int(0,255)}.${int(0,255)}.${int(1,254)}`,
        "Status":"Signed"});
    }
  }

  // ── reviews ──
  if(status==="Completed"&&chance(0.36)){
    revN++;
    const eq=pickW([5,4,3,2],[52,30,13,5]),staff=pickW([5,4,3],[62,30,8]),val=pickW([5,4,3,2],[45,35,15,5]);
    const rating=Math.max(1,Math.min(5,Math.round((eq*2+staff+val)/4)));
    reviews.push({"Review ID":`REV-${pad(revN,4)}`,"Reservation":r["Reservation ID"],"Customer":cust["Customer ID"],
      "Customer Name":r["Customer Name"],"Franchise":loc.Franchise,"Location":loc["Location Name"],
      "Destination":loc.Destination,"Asset":asset["Asset Name"],"Category":asset.Category,
      "Rating":String(rating),"Equipment Rating":String(eq),"Staff Rating":String(staff),"Value Rating":String(val),
      "Would Recommend":rating>=4?"Yes":chance(0.3)?"Yes":"No","NPS Score":String(rating>=5?10:rating===4?8:rating===3?6:int(0,5)),
      "Submitted At":d2s(day(offset+1)),"Status":pickW(["New","Responded","Escalated"],[45,50,5]),
      "Comment":rating>=4?pick(["Boat was spotless and the dock crew had us on the water in ten minutes.",
        "Easiest rental we have ever done. Booked on my phone in about a minute.",
        "Great equipment and the safety briefing was quick but thorough.",
        "Kids loved the tube. Staff even helped us load the cooler.",
        "Second year renting from Billys. Same great experience."])
        :rating===3?pick(["Good boat, but pickup ran about 20 minutes behind.",
        "Fine rental. Fuel was lower than expected at pickup.","Solid trip, dock was crowded midday."])
        :pick(["Motor was hard to start and we lost an hour of our afternoon.",
        "Equipment was not clean when we arrived.","Waited well past our pickup time."]),
      "Response":""});
  }

  // ── notifications ──
  if(!isCancelled&&notifN<250&&chance(0.25)){
    const tmpl=past?pick(["Post-Rental Thanks","Receipt","Review Request"]):
      offset<=1?pick(["Pickup Reminder","Day-Of Instructions","Return Reminder"]):pick(["Booking Confirmation","Waiver Request"]);
    notifN++;
    notifications.push({"Notification ID":`NTF-${pad(notifN,4)}`,"Channel":pickW(["Email","SMS","Push","In-App"],[55,30,10,5]),
      "Template":tmpl,"Recipient Type":"Customer","Recipient":r["Customer Name"],"Recipient Address":cust.Email,
      "Reservation":r["Reservation ID"],"Confirmation Code":conf,"Franchise":loc.Franchise,
      "Subject":({"Booking Confirmation":`Your ${asset.Category} is booked — ${conf}`,
        "Pickup Reminder":`Your ${asset.Category} is ready tomorrow at ${startTime}`,
        "Day-Of Instructions":`Head to ${loc["Location Name"]} — have your license ready`,
        "Return Reminder":`Your ${asset.Category} is due back at ${endTime}`,
        "Post-Rental Thanks":"Thanks for boating with BillysBoatWorks","Receipt":`Receipt for ${conf}`,
        "Review Request":"How did we do?","Waiver Request":"One quick signature before your trip"})[tmpl],
      "Scheduled At":dateStr,"Sent At":past||offset<=1?dateStr:"","Status":past||offset<=1?"Sent":"Queued",
      "Body":""});
  }

  // roll up customer + asset economics from real reservations
  if(!isCancelled){
    const cs=(custStats[cust["Customer ID"]]=custStats[cust["Customer ID"]]||{n:0,spend:0,first:dateStr,last:dateStr});
    cs.n++;cs.spend+=total;
    if(dateStr<cs.first)cs.first=dateStr;
    if(dateStr>cs.last)cs.last=dateStr;
    if(status==="Completed"){
      asset["Lifetime Revenue"]=String(+asset["Lifetime Revenue"]+price);
      asset["Days Rented"]=String(+asset["Days Rented"]+days);
    }
  }
}
customers.forEach(c=>{
  const s=custStats[c["Customer ID"]];
  if(!s)return;
  c["Rentals Count"]=String(s.n);c["Lifetime Spend"]=String(s.spend);
  c["First Rental"]=s.first;c["Last Rental"]=s.last;
  c["Loyalty Tier"]=s.n>=5?"Captain":s.n>=3?"First Mate":s.n>=2?"Crew":"Standard";
});

/* ─────────────── maintenance, inspections, damage ─────────────── */
const maintenance=[],inspections=[],damageReports=[],claims=[],incidents=[];
let woN=0,inspN=0,dmgN=0,clmN=0,incN=0;
const MAINT_TYPES=["Preventive","Scheduled","Repair","Inspection","Cleaning","Winterization","Spring Commissioning","Damage Repair","Recall","Safety Inspection"];
for(let i=0;i<120;i++){
  const a=pick(assets);
  const loc=locations.find(l=>l["Location Name"]===a.Location);
  const type=pickW(MAINT_TYPES,[22,18,20,10,8,4,6,8,1,3]);
  const opened=day(-int(0,150));
  const st=a.Status==="Maintenance"&&i<12?"In Progress":pickW(["Complete","Complete","Open","Scheduled","In Progress","Waiting Parts"],[45,15,12,12,10,6]);
  const parts=type==="Cleaning"?0:int(0,900),labor=int(60,1400);
  woN++;
  maintenance.push({"Work Order ID":`WO-${pad(woN,4)}`,"Asset":a["Asset Name"],"Asset Tag":a["Asset Tag"],
    "Franchise":a.Franchise,"Location":a.Location,"Maintenance Type":type,
    "Priority":pickW(["Low","Normal","High","Urgent"],[20,50,22,8]),
    "Reported By":pick(employees.filter(e=>e.Franchise===a.Franchise))?.["Employee Name"]||loc?.Manager||"",
    "Assigned To":pick(employees.filter(e=>e.Franchise===a.Franchise&&e.Role==="Maintenance Technician"))?.["Employee Name"]||"Contract Service",
    "Opened Date":d2s(opened),"Scheduled Date":d2s(day(-int(-20,140))),
    "Completed Date":st==="Complete"?d2s(day(-int(0,140))):"",
    "Engine Hours At Service":a["Engine Hours"]||"","Parts Cost":String(parts),"Labor Cost":String(labor),
    "Total Cost":String(parts+labor),"Downtime Days":String(st==="Complete"?int(0,6):int(1,9)),
    "Damage Report":"","Blocks Reservations":["Repair","Damage Repair","Recall","Safety Inspection"].includes(type)?"Yes":"No",
    "Status":st,
    "Description":({Preventive:"100-hour service — oil, filters, impeller, gearcase lube.",
      Scheduled:"Seasonal scheduled service per manufacturer interval.",Repair:"Reported fault during return inspection.",
      Inspection:"Routine inspection.",Cleaning:"Deep clean and detail between rentals.",
      Winterization:"Fog engine, drain, stabilize fuel, shrink wrap.","Spring Commissioning":"De-winterize, battery, safety gear, sea trial.",
      "Damage Repair":"Repair of renter-reported damage.",Recall:"Manufacturer recall service bulletin.",
      "Safety Inspection":"Annual safety and flotation inspection."})[type]});
}
for(let i=0;i<420;i++){
  const r=pick(reservations.filter(x=>["Completed","Returned","Inspection","Equipment Released","Active Rental"].includes(x.Status)));
  if(!r)break;
  const a=assets.find(x=>x["Asset Name"]===r.Asset);
  const type=chance(0.5)?"Pre-Rental":"Post-Rental";
  const passed=chance(0.93)?"Yes":"No";
  inspN++;
  inspections.push({"Inspection ID":`INS-${pad(inspN,5)}`,"Asset":r.Asset,"Asset Tag":a?.["Asset Tag"]||"",
    "Reservation":r["Reservation ID"],"Franchise":r.Franchise,"Location":r.Location,"Inspection Type":type,
    "Inspector":r["Released By"]||pick(employees.filter(e=>e.Location===r.Location))?.["Employee Name"]||"",
    "Inspected At":`${r["Start Date"]} ${type==="Pre-Rental"?r["Start Time"]:r["End Time"]}`,
    "Fuel Level":pick(["Full","3/4","1/2","1/4"]),"Engine Hours":a?.["Engine Hours"]||"",
    "Condition":pickW(["Excellent","Good","Fair"],[40,48,12]),"Photos Count":String(int(2,6)),
    "Passed":passed,"Issues Found":passed==="No"?pick(["Prop dings","Low fuel","Missing life jacket","Bilge water","Torn seat"]):"",
    "Notes":""});
}
const SEVERITY=["Cosmetic","Minor","Operational","Unsafe"];
for(let i=0;i<70;i++){
  const r=pick(reservations.filter(x=>x.Status==="Completed"));
  const a=assets.find(x=>x["Asset Name"]===r.Asset);
  const sev=pickW(SEVERITY,[42,32,20,6]);
  const cost=sev==="Cosmetic"?int(75,400):sev==="Minor"?int(250,1200):sev==="Operational"?int(800,4500):int(2500,14000);
  const custResp=chance(0.62)?"Yes":"No";
  const oos=["Operational","Unsafe"].includes(sev)?"Yes":"No";
  dmgN++;
  const dmgId=`DMG-${pad(dmgN,4)}`;
  const st=pickW(["Closed","Repaired","Charged","Claim Filed","Under Review","New","Waived"],[22,20,18,14,12,8,6]);
  damageReports.push({"Damage ID":dmgId,"Asset":r.Asset,"Asset Tag":a?.["Asset Tag"]||"","Reservation":r["Reservation ID"],
    "Confirmation Code":r["Confirmation Code"],"Customer":r["Customer Name"],"Franchise":r.Franchise,"Location":r.Location,
    "Reported By":r["Released By"]||"Dock staff","Reported At":r["End Date"],"Severity":sev,
    "Damage Area":pick(["Propeller","Hull — port side","Hull — starboard","Transom","Seating","Bimini top","Windshield","Trailer","Console","Deck"]),
    "Photos Count":String(int(2,8)),"Estimated Cost":String(cost),"Customer Responsible":custResp,
    "Charge Amount":custResp==="Yes"?String(Math.min(cost,+r["Security Deposit"]||cost)):"0",
    "Out Of Service":oos,"Work Order":"","Claim":"","Status":st,
    "Description":`${sev} damage to the ${pick(["propeller","hull","seating","canopy","console"])} discovered during the post-rental inspection.`});
  // a real claim only where protection applied and the cost justifies it
  if(["Claim Filed","Repaired","Closed"].includes(st)&&r["Protection Plan"]!=="No Protection"&&cost>800&&chance(0.75)){
    clmN++;
    const plan=protectionPlans.find(p=>p["Plan Name"]===r["Protection Plan"]);
    const cstatus=pickW(["Paid","Approved","Under Review","Adjuster Assigned","Submitted","Partially Approved","Denied"],[26,18,16,12,12,10,6]);
    const approved=["Paid","Approved"].includes(cstatus)?Math.max(0,cost-+plan.Deductible)
      :cstatus==="Partially Approved"?Math.round((cost-+plan.Deductible)*0.6):0;
    claims.push({"Claim ID":`CLM-${pad(clmN,4)}`,"Damage Report":dmgId,"Incident":"","Reservation":r["Reservation ID"],
      "Asset":r.Asset,"Customer":r["Customer Name"],"Franchise":r.Franchise,"Protection Plan":r["Protection Plan"],
      "Provider":plan.Provider,"Claim Number":`NSU-${int(100000,999999)}`,"Filed Date":r["End Date"],
      "Amount Claimed":String(cost),"Deductible":plan.Deductible,"Amount Approved":String(approved),
      "Adjuster":pick(["R. Feltman","D. Okonkwo","S. Baird","M. Iversen"]),
      "Decision Date":["Paid","Approved","Denied","Partially Approved"].includes(cstatus)?d2s(day(-int(0,60))):"",
      "Status":cstatus,"Notes":""});
    damageReports[damageReports.length-1].Claim=`CLM-${pad(clmN,4)}`;
  }
}
const INC_TYPES=["Near Miss","Property Damage","Injury","Medical","Grounding","Collision","Capsize","Regulatory"];
for(let i=0;i<18;i++){
  const r=pick(reservations.filter(x=>x.Status==="Completed"));
  const sev=pickW(["Low","Moderate","Serious","Critical"],[45,35,17,3]);
  incN++;
  incidents.push({"Incident ID":`INC-${pad(incN,3)}`,"Incident Type":pickW(INC_TYPES,[26,22,14,10,12,8,5,3]),
    "Severity":sev,"Franchise":r.Franchise,"Location":r.Location,"Asset":r.Asset,"Reservation":r["Reservation ID"],
    "Customer":r["Customer Name"],"Occurred At":`${r["Start Date"]} ${r["End Time"]}`,
    "Reported By":r["Released By"]||"Dock staff","Injuries":sev==="Low"?"None":pick(["None","Minor — first aid on site","Treated and released"]),
    "Authorities Notified":["Serious","Critical"].includes(sev)?"Yes":chance(0.2)?"Yes":"No",
    "Regulatory Report":sev==="Critical"?"Coast Guard 2692 filed":"",
    "Corporate Reviewed":["Serious","Critical"].includes(sev)?"Yes":chance(0.3)?"Yes":"No",
    "Reviewed By":["Serious","Critical"].includes(sev)?"Corporate Risk":"","Status":pickW(["Closed","Investigating","Open","Escalated"],[45,25,20,10]),
    "Description":"Reported during or immediately following the rental; documented per BillysBoatWorks incident procedure."});
}
// An unresolved out-of-service damage report means the hull is DOWN. Without this the
// fleet contradicts itself: Damage says out of service while Assets says Available, and
// availability search happily rents the boat out.
const UNRESOLVED_DMG=["New","Under Review","Charged","Claim Filed"];
for(const d of damageReports){
  if(d["Out Of Service"]!=="Yes")continue;
  const a=assets.find(x=>x["Asset Name"]===d.Asset);
  if(!a)continue;
  if(UNRESOLVED_DMG.includes(d.Status)){
    a.Status="Out of Service";
    a.Condition=d.Severity==="Unsafe"?"Poor":"Fair";
  }
}

// link damage-driven work orders
damageReports.filter(d=>d["Out Of Service"]==="Yes").slice(0,26).forEach(d=>{
  woN++;
  const wo=`WO-${pad(woN,4)}`;
  maintenance.push({"Work Order ID":wo,"Asset":d.Asset,"Asset Tag":d["Asset Tag"],"Franchise":d.Franchise,
    "Location":d.Location,"Maintenance Type":"Damage Repair","Priority":d.Severity==="Unsafe"?"Urgent":"High",
    "Reported By":d["Reported By"],"Assigned To":"Contract Service","Opened Date":d["Reported At"],
    "Scheduled Date":d["Reported At"],"Completed Date":["Repaired","Closed"].includes(d.Status)?d2s(day(-int(0,40))):"",
    "Engine Hours At Service":"","Parts Cost":String(Math.round(+d["Estimated Cost"]*0.6)),
    "Labor Cost":String(Math.round(+d["Estimated Cost"]*0.4)),"Total Cost":d["Estimated Cost"],
    "Downtime Days":String(int(2,14)),"Damage Report":d["Damage ID"],"Blocks Reservations":"Yes",
    "Status":["Repaired","Closed"].includes(d.Status)?"Complete":"In Progress",
    "Description":`Repair for ${d["Damage ID"]}: ${d.Description}`});
  d["Work Order"]=wo;
});

/* ─────────────── weather ─────────────── */
const weatherEvents=[];
const WX=[["Severe Thunderstorm","Warning","Cancel Rentals"],["High Wind","Warning","Pause Bookings"],
  ["Lightning","Warning","Cancel Rentals"],["High Wind","Advisory","Monitor"],["Flooding","Watch","Pause Bookings"],
  ["Fog","Advisory","Delay"],["Poor Water Conditions","Advisory","Monitor"],["Severe Thunderstorm","Watch","Monitor"]];
for(let i=0;i<14;i++){
  const [type,sev,rec]=pick(WX);
  const d=pick(destinations);
  const offset=int(-60,3);
  const active=offset>=-1;
  const affected=int(2,28);
  weatherEvents.push({"Event ID":`WX-${pad(i+1,3)}`,"Destination":d["Destination Name"],
    "Franchise":franchises.find(f=>f.Territory===`${d["Destination Name"]} Territory`)?.["Franchise Name"]||"",
    "Location":"","Weather Type":type,"Severity":sev,"Source":"National Weather Service feed",
    "Starts At":`${d2s(day(offset))} ${int(10,18)}:00`,"Ends At":`${d2s(day(offset))} ${int(19,23)}:00`,
    "Recommended Action":rec,"Action Taken":active?"":pickW([rec,"Monitor","Delay"],[60,25,15]),
    "Reservations Affected":String(affected),"Revenue At Risk":String(affected*int(180,520)),
    "Decision By":active?"":pick(employees.filter(e=>e.Role==="Owner"))["Employee Name"],
    "Decision At":active?"":`${d2s(day(offset))} ${int(10,18)}:30`,
    "Status":active?"Active":pickW(["Resolved","Overridden"],[85,15]),
    "Notes":active?"Awaiting operator decision — automatic cancellation is never applied without human review.":""});
}

/* ─────────────── training ─────────────── */
const COURSES=[["BillysBoatWorks Orientation","All","Orientation","Yes",90,24],["Water Safety Fundamentals","All","Safety","Yes",120,12],
  ["Pontoon Operation","Employee","Operations","Yes",60,24],["Jet Ski / PWC Operation","Employee","Operations","Yes",45,24],
  ["Customer Check-In & Release","Employee","Operations","Yes",45,24],["Incident Reporting","All","Emergency","Yes",30,12],
  ["Emergency & Rescue Procedures","All","Emergency","Yes",90,12],["Marine Maintenance Basics","Employee","Maintenance","No",120,24],
  ["Insurance & Claims Procedure","Manager","Insurance","Yes",60,24],["Franchise Financial Management","Franchisee","Operations","Yes",180,36],
  ["Local Marketing Playbook","Franchisee","Operations","No",90,36],["Severe Weather Operations","All","Emergency","Yes",45,12]];
const trainingCourses=COURSES.map(([name,aud,cat,req,mins,valid],i)=>({
  "Course ID":`CRS-${pad(i+1,3)}`,"Course Name":name,"Audience":aud,"Category":cat,"Required":req,
  "Duration Minutes":String(mins),"Valid Months":String(valid),"Status":"Active",
  "Description":`${name} — required for ${aud.toLowerCase()} staff.`}));
const trainingRecords=[];
for(const emp of employees){
  const applicable=trainingCourses.filter(c=>c.Audience==="All"
    ||(c.Audience==="Employee"&&!["Owner"].includes(emp.Role))
    ||(c.Audience==="Manager"&&emp.Role.includes("Manager"))
    ||(c.Audience==="Franchisee"&&emp.Role==="Owner"));
  for(const c of shuffle(applicable).slice(0,int(2,4))){
    const completed=chance(0.78);
    const compDate=completed?day(-int(10,700)):null;
    const expires=completed?new Date(compDate.getTime()+ +c["Valid Months"]*30*86400000):null;
    trainingRecords.push({"Record ID":`TRN-${pad(trainingRecords.length+1,4)}`,"Course":c["Course Name"],
      "Employee":emp["Employee ID"],"Employee Name":emp["Employee Name"],"Franchise":emp.Franchise,"Role":emp.Role,
      "Assigned Date":d2s(day(-int(700,760))),"Completed Date":completed?d2s(compDate):"",
      "Expires Date":completed?d2s(expires):"","Score":completed?String(int(78,100)):"",
      "Status":!completed?pickW(["Assigned","In Progress","Overdue"],[40,35,25])
        :(expires<TODAY?"Expired":"Complete")});
  }
}

/* ─────────────── franchise prospects ─────────────── */
const STAGES=["Inquiry","Qualification","Application","Territory Review","Financial Review","FDD Sent",
  "Agreement","Deposit","Equipment Selection","Insurance","Training","Location Setup","Launch Checklist","Awarded","Declined"];
const prospects=[];
const availTerr=territories.filter(t=>["Available","Reserved","Expansion"].includes(t.Status));
for(let i=0;i<40;i++){
  const stage=pickW(STAGES,[16,12,10,8,7,7,5,4,4,3,4,3,3,8,6]);
  const name=person();
  const t=pick(availTerr);
  const inq=day(-int(5,420));
  const idx=STAGES.indexOf(stage);
  prospects.push({"Prospect ID":`PRO-${pad(i+1,3)}`,"Prospect Name":name,"Email":emailOf(name,pick(["gmail.com","outlook.com","yahoo.com"])),
    "Phone":phone(),"City":t.County,"State":t.State,"Desired Territory":t["Territory Name"],"Desired Destination":t.Destination,
    "Stage":stage,"Source":pickW(["Website","Franchise Expo","Referral","Broker","Existing Customer","Social"],[32,18,20,12,12,6]),
    "Liquid Capital":String(int(75,600)*1000),"Net Worth":String(int(300,2400)*1000),
    "Qualification Score":String(stage==="Declined"?int(20,55):int(58,97)),
    "Assigned To":pick(["Sam Whitcomb","Priya Raman","Dev Okafor"]),
    "Inquiry Date":d2s(inq),"Application Date":idx>=2?d2s(day(-int(3,380))):"",
    "FDD Sent Date":idx>=5?d2s(day(-int(2,320))):"","Agreement Date":idx>=6?d2s(day(-int(1,280))):"",
    "Deposit Paid":idx>=7?"25000":"","Target Open Date":idx>=6?d2s(day(int(20,300))):"",
    "Last Activity":d2s(day(-int(0,45))),
    "Next Step":({Inquiry:"Send franchise information kit",Qualification:"Schedule qualification call",
      Application:"Collect completed application",'Territory Review':"Confirm territory availability",
      'Financial Review':"Verify liquid capital and net worth",'FDD Sent':"14-day FDD review period",
      Agreement:"Counter-sign franchise agreement",Deposit:"Collect franchise deposit",
      'Equipment Selection':"Finalize equipment package",Insurance:"Bind required coverage",
      Training:"Complete franchisee training",'Location Setup':"Secure dock agreements",
      'Launch Checklist':"Complete pre-opening checklist",Awarded:"Operating",Declined:"Closed"})[stage],
    "Status":stage==="Declined"?"Closed":stage==="Awarded"?"Awarded":"Active","Notes":""});
  if(stage==="Reserved"||["Agreement","Deposit","Equipment Selection","Insurance","Training","Location Setup","Launch Checklist"].includes(stage)){
    t.Status="Reserved";t["Reserved For"]=name;
  }
}

/* ─────────────── royalty statements ─────────────── */
const royaltyStatements=[];
const PERIODS=["2026-05","2026-06","2026-07"];
for(const fr of franchises.filter(f=>f.Status==="Operating")){
  for(const period of PERIODS){
    const pays=payments.filter(p=>p.Franchise===fr["Franchise Name"]&&p.Period===period);
    const gross=pays.filter(p=>p["Payment Type"]==="Capture").reduce((s,p)=>s+ +p.Amount,0);
    const refunds=pays.filter(p=>p["Payment Type"]==="Refund").reduce((s,p)=>s+ +p.Amount,0);
    const net=gross-refunds;
    const royalty=Math.round(net*(+fr["Royalty Rate"]/100));
    const mkt=Math.round(net*(+fr["Marketing Fee Rate"]/100));
    const ins=Math.round(pays.filter(p=>p["Payment Type"]==="Capture").length*3.5);
    const resCount=new Set(pays.map(p=>p.Reservation)).size;
    royaltyStatements.push({"Statement ID":`RS-${fr["Franchise ID"]}-${period.replace("-","")}`,
      "Franchise":fr["Franchise Name"],"Period":period,"Period Start":`${period}-01`,"Period End":`${period}-28`,
      "Gross Revenue":money(gross),"Refunds":money(refunds),"Net Revenue":money(net),"Royalty Rate":fr["Royalty Rate"],
      "Royalty Amount":money(royalty),"Marketing Fee":money(mkt),"Platform Fee":fr["Platform Fee"],
      "Insurance Commission":money(ins),"Other Fees":"0",
      "Total Due":money(royalty+mkt+ +fr["Platform Fee"]),
      "Franchise Net":money(net-royalty-mkt-+fr["Platform Fee"]),
      "Reservation Count":String(resCount),"Issued Date":`${period}-28`,
      "Paid Date":period==="2026-07"?"":`${period}-30`,"Status":period==="2026-07"?"Issued":"Paid"});
  }
}

/* ─────────────── audit log ─────────────── */
const auditLog=[];
const AUDIT=[["Reservation","Status changed","Status"],["Reservation","Price adjusted","Total"],
  ["Payment","Refund issued","Amount"],["Asset","Status changed","Status"],["Damage Report","Severity updated","Severity"],
  ["Claim","Status changed","Status"],["Pricing Rule","Rate changed","Base Price"],["Employee","Role changed","Role"],
  ["Franchise","Royalty rate changed","Royalty Rate"],["Waiver","Document version pinned","Document Version"]];
for(let i=0;i<200;i++){
  const [entity,action,field]=pick(AUDIT);
  const fr=pick(franchises);
  const ref=entity==="Reservation"?pick(reservations)["Confirmation Code"]
    :entity==="Asset"?pick(assets)["Asset Tag"]
    :entity==="Payment"?pick(payments)["Payment ID"]
    :entity==="Damage Report"?pick(damageReports)["Damage ID"]
    :entity==="Claim"&&claims.length?pick(claims)["Claim ID"]
    :entity==="Employee"?pick(employees)["Employee ID"]
    :entity==="Franchise"?fr["Franchise ID"]:pick(pricingRules)["Rule ID"];
  auditLog.push({"Audit ID":`AUD-${pad(i+1,5)}`,"Entity Type":entity,"Entity Reference":ref,"Action":action,
    "Field Changed":field,"Previous Value":pick(["Confirmed","Available","250","Minor","6","Standard","Submitted"]),
    "New Value":pick(["Completed","Maintenance","275","Operational","6.5","Premier","Approved"]),
    "Changed By":pick(employees)["Employee Name"],"Changed At":`${d2s(day(-int(0,120)))} ${int(7,19)}:${pad(int(0,59),2)}`,
    "Franchise":fr["Franchise Name"],
    "Reason":pick(["Customer request","Post-rental inspection","Weather event","Corporate policy update","Manager override","Scheduled maintenance"])});
}

/* ─────────────── write ─────────────── */
const out={destinations,territories,franchises,"franchise-prospects":prospects,locations,employees,
  "equipment-categories":categories,assets,inventory,customers,reservations,
  "reservation-items":reservationItems,"pricing-rules":pricingRules,payments,"protection-plans":protectionPlans,
  waivers,"maintenance-orders":maintenance,inspections,"damage-reports":damageReports,incidents,claims,reviews,
  "weather-events":weatherEvents,"training-courses":trainingCourses,"training-records":trainingRecords,
  notifications,"royalty-statements":royaltyStatements,"audit-log":auditLog};
fs.writeFileSync(path.join(__dir,"seed-data.json"),JSON.stringify(out,null,2));
let total=0;
for(const [k,v] of Object.entries(out)){total+=v.length;console.log(`  ${k.padEnd(22)} ${String(v.length).padStart(5)}`);}
console.log(`  ${"TOTAL".padEnd(22)} ${String(total).padStart(5)} records`);
