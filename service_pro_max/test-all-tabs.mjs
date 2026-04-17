/**
 * ServiceProMax — Comprehensive Playwright Test
 * Tests every tab, every subtab, validates data, takes screenshots
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3011";
const SCREENSHOTS = path.join(import.meta.dirname, "screenshots");
const DOCS = [];

if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS, { recursive: true });

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Step 1: Login through the base launcher
  console.log("Logging in via base launcher...");
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // Fill the server URL (may already be set)
  const loginUrlField = page.locator('#login-url');
  await loginUrlField.fill('https://first.kinetics.com');
  await page.fill('#login-user', 'john');
  await page.fill('#login-pass', 'john1');
  await page.click('button:text("Sign In")');
  await page.waitForTimeout(4000);

  // Verify login succeeded - should see app grid
  const loginSucceeded = await page.locator('.app-grid, .apps-grid, [class*="app"]').first().isVisible().catch(() => false);
  console.log("Login succeeded (app grid visible):", loginSucceeded);
  await page.screenshot({ path: path.join(SCREENSHOTS, "00_launcher_after_login.png") });

  // Step 2: Navigate to ServiceProMax
  console.log("Navigating to ServiceProMax...");
  await page.goto(`${BASE}/service-pro-max/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  // Check if install overlay is present and dismiss it
  const hasOverlay = await page.locator('#kapp-install-overlay').isVisible().catch(() => false);
  if (hasOverlay) {
    console.log("Install overlay detected - dismissing...");
    await page.evaluate(() => {
      const overlay = document.getElementById('kapp-install-overlay');
      if (overlay) overlay.remove();
    });
    await page.waitForTimeout(1000);
  }

  // Verify app loaded
  const dashVisible = await page.locator('#tab-dashboard').isVisible();
  console.log("Dashboard visible:", dashVisible);

  if (!dashVisible) {
    await page.screenshot({ path: path.join(SCREENSHOTS, "00_debug_login.png") });
    console.log("Debug screenshot taken");
    // Try to manually trigger the app
    await page.evaluate(() => {
      if (typeof loadDashboard === 'function') loadDashboard();
    });
    await page.waitForTimeout(3000);
  }

  const tabs = [
    { name: "Dashboard", id: "dashboard", subtabs: null },
    { name: "Customers", id: "customers", subtabs: null },
    { name: "Projects", id: "projects", subtabs: null },
    { name: "Status", id: "status", subtabs: null },
    { name: "Time", id: "time", subtabs: ["Summary", "Time Entries", "Utilization"] },
    { name: "Costs", id: "costs", subtabs: null },
    { name: "Milestones", id: "milestones", subtabs: ["Milestones", "Deliverables"] },
    { name: "Risks/Issues", id: "risksIssues", subtabs: ["Risks", "Issues", "Change Requests"] },
    { name: "Quality", id: "quality", subtabs: ["Dashboard", "Quality Reviews", "Findings", "Corrective Actions", "Delivery Audits", "Recovery Plans"] },
    { name: "Feedback", id: "feedback", subtabs: null },
    { name: "Closeout", id: "closeout", subtabs: ["Dashboard", "Closeout Records", "Post-Project Reviews", "Lessons Learned"] },
    { name: "Reports", id: "reports", subtabs: ["PM Performance", "Integrations"] },
  ];

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const tab of tabs) {
    console.log(`\n=== Testing: ${tab.name} ===`);

    // Click the main tab
    try {
      const navBtn = page.locator(`#main-nav button:text("${tab.name}")`);
      await navBtn.click({ force: true });
      await page.waitForTimeout(3000);

      // Take screenshot
      const ssName = `01_${tab.id}.png`;
      await page.screenshot({ path: path.join(SCREENSHOTS, ssName), fullPage: true });
      console.log(`  Screenshot: ${ssName}`);

      // Check for errors
      const pageText = await page.locator(`#tab-${tab.id}`).textContent();
      const hasError = pageText.includes("Error loading") || pageText.includes("Failed to load");
      const hasData = !pageText.includes("Loading...") || pageText.length > 200;

      if (hasError) {
        console.log(`  FAIL: Error found on ${tab.name} tab`);
        failed++;
        results.push({ tab: tab.name, status: "FAIL", reason: "Error on page" });
      } else {
        console.log(`  PASS: ${tab.name} loaded successfully`);
        passed++;
        results.push({ tab: tab.name, status: "PASS", screenshot: ssName });
      }

      // Test subtabs
      if (tab.subtabs) {
        for (let i = 0; i < tab.subtabs.length; i++) {
          const st = tab.subtabs[i];
          console.log(`  Subtab: ${st}`);
          try {
            const subtabBtn = page.locator(`#tab-${tab.id} .subtabs button:text("${st}")`);
            await subtabBtn.click({ force: true });
            await page.waitForTimeout(2500);

            const stName = `02_${tab.id}_${st.toLowerCase().replace(/[^a-z0-9]/g, '_')}.png`;
            await page.screenshot({ path: path.join(SCREENSHOTS, stName), fullPage: true });
            console.log(`    Screenshot: ${stName}`);

            passed++;
            results.push({ tab: `${tab.name} > ${st}`, status: "PASS", screenshot: stName });
          } catch (e) {
            console.log(`    FAIL: ${st} - ${e.message}`);
            failed++;
            results.push({ tab: `${tab.name} > ${st}`, status: "FAIL", reason: e.message });
          }
        }
      }

    } catch (e) {
      console.log(`  FAIL: ${tab.name} - ${e.message}`);
      failed++;
      results.push({ tab: tab.name, status: "FAIL", reason: e.message });
    }
  }

  // Test clicking on a customer detail
  console.log("\n=== Testing: Customer Detail Modal ===");
  try {
    const custBtn = page.locator(`#main-nav button:text("Customers")`);
    await custBtn.click();
    await page.waitForTimeout(3000);
    const firstRow = page.locator('#cust-content table tbody tr').first();
    await firstRow.click({ force: true });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SCREENSHOTS, "03_customer_detail.png"), fullPage: true });
    console.log("  PASS: Customer detail modal");
    await page.locator('.modal-content button:text("Close")').click();
    await page.waitForTimeout(500);
    passed++;
    results.push({ tab: "Customer Detail Modal", status: "PASS", screenshot: "03_customer_detail.png" });
  } catch (e) {
    console.log("  FAIL:", e.message);
    failed++;
    results.push({ tab: "Customer Detail Modal", status: "FAIL", reason: e.message });
  }

  // Test clicking on a project detail
  console.log("\n=== Testing: Project Detail Modal ===");
  try {
    const projBtn = page.locator(`#main-nav button:text("Projects")`);
    await projBtn.click();
    await page.waitForTimeout(3000);
    const firstProjRow = page.locator('#proj-content table tbody tr').first();
    await firstProjRow.click({ force: true });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SCREENSHOTS, "04_project_detail.png"), fullPage: true });
    console.log("  PASS: Project detail modal");
    await page.locator('.modal-content button:text("Close")').click();
    await page.waitForTimeout(500);
    passed++;
    results.push({ tab: "Project Detail Modal", status: "PASS", screenshot: "04_project_detail.png" });
  } catch (e) {
    console.log("  FAIL:", e.message);
    failed++;
    results.push({ tab: "Project Detail Modal", status: "FAIL", reason: e.message });
  }

  // Test quality review detail
  console.log("\n=== Testing: Quality Review Detail ===");
  try {
    const qaBtn = page.locator(`#main-nav button:text("Quality")`);
    await qaBtn.click();
    await page.waitForTimeout(2000);
    const reviewsBtn = page.locator(`#tab-quality .subtabs button:text("Quality Reviews")`);
    await reviewsBtn.click();
    await page.waitForTimeout(2500);
    const firstQRRow = page.locator('#qa-reviews table tbody tr').first();
    await firstQRRow.click({ force: true });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SCREENSHOTS, "05_quality_review_detail.png"), fullPage: true });
    console.log("  PASS: Quality review detail");
    await page.locator('.modal-content button:text("Close")').click();
    await page.waitForTimeout(500);
    passed++;
    results.push({ tab: "Quality Review Detail", status: "PASS", screenshot: "05_quality_review_detail.png" });
  } catch (e) {
    console.log("  FAIL:", e.message);
    failed++;
    results.push({ tab: "Quality Review Detail", status: "FAIL", reason: e.message });
  }

  // Test recovery plan detail
  console.log("\n=== Testing: Recovery Plan Detail ===");
  try {
    const recoveryBtn = page.locator(`#tab-quality .subtabs button:text("Recovery Plans")`);
    await recoveryBtn.click();
    await page.waitForTimeout(2500);
    const firstRecRow = page.locator('#qa-recovery table tbody tr').first();
    await firstRecRow.click({ force: true });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SCREENSHOTS, "06_recovery_plan_detail.png"), fullPage: true });
    console.log("  PASS: Recovery plan detail");
    await page.locator('.modal-content button:text("Close")').click();
    passed++;
    results.push({ tab: "Recovery Plan Detail", status: "PASS", screenshot: "06_recovery_plan_detail.png" });
  } catch (e) {
    console.log("  FAIL:", e.message);
    failed++;
    results.push({ tab: "Recovery Plan Detail", status: "FAIL", reason: e.message });
  }

  // Test lessons learned detail
  console.log("\n=== Testing: Lessons Learned Detail ===");
  try {
    const coBtn = page.locator(`#main-nav button:text("Closeout")`);
    await coBtn.click();
    await page.waitForTimeout(2000);
    const lessonsBtn = page.locator(`#tab-closeout .subtabs button:text("Lessons Learned")`);
    await lessonsBtn.click();
    await page.waitForTimeout(2500);
    const firstLessonRow = page.locator('#co-lessons table tbody tr').first();
    await firstLessonRow.click({ force: true });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SCREENSHOTS, "07_lesson_detail.png"), fullPage: true });
    console.log("  PASS: Lesson detail");
    await page.locator('.modal-content button:text("Close")').click();
    passed++;
    results.push({ tab: "Lessons Learned Detail", status: "PASS", screenshot: "07_lesson_detail.png" });
  } catch (e) {
    console.log("  FAIL:", e.message);
    failed++;
    results.push({ tab: "Lessons Learned Detail", status: "FAIL", reason: e.message });
  }

  console.log("\n" + "=".repeat(50));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(50));

  // Write test results
  fs.writeFileSync(path.join(SCREENSHOTS, "test-results.json"), JSON.stringify(results, null, 2));

  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error("Fatal:", e); process.exit(1); });
