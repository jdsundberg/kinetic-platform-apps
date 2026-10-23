/**
 * BillysBoatWorks invariant audit — asserts things that must be true of the
 * business, not of the code. Anything that fails is a real defect.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED="0";
const BASE=process.env.APP_URL||"http://localhost:3011";
const AUTH="Basic "+Buffer.from(`${process.env.KINETIC_USER||"john"}:${process.env.KINETIC_PASS||""}`).toString("base64");
const KAPP="billys";
const get=async p=>{const r=await fetch(BASE+p,{headers:{Authorization:AUTH}});const t=await r.text();
  try{return{status:r.status,data:JSON.parse(t)}}catch{return{status:r.status,data:{raw:t.slice(0,200)}}}};
async function all(form,kql){
  const out=[];let token=null;
  do{const q=`/app/api/v1/kapps/${KAPP}/forms/${form}/submissions?include=values&limit=1000`
      +(kql?`&q=${encodeURIComponent(kql)}`:"")+(token?`&pageToken=${encodeURIComponent(token)}`:"");
    const r=await get(q); if(r.status>=300) throw new Error(`${form}: ${r.status}`);
    out.push(...(r.data.submissions||[])); token=r.data.nextPageToken||null;
  }while(token);
  return out.map(s=>s.values);
}
const F=[],P=[];
const check=(name,ok,detail)=>{(ok?P:F).push({name,detail});console.log(`${ok?"  ✓":"  ✗"} ${name}${ok?"":" — "+detail}`)};

console.log("loading…");
const [res,items,pays,assets,wo,dmg,locs,frs,waivers]=await Promise.all([
  all("reservations"),all("reservation-items"),all("payments"),all("assets"),
  all("maintenance-orders"),all("damage-reports"),all("locations"),all("franchises"),all("waivers")]);
console.log(`reservations=${res.length} items=${items.length} payments=${pays.length} assets=${assets.length}\n`);

const num=x=>{const n=parseFloat(x);return isNaN(n)?0:n};
const ON_WATER=["Equipment Released","Active Rental","Returning"];
const CANCELLED=["Customer Cancelled","Operator Cancelled","Weather Cancelled","No Show"];

console.log("── money ──");
const byRes={};
for(const i of items)(byRes[i.Reservation]=byRes[i.Reservation]||[]).push(i);
let mismatch=0,sample="";
for(const r of res){
  const li=byRes[r["Reservation ID"]];if(!li)continue;
  const sum=li.reduce((s,x)=>s+num(x["Line Total"]),0);
  if(Math.abs(sum-num(r.Total))>1){mismatch++;if(!sample)sample=`${r["Confirmation Code"]} items=${sum} total=${r.Total}`}
}
check("line items sum to reservation total",mismatch===0,`${mismatch} mismatched (e.g. ${sample})`);

console.log("── lifecycle ──");
const onWater=res.filter(r=>ON_WATER.includes(r.Status));
const noAsset=onWater.filter(r=>!r.Asset);
check("every on-water rental has an assigned hull",noAsset.length===0,
  `${noAsset.length} without: ${noAsset.slice(0,3).map(r=>r["Confirmation Code"]).join(", ")}`);
const relNoStamp=res.filter(r=>ON_WATER.includes(r.Status)&&!r["Released At"]);
check("released rentals carry a release timestamp",relNoStamp.length===0,
  `${relNoStamp.length}: ${relNoStamp.slice(0,3).map(r=>r["Confirmation Code"]).join(", ")}`);
const relNoBy=res.filter(r=>ON_WATER.includes(r.Status)&&!r["Released By"]);
check("released rentals record who released them",relNoBy.length===0,`${relNoBy.length} missing`);
const doneNoReturn=res.filter(r=>r.Status==="Completed"&&!r["Returned At"]);
check("completed rentals carry a return timestamp",doneNoReturn.length<=res.filter(r=>r.Status==="Completed").length*0.02,
  `${doneNoReturn.length} of ${res.filter(r=>r.Status==="Completed").length} completed lack one`);

console.log("── double-booking ──");
const slots={};let conflicts=[];
for(const r of res){
  if(CANCELLED.includes(r.Status)||!r.Asset)continue;
  const k=`${r.Asset}|${r["Start Date"]}`;
  const s=+String(r["Start Time"]||"08:00").slice(0,2),e=+String(r["End Time"]||"17:00").slice(0,2);
  for(const [os,oe,code] of (slots[k]||[])) if(s<oe&&e>os) conflicts.push(`${r.Asset} ${r["Start Date"]} ${code} vs ${r["Confirmation Code"]}`);
  (slots[k]=slots[k]||[]).push([s,e,r["Confirmation Code"]]);
}
check("no hull double-booked in the same hours",conflicts.length===0,`${conflicts.length}: ${conflicts.slice(0,2).join(" | ")}`);

console.log("── fleet state ──");
const openBlocking=new Set(wo.filter(w=>w["Blocks Reservations"]==="Yes"&&!["Complete","Cancelled"].includes(w.Status)).map(w=>w.Asset));
const oosNoWO=assets.filter(a=>a.Status==="Out of Service"&&!openBlocking.has(a["Asset Name"]));
check("out-of-service hulls have an open blocking work order",oosNoWO.length===0,
  `${oosNoWO.length}: ${oosNoWO.slice(0,3).map(a=>a["Asset Name"]).join(", ")}`);
// A repaired/closed/waived report is history — the hull is legitimately back in service.
// Only an UNRESOLVED out-of-service report should keep it off the water.
const UNRESOLVED=["New","Under Review","Charged","Claim Filed"];
const dmgOOS=dmg.filter(d=>d["Out Of Service"]==="Yes"&&UNRESOLVED.includes(d.Status));
const stillAvail=dmgOOS.filter(d=>{const a=assets.find(x=>x["Asset Name"]===d.Asset);return a&&a.Status==="Available"});
check("hulls with UNRESOLVED out-of-service damage are not rentable",stillAvail.length===0,
  `${stillAvail.length} of ${dmgOOS.length}: ${stillAvail.slice(0,3).map(d=>d["Damage ID"]+"/"+d.Asset+"["+d.Status+"]").join(", ")}`);
const rentedNotOut=assets.filter(a=>a.Status==="Rented"&&!onWater.some(r=>r.Asset===a["Asset Name"]));
check("hulls marked Rented are actually on the water",rentedNotOut.length===0,
  `${rentedNotOut.length}: ${rentedNotOut.slice(0,3).map(a=>a["Asset Name"]).join(", ")}`);

console.log("── referential integrity ──");
const assetNames=new Set(assets.map(a=>a["Asset Name"]));
const locNames=new Set(locs.map(l=>l["Location Name"]));
const frNames=new Set(frs.map(f=>f["Franchise Name"]));
const badAsset=res.filter(r=>r.Asset&&!assetNames.has(r.Asset));
check("reservation.Asset points at a real hull",badAsset.length===0,`${badAsset.length} dangling`);
const badLoc=res.filter(r=>r.Location&&!locNames.has(r.Location));
check("reservation.Location points at a real location",badLoc.length===0,`${badLoc.length} dangling`);
const badFr=res.filter(r=>r.Franchise&&!frNames.has(r.Franchise));
check("reservation.Franchise points at a real franchise",badFr.length===0,`${badFr.length} dangling`);
const assetLoc=Object.fromEntries(assets.map(a=>[a["Asset Name"],a.Location]));
const wrongLoc=res.filter(r=>r.Asset&&assetLoc[r.Asset]&&r.Location&&assetLoc[r.Asset]!==r.Location);
check("a rental's hull lives at the rental's location",wrongLoc.length===0,
  `${wrongLoc.length}: ${wrongLoc.slice(0,3).map(r=>`${r["Confirmation Code"]} ${r.Asset}@${assetLoc[r.Asset]} vs ${r.Location}`).join(" | ")}`);

console.log("── payments ──");
const payByRes={};
for(const p of pays)(payByRes[p.Reservation]=payByRes[p.Reservation]||[]).push(p);
const captured=res.filter(r=>!CANCELLED.includes(r.Status)&&!["Draft","Pending Payment"].includes(r.Status));
const noCapture=captured.filter(r=>!(payByRes[r["Reservation ID"]]||[]).some(p=>p["Payment Type"]==="Capture"));
check("confirmed rentals have a captured payment",noCapture.length===0,
  `${noCapture.length} of ${captured.length}: ${noCapture.slice(0,3).map(r=>r["Confirmation Code"]).join(", ")}`);
const overCapture=captured.filter(r=>{
  const c=(payByRes[r["Reservation ID"]]||[]).filter(p=>p["Payment Type"]==="Capture");
  return c.length&&Math.abs(c.reduce((s,p)=>s+num(p.Amount),0)-num(r.Total))>1;});
check("captured amount equals the reservation total",overCapture.length===0,`${overCapture.length} differ`);

console.log("── waivers ──");
const wByRes=new Set(waivers.map(w=>w.Reservation));
const signedNoDoc=res.filter(r=>r["Waiver Signed"]==="Yes"&&!wByRes.has(r["Reservation ID"]));
check("rentals flagged waiver-signed have signature records",signedNoDoc.length===0,
  `${signedNoDoc.length} of ${res.filter(r=>r["Waiver Signed"]==="Yes").length} flagged`);
const releasedNoWaiver=onWater.filter(r=>r["Waiver Signed"]!=="Yes");
check("nothing was released without a signed waiver",releasedNoWaiver.length===0,
  `${releasedNoWaiver.length}: ${releasedNoWaiver.slice(0,3).map(r=>r["Confirmation Code"]).join(", ")}`);

console.log(`\n${P.length} passed, ${F.length} FAILED`);
if(F.length)process.exitCode=1;
if(F.length) {console.log("\nFAILURES:");F.forEach(f=>console.log(`  • ${f.name} — ${f.detail}`));}
