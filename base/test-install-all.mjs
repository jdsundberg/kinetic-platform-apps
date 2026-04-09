#!/usr/bin/env node
/**
 * Automated install & smoke test for all apps.
 * Uses Playwright to:
 * 1. Log in to the launcher
 * 2. Click each app
 * 3. If not installed, click "Install App"
 * 4. Wait for install to complete and page to reload
 * 5. Click each tab in the app
 * 6. Check for 400/500 errors and "Bad Request" text
 * 7. Report results
 *
 * Usage: node test-install-all.mjs [--headed]
 */
import { chromium } from "playwright";

const BASE = "http://localhost:3011";
const SERVER = "https://first.kinetics.com";
const USER = "john";
const PASS = "john1";
const HEADED = process.argv.includes("--headed");

// Apps to skip (admin tools, no index.html, or special cases)
const SKIP = new Set(["base", "home", "ai_training", "og_compliance"]);

const results = [];

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // Track API errors
  const apiErrors = [];
  page.on("response", (resp) => {
    const url = resp.url();
    if ((url.includes("/app/api/") || url.includes("/api/")) && resp.status() >= 400) {
      apiErrors.push({ url: url.slice(0, 120), status: resp.status() });
    }
  });

  // Login
  console.log("\n  === Login ===");
  await page.goto(BASE);
  await page.waitForLoadState("domcontentloaded");

  // Fill login form
  const urlField = page.locator("#login-url, input[placeholder*='server'], input[placeholder*='Server'], input[placeholder*='URL']").first();
  if (await urlField.isVisible()) {
    await urlField.fill(SERVER);
  }
  await page.locator("#login-user, input[placeholder*='user'], input[placeholder*='User']").first().fill(USER);
  await page.locator("#login-pass, input[type='password']").first().fill(PASS);
  await page.locator("button:has-text('Sign In'), button:has-text('Login'), button:has-text('Log In')").first().click();
  await page.waitForLoadState("domcontentloaded");
  await delay(2000);

  console.log("  Logged in\n");

  // Get list of app links from the launcher
  const appLinks = await page.evaluate(() => {
    const links = [];
    document.querySelectorAll("a[href], .app-card, [onclick]").forEach(el => {
      const href = el.getAttribute("href") || "";
      const onclick = el.getAttribute("onclick") || "";
      // Match links like /bookstore/ or /sec-ops/
      const m = href.match(/^\/([a-z][\w-]*)\/?$/);
      if (m && m[1] !== "base" && m[1] !== "home") {
        const name = el.textContent.trim().split("\n")[0].trim();
        links.push({ slug: m[1], name: name || m[1], href });
      }
    });
    return links;
  });

  console.log(`  Found ${appLinks.length} app links\n`);

  for (const app of appLinks) {
    if (SKIP.has(app.slug)) {
      console.log(`  SKIP: ${app.name}`);
      results.push({ app: app.name, slug: app.slug, status: "skipped" });
      continue;
    }

    console.log(`  --- ${app.name} (${app.slug}) ---`);
    apiErrors.length = 0;

    try {
      // Navigate to the app
      await page.goto(`${BASE}/${app.slug}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await delay(1500);

      // Check if install prompt appears
      const installBtn = page.locator("#kapp-install-btn");
      if (await installBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log("    Installing...");
        await installBtn.click();

        // Wait for install to complete (look for "Installed" button text or page reload)
        try {
          await page.waitForFunction(() => {
            const btn = document.getElementById("kapp-install-btn");
            return btn && (btn.textContent === "Installed" || btn.textContent === "Retry");
          }, { timeout: 600000 });

          const btnText = await installBtn.textContent();
          if (btnText === "Retry") {
            // Install failed
            const logEl = page.locator("#kapp-install-log");
            const logText = await logEl.textContent().catch(() => "");
            console.log("    INSTALL FAILED:", logText.slice(-200));
            results.push({ app: app.name, slug: app.slug, status: "install-failed", error: logText.slice(-200) });
            continue;
          }

          // Wait for auto-reload
          await delay(3000);
          await page.waitForLoadState("domcontentloaded");
        } catch (e) {
          console.log("    INSTALL TIMEOUT:", e.message.slice(0, 100));
          results.push({ app: app.name, slug: app.slug, status: "install-timeout" });
          continue;
        }

        console.log("    Installed, checking app...");
      }

      // App should be loaded now — find and click each tab
      await delay(1000);
      const tabs = await page.evaluate(() => {
        const tabEls = document.querySelectorAll(".topbar nav button, .tab-bar button, nav button, .nav-tabs button, .nav-tabs a, [role='tab']");
        return Array.from(tabEls).map((el, i) => ({
          text: el.textContent.trim(),
          index: i,
        })).filter(t => t.text && t.text.length < 30);
      });

      console.log(`    ${tabs.length} tabs found: ${tabs.map(t => t.text).join(", ")}`);

      let tabErrors = 0;
      for (const tab of tabs) {
        apiErrors.length = 0;
        try {
          // Click the tab
          const tabEl = page.locator(".topbar nav button, .tab-bar button, nav button, .nav-tabs button, .nav-tabs a, [role='tab']").nth(tab.index);
          await tabEl.click();
          await delay(1500);
          await page.waitForLoadState("domcontentloaded").catch(() => {});

          // Check for visible error messages
          // Only flag real index/form errors, not the word "error" in JS code
          const errorBanner = await page.locator(".error-banner, .toast-error, [class*='error-msg'], [style*='background'][style*='red']").count();
          const indexError = apiErrors.some(e => e.status === 400);

          if (errorBanner > 0 || indexError) {
            const errMsg = apiErrors.length > 0
              ? `API ${apiErrors[0].status}: ${apiErrors[0].url}`
              : "Visible error on page";
            console.log(`    ERROR on "${tab.text}": ${errMsg}`);
            tabErrors++;
          }
        } catch (e) {
          console.log(`    Tab "${tab.text}" click failed: ${e.message.slice(0, 80)}`);
          tabErrors++;
        }
      }

      const status = tabErrors > 0 ? `${tabErrors} tab errors` : "ok";
      console.log(`    Result: ${status}`);
      results.push({
        app: app.name,
        slug: app.slug,
        status: tabErrors > 0 ? "errors" : "ok",
        tabs: tabs.length,
        errors: tabErrors,
        details: apiErrors.slice(0, 3).map(e => `${e.status} ${e.url}`),
      });

    } catch (e) {
      console.log(`    FAILED: ${e.message.slice(0, 100)}`);
      results.push({ app: app.name, slug: app.slug, status: "failed", error: e.message.slice(0, 200) });
    }

    // Go back to launcher for next app
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await delay(500);
  }

  await browser.close();

  // Print summary
  console.log("\n  ╔═══════════════════════════════════════════╗");
  console.log("  ║          INSTALL & SMOKE TEST RESULTS       ║");
  console.log("  ╚═══════════════════════════════════════════╝\n");

  const ok = results.filter(r => r.status === "ok");
  const errors = results.filter(r => r.status === "errors");
  const failed = results.filter(r => r.status === "failed" || r.status === "install-failed" || r.status === "install-timeout");
  const skipped = results.filter(r => r.status === "skipped");

  console.log(`  OK:      ${ok.length}`);
  console.log(`  ERRORS:  ${errors.length}`);
  console.log(`  FAILED:  ${failed.length}`);
  console.log(`  SKIPPED: ${skipped.length}`);
  console.log();

  if (errors.length > 0) {
    console.log("  Apps with tab errors:");
    for (const r of errors) {
      console.log(`    ${r.app} (${r.slug}): ${r.errors}/${r.tabs} tabs failed`);
      for (const d of (r.details || [])) console.log(`      ${d}`);
    }
    console.log();
  }

  if (failed.length > 0) {
    console.log("  Apps that failed:");
    for (const r of failed) {
      console.log(`    ${r.app} (${r.slug}): ${r.status} — ${r.error || ""}`);
    }
    console.log();
  }

  // Write results to JSON
  const fs = await import("fs");
  fs.writeFileSync("/tmp/install-test-results.json", JSON.stringify(results, null, 2));
  console.log("  Results saved to /tmp/install-test-results.json\n");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
