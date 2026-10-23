/**
 * ui.mjs — real browser test (Playwright, dev-only dependency resolved from admin_apps/node_modules).
 * For each role user: sign in, visit every tab that role can see, open drill-downs, and fail on any
 * page error / console error / error banner. Saves screenshots to docs/screenshots/.
 * Usage: node tests/ui.mjs [--incident=INC-…]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire("/Users/jdsundberg/dev/claude/admin_apps/package.json");
const { chromium } = require("playwright");
import { PW } from "../deploy/users.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const SHOTS = path.join(DIR, "../docs/screenshots"); fs.mkdirSync(SHOTS, { recursive: true });
const BASE = (process.env.NOC_LAUNCHER || "http://127.0.0.1:3031") + "/telco-noc/";
const ROLES = [["noc.borealis", ["cc", "inc", "map", "net", "cust", "chg", "field", "exec"]], ["owner.borealis", ["cc", "inc", "map", "net", "cust", "chg", "exec"]],
  ["tech.borealis", ["field", "inc", "map"]], ["support.borealis", ["cust", "cc"]], ["exec.borealis", ["exec", "cc", "map"]], ["noc.prairie", ["cc", "inc", "map", "net", "cust", "chg", "field", "exec"]]];
const BAD = /Cannot read properties|undefined is not an object|is not a function|Failed to load|Error loading|NaN|\[object Object\]/;
let fails = 0; const log = (ok, m) => { console.log(`${ok ? "PASS" : "FAIL"} ${m}`); if (!ok) fails++; };

const browser = await chromium.launch({ headless: true });
for (const [user, tabs] of ROLES) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push("pageerror: " + e.message)); page.on("console", (m) => { if (m.type() === "error" && !/favicon|401/.test(m.text())) errors.push("console: " + m.text()); });
  // Through the launcher, the app is entered with the launcher's session (base_session), exactly as a user who signed in at "/"
  await ctx.addInitScript(([u, p]) => { const s = JSON.stringify({ server: "https://first.kinetics.com", url: "", auth: btoa(u + ":" + p), user: u, displayName: u }); try { localStorage.setItem("base_session", s); sessionStorage.setItem("base_session", s); } catch (e) {} }, [user, PW]);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#nav button").length > 0, null, { timeout: 30000 }).catch(() => {});
  const nav = await page.$$eval("#nav button", (b) => b.map((x) => x.dataset.t));
  log(JSON.stringify([...nav].sort()) === JSON.stringify([...tabs].sort()), `${user}: navigation = ${nav.join(",")}`);
  for (const t of nav) {
    await page.click(`#nav button[data-t="${t}"]`);
    await page.waitForFunction((t) => { const el = document.getElementById("tab-" + t); return el && !el.querySelector(".pulse") && el.innerText.length > 40; }, t, { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(600);
    const text = await page.$eval(`#tab-${t}`, (el) => el.innerText);
    const banner = await page.$$eval(`#tab-${t} .banner.err`, (b) => b.map((x) => x.innerText));
    const expectedDenied = user === "noc.prairie" && t === "inc" ? false : false;
    log(!BAD.test(text) && !banner.length && !expectedDenied, `${user}: tab ${t} renders (${text.length} chars)${banner.length ? " banner: " + banner[0].slice(0, 120) : ""}${BAD.test(text) ? " BAD TEXT: " + text.match(BAD)[0] : ""}`);
    if (user === "noc.borealis" || (user === "owner.borealis" && t === "exec") || (user === "support.borealis" && t === "cust") || (user === "tech.borealis" && t === "field"))
      await page.screenshot({ path: path.join(SHOTS, `${user.split(".")[0]}-${t}.png`), fullPage: false });
  }
  if (user === "noc.borealis" && nav.includes("inc")) {
    await page.click(`#nav button[data-t="inc"]`); await page.waitForTimeout(2500);
    for (const sub of ["Services", "Customers", "Alarms", "Timeline", "Field work", "Comms", "AI assist", "History"]) {
      const b = await page.$(`.tabs2 button:has-text("${sub}")`); if (!b) { log(false, `workspace sub-tab ${sub} missing`); continue; }
      await b.click(); await page.waitForTimeout(sub === "Alarms" ? 2500 : 500);
      const body = await page.$eval("#ws-body", (el) => el.innerText);
      log(!BAD.test(body) && body.length > 20, `noc.borealis: workspace › ${sub} (${body.length} chars)`);
      if (["Services", "Alarms", "AI assist", "Timeline"].includes(sub)) await page.screenshot({ path: path.join(SHOTS, `noc-inc-${sub.replace(/ /g, "").toLowerCase()}.png`) });
    }
    const next = await page.$(`#al-tbl .pager button:has-text("Next")`);
    if (next && !(await next.isDisabled())) { await page.click(`.tabs2 button:has-text("Alarms")`); await page.waitForTimeout(2000); await page.click(`#al-tbl .pager button:has-text("Next")`); await page.waitForTimeout(2000); log((await page.$eval("#al-tbl", (e) => e.innerText)).includes("page 2"), "alarms pager → page 2"); }
    await page.click(`#nav button[data-t="net"]`); await page.waitForTimeout(2500); await page.waitForSelector("#net-tbl tr.click", { timeout: 20000 }); await page.click("#net-tbl tr.click"); await page.waitForFunction(() => /provenance/i.test(document.getElementById("drawer").innerText), null, { timeout: 20000 }).catch(() => {});
    log(/provenance/i.test(await page.$eval("#drawer", (e) => e.innerText)), "network resource drawer opens with provenance");
    await page.screenshot({ path: path.join(SHOTS, "noc-net-drawer.png") });
    await page.click(`#nav button[data-t="chg"]`); await page.waitForTimeout(2000); const rr = await page.$('button:has-text("Risk review")');
    if (rr) { await rr.click(); await page.waitForTimeout(4000); log(/recommendation/i.test(await page.$eval("#chg-risk", (e) => e.innerText)), "change risk review renders"); await page.screenshot({ path: path.join(SHOTS, "noc-chg-risk.png") }); }
  }
  log(errors.length === 0, `${user}: no JS errors${errors.length ? " — " + errors.slice(0, 3).join(" | ") : ""}`);
  await ctx.close();
}
// deep link cold-open (every URL is someone's first URL)
{ const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(BASE + "#exec", { waitUntil: "domcontentloaded" });
  log(await page.isVisible("#login-screen"), "cold deep link without session shows sign-in (not an empty shell)"); await ctx.close(); }
await browser.close();
console.log(fails ? `${fails} UI checks FAILED` : "ALL UI CHECKS PASS"); process.exit(fails ? 1 : 0);
