import { createReport } from './report-style.mjs';
import fs from 'node:fs';

const d = JSON.parse(fs.readFileSync('/tmp/cpq/report-data.json', 'utf-8'));
const k = d.kpis, w = d.waterfall, c = d.cash;
const M = (x) => '$' + (Math.round(x / 1e5) / 10).toLocaleString('en-US') + 'M';
const OUT = process.argv[2] || '/Users/jdsundberg/dev/claude/reports/Ironline-CPQ-Documentation.pdf';

const { doc, style, colors } = createReport('Ironline CPQ — System Documentation', OUT, {
  author: 'John Sundberg', subject: 'Configure-Price-Quote platform on Kinetic'
});

style.cover({
  title: 'Ironline CPQ\nSystem Documentation',
  subtitle: 'Configure · Price · Quote on Kinetic',
  lines: ['June 18, 2026', 'Author: John Sundberg', 'Server: ai-labs.kinopsdev.io  ·  Kapp: cpq', `${d.counts.quotes} quotes · ${d.counts.orders} orders · ${d.counts.invoices} invoices`]
});

// ── Executive summary ───────────────────────────────────────────────
style.heading('1 · Executive Summary');
style.body('Ironline CPQ turns the configure-price-quote lifecycle of an industrial-equipment manufacturer into a fully instrumented quote-to-cash system on the Kinetic Platform. Sales reps configure multi-line quotes from a catalog of conveyor systems, pumps, control panels, robotic cells and safety systems; pricing rules apply volume and segment discounts; deals that breach a discount or margin threshold are routed for approval; won quotes convert into orders, invoices and payments.');
style.body('The application is deliberately designed around one question: where does money move, and where does it get stuck? Every dashboard traces value from list price to collected cash and flags the four blockages that strangle quote-to-cash — stalled deals, approval bottlenecks, unconverted wins and aging receivables.');
style.gap(0.3);
style.statBoxes([
  { label: 'Open Pipeline', value: M(k.openValue) },
  { label: 'Won (booked)', value: M(k.wonValue) },
  { label: 'Win Rate', value: k.winRate + '%' },
  { label: 'Avg Margin', value: k.avgMargin + '%' },
  { label: 'Outstanding AR', value: M(k.outstanding) },
]);
style.callout(`Live blockage signal: ${k.totalStalled} quotes stalled 30+ days, ${k.breached} approvals past SLA, ${k.unconvertedWins} won deals (${M(k.unconvertedValue)}) never converted to orders, and ${M(k.outstanding)} in receivables still uncollected.`, colors.red);

// ── Architecture ────────────────────────────────────────────────────
style.sectionBreak();
style.heading('2 · Architecture & Data Model');
style.body('The system is a single Kinetic kapp ("cpq") with ten linked forms. A thin Node service performs read-only aggregation for the dashboards; all business PROCESSES (pricing approval, conversion, invoicing) run as Kinetic workflow task trees on the platform itself — not in the web tier. This keeps the automation portable, auditable in the run log, and independent of the UI.');
style.subheading('The ten forms');
style.table(['Form', 'Role in the money flow'], [150, 350], [
  ['products', 'Catalog: list price, unit cost, lead time, configurable flag'],
  ['options', 'Configurable add-ons with price & cost deltas'],
  ['price-rules', 'Volume tiers, segment discounts, margin floors, approval thresholds'],
  ['customers', 'Accounts — segment, region, credit terms'],
  ['quotes', 'Quote headers moving through the pipeline (the spine)'],
  ['quote-lines', 'Line items — qty, options, discount, per-line margin'],
  ['approvals', 'Discount / margin-floor approval requests with SLA'],
  ['orders', 'Won quotes converted to production orders'],
  ['invoices', 'Billing against orders — the cash-conversion stage'],
  ['payments', 'Receipts against invoices — closes the loop'],
]);
style.callout('Design rule: processes are task trees, not web-server code. The Node service only reads and aggregates; it never mutates business state.', colors.blue);

// ── The four money-flow visuals ─────────────────────────────────────
style.sectionBreak();
style.heading('3 · The Four Money-Flow Visuals');
style.body('The dashboard is built around four views, each pairing a flow with the blockage that interrupts it.');

style.subheading('3.1  Pipeline Funnel — where deals stall');
style.body('Open quotes by stage, bar width proportional to net value, with the portion that has not moved in 30+ days striped in red. It answers: how much value sits in each stage, and how much is rotting?');
const pmax = Math.max(...d.pipeline.map(p => p.value), 1) / 1e6;
d.pipeline.forEach(p => style.barRow(p.stage, Math.round(p.value / 1e5) / 10, pmax, { suffix: 'M', color: p.stalled > 0 ? colors.orange : colors.blue }));
style.body(`${k.totalStalled} open quotes are currently stalled 30+ days in stage — the single largest source of slipped pipeline.`);

style.subheading('3.2  Approval Bottleneck — who is the blocker');
style.body(`Pricing approvals are the most common pipeline blockage. ${k.pending} approvals are pending (${M(k.pendingValue)} of value held), and ${k.breached} are already past their SLA. The board breaks the queue down by approver so the bottleneck has a name.`);
const amax = Math.max(...d.byApprover.map(a => a.value), 1) / 1e6;
d.byApprover.forEach(a => style.barRow(`${a.name} (${a.count}, ${a.breached} late)`, Math.round(a.value / 1e5) / 10, amax, { suffix: 'M', color: a.breached > 0 ? colors.red : colors.blue }));

style.sectionBreak();
style.subheading('3.3  Revenue → Margin Waterfall — where value leaks');
style.body('On won deals, list value is eroded first by discounts, then by cost of goods, leaving gross margin. The waterfall makes the leakage explicit.');
style.table(['Stage', 'Amount', 'Note'], [150, 150, 200], [
  ['List value', M(w.list), 'sum of catalog list prices on won deals'],
  ['– Discounts', '-' + M(w.discount), `${w.discountPct}% of list given away`],
  ['= Net booked', M(w.net), 'contracted revenue'],
  ['– Cost of goods', '-' + M(w.cost), 'unit cost + option cost'],
  ['= Gross margin', M(w.margin), `${w.marginPct}% margin retained`],
]);
style.callout(`Every point of discount on ${M(w.list)} of list value is real money: discounts already cost ${M(w.discount)} on closed business this period.`, colors.orange);

style.subheading('3.4  Cash Conversion — won money that is not yet cash');
style.body('The final flow follows booked revenue all the way to the bank: Won → Ordered → Invoiced → Collected, with the leak at each step called out.');
const cmax = c.won / 1e6;
[['Won (booked)', c.won], ['Ordered', c.ordered], ['Invoiced', c.invoiced], ['Collected', c.collected]].forEach(([l, v]) =>
  style.barRow(l, Math.round(v / 1e5) / 10, cmax, { suffix: 'M', color: colors.green }));
style.body(`Leak points: ${M(k.unconvertedValue)} of won deals never became orders; ${M(c.ordered - c.invoiced)} is ordered but not yet invoiced; ${M(c.outstanding)} is invoiced but uncollected (${c.overdue} invoices overdue).`);
style.subheading3('Accounts-receivable aging');
const ar = d.arAging; const armax = Math.max(...Object.values(ar), 1) / 1e6;
Object.entries(ar).forEach(([b, v]) => v > 0 && style.barRow(b, Math.round(v / 1e5) / 10, armax, { suffix: 'M', color: b === '90+' || b === '61-90' ? colors.red : colors.orange }));

// ── Workflow automation ─────────────────────────────────────────────
style.sectionBreak();
style.heading('4 · Workflow Automation (Kinetic Task Trees)');
style.body('Four event-triggered task trees automate the quote-to-cash process on the platform. Each calls the Core API through the kinetic_core_api_connection_v1 handler; none of this logic lives in the web server. Together they form a self-driving pipeline: submit a quote and it routes, approves, converts and invoices itself.');

style.subheading('4.1  Quote Approval Routing');
style.body('Trigger: a quote is submitted (quotes / Submission Submitted). If discount > 15% or margin < 22%, the tree creates an approval request — choosing approver by deal size, type by which threshold broke, priority by discount depth, and an SLA due date three days out — then flags the quote "Pending Approval". Otherwise it marks the quote auto-approved.');
style.codeBlock('Start\n ├─[discount>15% OR margin<22%]→ Create Approval → Flag Quote "Pending Approval"\n └─[else]──────────────────────→ Mark "Not Required"');

style.subheading('4.2  Approval Decision Sync');
style.body('Trigger: an approval is updated (approvals / Submission Updated). The tree finds the parent quote by quote number and writes the decision back — "Approved" pushes the quote to Approved; "Rejected" returns it to Negotiation.');

style.subheading('4.3  Won to Order Conversion');
style.body('Trigger: a quote is updated to Status = Won with no order yet (quotes / Submission Updated). The tree creates a production order (SO-####) carrying the quote totals and cost, then links the order number back onto the quote — eliminating the "unconverted win" blockage automatically.');

style.subheading('4.4  Order Invoice Generation');
style.body('Trigger: an order is marked Shipped or Delivered (orders / Submission Updated). The tree raises an invoice for the order total with Net-30 terms and a due date, then records the invoiced amount on the order — starting the receivables clock.');
style.callout('All four trees were validated against the rule gate (node-id convention, lastID, installed handlers, server-root-relative paths) and verified end-to-end with live runs on ai-labs.', colors.green);

// ── Install & usage ─────────────────────────────────────────────────
style.sectionBreak();
style.heading('5 · Install & Usage');
style.subheading('Provision the app');
style.codeBlock('node apps/cpq/gen-seed.mjs                 # regenerate deterministic seed\nnode apps/cpq/install.mjs https://ai-labs.kinopsdev.io john <pass> --seed');
style.body('install.mjs creates the kapp, the ten forms, all search indexes (and waits for the builds), then loads the seed data. The app is auto-discovered by the base launcher on port 3011 and served at /cpq/.');
style.subheading('Deploy the workflow trees');
style.codeBlock('node apps/cpq/workflows/gen-trees.mjs       # emit treeXml + treeJson\nnode apps/cpq/workflows/put-trees.mjs        # validate + persist via Task API');
style.subheading('Using the system');
style.bullet('Money Flow tab — the four visuals above, live.');
style.bullet('Pipeline / Approvals / Cash tabs — drill into each blockage.');
style.bullet('Quotes — click any quote for a 360 (lines, price build-up, approvals, fulfillment).');
style.bullet('Create a quote that breaks a threshold and watch the approval appear automatically.');
style.bullet('All tables are fully editable (row-click edit + Add New); edits fire the workflow trees.');

style.gap(0.5);
style.callout('Built and verified June 18, 2026 on ai-labs.kinopsdev.io. Dashboards render live data; all four automation trees confirmed firing on real submissions.', colors.blue);

await style.finalize();
console.log('PDF written to', OUT);
