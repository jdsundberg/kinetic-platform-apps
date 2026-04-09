#!/usr/bin/env node
/**
 * Real smoke test — loads each app, clicks every tab, checks for JS errors
 * and visible error messages. Saves screenshots of failures.
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:3011";
const SERVER = "https://first.kinetics.com";
const USER = "john";
const PASS = "john1";
const SCREENSHOT_DIR = "/tmp/app-test-screenshots";

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const SKIP = new Set(["ai-training"]); // static page, no kapp

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // Login
  console.log("\n  Logging in...");
  await page.goto(BASE);
  await page.waitForTimeout(1000);
  const urlField = page.locator("#login-url").first();
  if (await urlField.isVisible().catch(() => false)) await urlField.fill(SERVER);
  await page.locator("#login-user").first().fill(USER);
  await page.locator("#login-pass, input[type='password']").first().fill(PASS);
  await page.locator("button:has-text('Sign In')").first().click();
  await page.waitForTimeout(3000);
  console.log("  Logged in\n");

  // Get all app links
  const appLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map(a => ({ href: a.getAttribute("href"), name: a.textContent.trim().split("\n")[0].trim() }))
      .filter(a => a.href && a.href.match(/^\/[a-z][\w-]*\/?$/) && a.href !== "/" && !a.href.startsWith("/home"));
  });

  console.log(`  Testing ${appLinks.length} apps\n`);

  const results = [];

  for (const app of appLinks) {
    const slug = app.href.replace(/\//g, "");
    if (SKIP.has(slug)) { console.log(`  SKIP ${app.name}`); continue; }

    console.log(`  ${app.name} (${slug})`);

    // Track JS errors and failed API calls for this app
    const jsErrors = [];
    const apiErrors = [];

    const onError = (err) => jsErrors.push(err.message || String(err));
    const onResponse = (resp) => {
      if (resp.url().includes("/api/") && resp.status() >= 400) {
        apiErrors.push(`${resp.status()} ${resp.url().slice(0, 100)}`);
      }
    };

    page.on("pageerror", onError);
    page.on("response", onResponse);

    try {
      await page.goto(`${BASE}${app.href}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);

      // Check if install prompt showed (kapp not installed)
      const installBtn = page.locator("#kapp-install-btn");
      if (await installBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log("    Not installed — skipping");
        results.push({ app: app.name, slug, status: "not-installed" });
        page.removeListener("pageerror", onError);
        page.removeListener("response", onResponse);
        await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
        continue;
      }

      // Find tabs
      const tabs = await page.evaluate(() => {
        const sels = [".topbar nav button", "nav button", ".tab-bar button", "[role='tab']"];
        for (const sel of sels) {
          const els = document.querySelectorAll(sel);
          if (els.length > 1) return Array.from(els).map((el, i) => ({ text: el.textContent.trim(), i })).filter(t => t.text.length < 30);
        }
        return [];
      });

      const tabResults = [];
      for (const tab of tabs) {
        jsErrors.length = 0;
        apiErrors.length = 0;

        // Click tab
        const tabSels = [".topbar nav button", "nav button", ".tab-bar button", "[role='tab']"];
        let clicked = false;
        for (const sel of tabSels) {
          const count = await page.locator(sel).count();
          if (count > tab.i) {
            await page.locator(sel).nth(tab.i).click();
            clicked = true;
            break;
          }
        }
        if (!clicked) continue;

        await page.waitForTimeout(2000);

        // Check for visible error text in the main content
        const errorText = await page.evaluate(() => {
          const body = document.body.innerText;
          const patterns = [
            /Error loading[^:]*:[^\n]+/i,
            /Failed to load[^\n]+/i,
            /undefined is not an object[^\n]+/i,
            /Cannot read properties of[^\n]+/i,
            /400 Bad Request/i,
            /index definitions to exist/i,
          ];
          for (const p of patterns) {
            const m = body.match(p);
            if (m) return m[0].slice(0, 120);
          }
          return null;
        });

        const hasError = errorText || jsErrors.length > 0;
        if (hasError) {
          const msg = errorText || jsErrors[0] || apiErrors[0] || "unknown";
          tabResults.push({ tab: tab.text, error: msg });
          console.log(`    FAIL "${tab.text}": ${msg.slice(0, 80)}`);
          await page.screenshot({ path: `${SCREENSHOT_DIR}/${slug}_${tab.text.replace(/[^a-zA-Z0-9]/g, '_')}.png` });
        } else {
          tabResults.push({ tab: tab.text, error: null });
        }
      }

      const failures = tabResults.filter(t => t.error);
      if (failures.length === 0) {
        console.log(`    OK (${tabs.length} tabs)`);
        results.push({ app: app.name, slug, status: "ok", tabs: tabs.length });
      } else {
        console.log(`    ${failures.length}/${tabs.length} tabs FAILED`);
        results.push({ app: app.name, slug, status: "errors", tabs: tabs.length, failures });
      }

    } catch (e) {
      console.log(`    ERROR: ${e.message.slice(0, 80)}`);
      results.push({ app: app.name, slug, status: "error", error: e.message.slice(0, 150) });
    }

    page.removeListener("pageerror", onError);
    page.removeListener("response", onResponse);
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  await browser.close();

  // Summary
  console.log("\n  ═══════════════════════════════════════");
  const ok = results.filter(r => r.status === "ok");
  const errors = results.filter(r => r.status === "errors");
  const failed = results.filter(r => r.status === "error");
  const notInstalled = results.filter(r => r.status === "not-installed");

  console.log(`  OK:            ${ok.length}`);
  console.log(`  Tab errors:    ${errors.length}`);
  console.log(`  Failed:        ${failed.length}`);
  console.log(`  Not installed: ${notInstalled.length}`);

  if (errors.length) {
    console.log("\n  Apps with broken tabs:");
    for (const r of errors) {
      console.log(`    ${r.app}:`);
      for (const f of r.failures) console.log(`      "${f.tab}": ${f.error.slice(0, 80)}`);
    }
  }
  if (failed.length) {
    console.log("\n  Apps that crashed:");
    for (const r of failed) console.log(`    ${r.app}: ${r.error}`);
  }
  if (notInstalled.length) {
    console.log("\n  Not installed:");
    for (const r of notInstalled) console.log(`    ${r.app}`);
  }

  console.log(`\n  Screenshots: ${SCREENSHOT_DIR}/`);
  fs.writeFileSync("/tmp/tab-test-results.json", JSON.stringify(results, null, 2));
  console.log("  Results: /tmp/tab-test-results.json\n");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
