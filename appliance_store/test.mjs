import { chromium } from 'playwright';

const BASE = 'http://localhost:3011';
const KINETIC_URL = 'https://first.kinetics.com';
const APP_URL = `${BASE}/appliance-store/`;
const USER = 'john';
const PASS = 'john1';

let page, browser, issues = [];

function log(msg) { console.log(`  ${msg}`); }
function pass(msg) { console.log(`  \u2705 ${msg}`); }
function fail(msg) { issues.push(msg); console.log(`  \u274c ${msg}`); }

async function setup() {
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await ctx.newPage();
}

async function login() {
  console.log('\n--- LOGIN ---');
  // First login through the launcher to establish session
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Check if already logged in
  const hasSession = await page.evaluate(() => !!localStorage.getItem('base_session'));
  if (!hasSession) {
    // Need to login via launcher
    const loginUrl = await page.$('#login-url');
    if (loginUrl) {
      await page.fill('#login-url', KINETIC_URL);
      await page.fill('#login-user', USER);
      await page.fill('#login-pass', PASS);
      await page.click('button:has-text("Sign In")');
      await page.waitForTimeout(3000);
      pass('Logged in via launcher');
    } else {
      fail('Cannot find login form');
      return;
    }
  } else {
    pass('Session exists in localStorage');
  }

  // Now navigate to the appliance store app
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Check the app loaded
  const appVisible = await page.$eval('#app', el => el.style.display !== 'none').catch(() => false);
  if (appVisible) pass('Appliance Store app loaded');
  else {
    // May need to login in the app itself
    const loginVisible = await page.$('#login-screen');
    if (loginVisible) {
      await page.fill('#login-url', KINETIC_URL);
      await page.fill('#login-user', USER);
      await page.fill('#login-pass', PASS);
      await page.click('.login-box button');
      await page.waitForTimeout(2000);
      pass('Logged in via app login');
    } else {
      fail('App did not load');
    }
  }
}

async function testDashboard() {
  console.log('\n--- DASHBOARD ---');
  // Debug: log what's on the page
  const title = await page.title();
  log(`Page title: ${title}`);
  const url = page.url();
  log(`Current URL: ${url}`);
  const navButtons = await page.$$eval('nav button', els => els.map(e => e.textContent));
  log(`Nav buttons found: ${JSON.stringify(navButtons)}`);
  const topbarText = await page.$eval('.topbar', el => el.textContent).catch(() => 'no topbar');
  log(`Topbar text: ${topbarText.substring(0, 100)}`);

  if (navButtons.length === 0) {
    // Maybe the page loaded to launcher instead
    const bodyText = await page.$eval('body', el => el.textContent.substring(0, 200));
    log(`Body text: ${bodyText}`);
    fail('No nav buttons found - may not be on the app page');
    return;
  }

  await page.click('nav button:has-text("Dashboard")');
  await page.waitForTimeout(2000);

  // Check KPIs rendered
  const kpis = await page.$$('#dash-kpis .kpi');
  if (kpis.length >= 4) pass(`${kpis.length} KPI cards rendered`);
  else fail(`Expected 4+ KPIs, got ${kpis.length}`);

  // Check KPI values are not zero/empty
  const kpiVals = await page.$$eval('#dash-kpis .kpi .val', els => els.map(e => e.textContent));
  const allZero = kpiVals.every(v => v === '0' || v === '$0.00');
  if (allZero) fail('All KPI values are zero');
  else pass(`KPI values: ${kpiVals.join(', ')}`);

  // Check for error text
  const errorText = await page.$('#dash-kpis p[style*="red"]');
  if (errorText) {
    const msg = await errorText.textContent();
    fail(`Dashboard error: ${msg}`);
  } else pass('No dashboard errors');

  // Check recent orders table
  const ordRows = await page.$$('#dash-orders tr');
  log(`Recent orders: ${ordRows.length} rows`);

  // Check open tickets table
  const svcRows = await page.$$('#dash-tickets tr');
  log(`Open tickets: ${svcRows.length} rows`);
}

async function testInventory() {
  console.log('\n--- INVENTORY ---');
  await page.click('nav button:has-text("Inventory")');
  await page.waitForTimeout(2000);

  // Check table rows
  const rows = await page.$$('#inv-body tr');
  if (rows.length > 0) pass(`${rows.length} product rows loaded`);
  else fail('No product rows');

  // Check for 400 errors
  const errorCell = await page.$('#inv-body td[style*="red"]');
  if (errorCell) fail('Inventory table has error: ' + await errorCell.textContent());

  // Test category filter
  await page.selectOption('#inv-cat', 'Refrigerators');
  await page.waitForTimeout(1500);
  const filteredRows = await page.$$('#inv-body tr.clickable-row');
  log(`Filtered by Refrigerators: ${filteredRows.length} rows`);
  if (filteredRows.length > 0) {
    const cats = await page.$$eval('#inv-body tr.clickable-row .badge', els => els.map(e => e.textContent));
    const allRefrig = cats.some(c => c === 'Refrigerators');
    if (allRefrig) pass('Category filter works');
    else fail('Category filter returned wrong results');
  }
  await page.selectOption('#inv-cat', '');
  await page.waitForTimeout(1000);

  // Test status filter
  await page.selectOption('#inv-status', 'Low Stock');
  await page.waitForTimeout(1500);
  const lowRows = await page.$$('#inv-body tr.clickable-row');
  log(`Filtered by Low Stock: ${lowRows.length} rows`);
  await page.selectOption('#inv-status', '');
  await page.waitForTimeout(1000);

  // Test search
  await page.fill('#inv-search', 'Samsung');
  await page.waitForTimeout(1000);
  const searchRows = await page.$$('#inv-body tr.clickable-row');
  log(`Search "Samsung": ${searchRows.length} rows`);
  await page.fill('#inv-search', '');
  await page.waitForTimeout(500);

  // Test add product modal
  await page.click('button:has-text("+ Add Product")');
  await page.waitForTimeout(500);
  const modal = await page.$('#modal.show');
  if (modal) pass('Add Product modal opens');
  else fail('Add Product modal did not open');

  // Fill and create
  await page.fill('#m-sku', 'TEST-001');
  await page.fill('#m-pname', 'Test Toaster Oven');
  await page.selectOption('#m-pcat', 'Microwaves');
  await page.fill('#m-brand', 'TestBrand');
  await page.fill('#m-price', '99.99');
  await page.fill('#m-qty', '5');
  await page.click('button:has-text("Create")');
  await page.waitForTimeout(2000);

  // Verify toast
  const toastVisible = await page.$('#toast.show');
  if (toastVisible) pass('Toast notification shown');
  else log('Toast may have already dismissed');

  // Verify product appears
  const afterRows = await page.$$('#inv-body tr.clickable-row');
  log(`After create: ${afterRows.length} rows`);

  // Click to edit
  const testRow = await page.$('#inv-body tr.clickable-row:has-text("Test Toaster Oven")');
  if (testRow) {
    await testRow.click();
    await page.waitForTimeout(1000);
    const editModal = await page.$('#modal.show');
    if (editModal) {
      pass('Edit modal opens on row click');
      // Delete the test product
      await page.click('button:has-text("Delete")');
      // Accept confirm dialog
      page.once('dialog', d => d.accept());
      await page.click('button:has-text("Delete")');
      await page.waitForTimeout(1500);
      pass('Test product deleted');
    } else fail('Edit modal did not open');
  } else log('Test product not found in current page (may be on another page)');
}

async function testOrders() {
  console.log('\n--- ORDERS ---');
  await page.click('nav button:has-text("Orders")');
  await page.waitForTimeout(2000);

  const rows = await page.$$('#ord-body tr.clickable-row');
  if (rows.length > 0) pass(`${rows.length} order rows loaded`);
  else fail('No order rows');

  // Check for errors
  const errorCell = await page.$('#ord-body td[style*="red"]');
  if (errorCell) fail('Orders table has error: ' + await errorCell.textContent());

  // Test status filter
  await page.selectOption('#ord-status', 'Delivered');
  await page.waitForTimeout(1500);
  const deliveredRows = await page.$$('#ord-body tr.clickable-row');
  log(`Filtered by Delivered: ${deliveredRows.length} rows`);
  await page.selectOption('#ord-status', '');
  await page.waitForTimeout(1000);

  // Test create order
  await page.click('button:has-text("+ New Order")');
  await page.waitForTimeout(500);
  const modal = await page.$('#modal.show');
  if (modal) pass('New Order modal opens');
  else fail('New Order modal did not open');

  await page.fill('#m-cname', 'Test Customer');
  await page.fill('#m-cemail', 'test@example.com');
  await page.fill('#m-oprod', 'Test Product');
  await page.fill('#m-oprice', '500');
  await page.fill('#m-ototal', '500');
  await page.click('button:has-text("Create")');
  await page.waitForTimeout(2000);

  const afterRows = await page.$$('#ord-body tr.clickable-row');
  log(`After create: ${afterRows.length} rows`);

  // Clean up - find and delete test order
  const testRow = await page.$('#ord-body tr.clickable-row:has-text("Test Customer")');
  if (testRow) {
    await testRow.click();
    await page.waitForTimeout(1000);
    page.once('dialog', d => d.accept());
    await page.click('button:has-text("Delete")');
    await page.waitForTimeout(1500);
    pass('Test order cleaned up');
  }
}

async function testSchedules() {
  console.log('\n--- SCHEDULES ---');
  await page.click('nav button:has-text("Schedules")');
  await page.waitForTimeout(2000);

  // Check for errors
  const errorCell = await page.$('#sched-body td[style*="red"]');
  if (errorCell) {
    const msg = await errorCell.textContent();
    fail(`Schedule error: ${msg}`);
  } else pass('No schedule errors (All Departments)');

  // Check table has content
  const rows = await page.$$('#sched-body tr');
  log(`Schedule rows: ${rows.length}`);

  // Test department filter
  await page.selectOption('#sched-dept', 'Sales Floor');
  await page.waitForTimeout(2000);
  const errorAfterDept = await page.$('#sched-body td[style*="red"]');
  if (errorAfterDept) {
    const msg = await errorAfterDept.textContent();
    fail(`Department filter error: ${msg}`);
  } else {
    const deptRows = await page.$$('#sched-body tr');
    pass(`Department filter works: ${deptRows.length} rows`);
  }

  // Test each department
  for (const dept of ['Delivery', 'Service', 'Management']) {
    await page.selectOption('#sched-dept', dept);
    await page.waitForTimeout(1500);
    const err = await page.$('#sched-body td[style*="red"]');
    if (err) fail(`${dept} filter error`);
    else pass(`${dept} filter OK`);
  }

  await page.selectOption('#sched-dept', '');
  await page.waitForTimeout(1000);

  // Test week navigation
  await page.click('button:has-text("Next Week")');
  await page.waitForTimeout(1500);
  pass('Next week navigation clicked');

  await page.click('button:has-text("Prev Week")');
  await page.waitForTimeout(1500);
  pass('Prev week navigation clicked');

  // Test add shift modal
  await page.click('button:has-text("+ Add Shift")');
  await page.waitForTimeout(500);
  const modal = await page.$('#modal.show');
  if (modal) {
    pass('Add Shift modal opens');
    await page.click('button:has-text("Cancel")');
    await page.waitForTimeout(300);
  } else fail('Add Shift modal did not open');
}

async function testService() {
  console.log('\n--- SERVICE TICKETS ---');
  await page.click('nav button:has-text("Service")');
  await page.waitForTimeout(2000);

  const rows = await page.$$('#svc-body tr.clickable-row');
  if (rows.length > 0) pass(`${rows.length} ticket rows loaded`);
  else fail('No ticket rows');

  // Check for errors
  const errorCell = await page.$('#svc-body td[style*="red"]');
  if (errorCell) fail('Service table has error: ' + await errorCell.textContent());

  // Test status filter
  await page.selectOption('#svc-status', 'Open');
  await page.waitForTimeout(1500);
  const openRows = await page.$$('#svc-body tr.clickable-row');
  log(`Filtered by Open: ${openRows.length} rows`);
  await page.selectOption('#svc-status', '');
  await page.waitForTimeout(1000);

  // Test priority filter
  await page.selectOption('#svc-priority', 'High');
  await page.waitForTimeout(1500);
  const highRows = await page.$$('#svc-body tr.clickable-row');
  log(`Filtered by High priority: ${highRows.length} rows`);
  await page.selectOption('#svc-priority', '');
  await page.waitForTimeout(1000);

  // Test create ticket
  await page.click('button:has-text("+ New Ticket")');
  await page.waitForTimeout(500);
  const modal = await page.$('#modal.show');
  if (modal) pass('New Ticket modal opens');
  else fail('New Ticket modal did not open');

  await page.fill('#m-tcust', 'Test Ticket Customer');
  await page.fill('#m-tphone', '555-0000');
  await page.fill('#m-tappl', 'Refrigerator');
  await page.fill('#m-tbrand', 'TestBrand');
  await page.fill('#m-tissue', 'Unit not cooling');
  await page.click('button:has-text("Create")');
  await page.waitForTimeout(2000);

  // Clean up
  const testRow = await page.$('#svc-body tr.clickable-row:has-text("Test Ticket Customer")');
  if (testRow) {
    await testRow.click();
    await page.waitForTimeout(1000);
    page.once('dialog', d => d.accept());
    await page.click('button:has-text("Delete")');
    await page.waitForTimeout(1500);
    pass('Test ticket cleaned up');
  }

  // Click existing ticket to view detail
  const existingRow = await page.$('#svc-body tr.clickable-row');
  if (existingRow) {
    await existingRow.click();
    await page.waitForTimeout(1000);
    const editModal = await page.$('#modal.show');
    if (editModal) {
      pass('Ticket detail modal opens on row click');
      // Check fields populated
      const custVal = await page.$eval('#m-tcust', el => el.value);
      if (custVal) pass(`Ticket detail shows customer: ${custVal}`);
      else fail('Ticket detail customer field empty');
      await page.click('button:has-text("Cancel")');
    } else fail('Ticket detail modal did not open');
  }
}

async function testConsoleErrors() {
  console.log('\n--- JS CONSOLE ERRORS ---');
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  // Navigate through all tabs to trigger any JS errors
  for (const tab of ['Dashboard', 'Inventory', 'Orders', 'Schedules', 'Service']) {
    await page.click(`nav button:has-text("${tab}")`);
    await page.waitForTimeout(1500);
  }

  if (errors.length === 0) pass('No JS console errors');
  else {
    errors.forEach(e => fail(`JS Error: ${e}`));
  }
}

async function run() {
  console.log('=== Appliance Store Playwright Test ===');
  await setup();
  try {
    await login();
    await testDashboard();
    await testInventory();
    await testOrders();
    await testSchedules();
    await testService();
    await testConsoleErrors();
  } catch(e) {
    fail(`Unhandled error: ${e.message}`);
  } finally {
    await browser.close();
  }

  console.log('\n=== SUMMARY ===');
  if (issues.length === 0) {
    console.log('\u2705 All tests passed!');
  } else {
    console.log(`\u274c ${issues.length} issue(s) found:`);
    issues.forEach((issue, i) => console.log(`  ${i+1}. ${issue}`));
  }
  process.exit(issues.length > 0 ? 1 : 0);
}

run();
