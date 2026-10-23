/**
 * BillysBoatWorks — data model definition.
 * Emits app.json. Fields are declared compactly here; `filters` lists the fields each
 * console can AND together in a query, and every combination of those becomes a compound
 * index (Kinetic matches an index whose parts are exactly the queried field set).
 * Usage: node build-app-json.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dir = path.dirname(fileURLToPath(import.meta.url));

// f = plain field, F = required, T = textarea
const f = (name) => ({ name });
const F = (name) => ({ name, required: true });
const T = (name) => ({ name, rows: 3 });

const FORMS = [
  { slug: "destinations", name: "Destinations", label: "${values('Destination Name')}, ${values('State')}",
    desc: "Recreation destinations — lakes, river systems and tourism areas a franchise can serve",
    fields: [F("Destination ID"), F("Destination Name"), f("State"), f("Region"), f("Destination Type"),
      f("Nearest City"), f("Surface Acres"), f("Season Start"), f("Season End"), f("Locations Count"),
      f("Popularity Score"), f("Hero Image"), f("Status"), T("Description")],
    filters: ["State", "Region", "Destination Type", "Status"], extra: ["Destination Name"] },

  { slug: "territories", name: "Territories", label: "${values('Territory Name')} (${values('Status')})",
    desc: "Franchise territories — the geographic rights sold to an operator",
    fields: [F("Territory ID"), F("Territory Name"), f("Territory Type"), f("State"), f("County"),
      f("Destination"), f("Population"), f("Households"), f("Boat Registrations"), f("Tourism Index"),
      f("Opportunity Score"), f("Franchise"), f("Reserved For"), f("Status"), T("Notes")],
    filters: ["State", "Territory Type", "Status"], extra: ["Territory Name", "Destination", "Franchise"] },

  { slug: "franchises", name: "Franchises", label: "${values('Franchise Name')}",
    desc: "Franchise operators in the BillysBoatWorks network",
    fields: [F("Franchise ID"), F("Franchise Name"), f("Owner Name"), f("Owner Email"), f("Owner Phone"),
      f("Territory"), f("State"), f("Region"), f("Opened Date"), f("Agreement Date"), f("Franchise Fee"),
      f("Royalty Rate"), f("Marketing Fee Rate"), f("Platform Fee"), f("Locations Count"), f("Fleet Size"),
      f("Employees Count"), f("Tier"), f("Compliance Score"), f("Status"), T("Notes")],
    filters: ["State", "Region", "Status", "Tier"], extra: ["Franchise Name", "Territory"] },

  { slug: "franchise-prospects", name: "Franchise Prospects", label: "${values('Prospect Name')} - ${values('Stage')}",
    desc: "Franchise sales pipeline from first inquiry through awarded agreement",
    fields: [F("Prospect ID"), F("Prospect Name"), f("Email"), f("Phone"), f("City"), f("State"),
      f("Desired Territory"), f("Desired Destination"), f("Stage"), f("Source"), f("Liquid Capital"),
      f("Net Worth"), f("Qualification Score"), f("Assigned To"), f("Inquiry Date"), f("Application Date"),
      f("FDD Sent Date"), f("Agreement Date"), f("Deposit Paid"), f("Target Open Date"), f("Last Activity"),
      f("Next Step"), f("Status"), T("Notes")],
    filters: ["Stage", "State", "Source", "Status"], extra: ["Prospect Name", "Assigned To"] },

  { slug: "locations", name: "Rental Locations", label: "${values('Location Name')}",
    desc: "Physical rental points — marina, resort dock, campground or launch a franchise operates from",
    fields: [F("Location ID"), F("Location Name"), f("Franchise"), f("Destination"), f("Location Type"),
      f("Address"), f("City"), f("State"), f("ZIP"), f("Latitude"), f("Longitude"), f("Dock Count"),
      f("Hours Open"), f("Hours Close"), f("Season Start"), f("Season End"), f("Manager"), f("Phone"),
      f("Fleet Size"), f("Status"), T("Notes")],
    filters: ["Franchise", "Destination", "State", "Status"], extra: ["Location Name", "Location Type"] },

  { slug: "employees", name: "Employees", label: "${values('Employee Name')} - ${values('Role')}",
    desc: "Franchise staff with the role that drives their permissions",
    fields: [F("Employee ID"), F("Employee Name"), f("Email"), f("Phone"), f("Franchise"), f("Location"),
      f("Role"), f("Hire Date"), f("Certifications"), f("Training Complete"), f("Status"), T("Notes")],
    filters: ["Franchise", "Location", "Role", "Status"], extra: ["Employee Name"] },

  { slug: "equipment-categories", name: "Equipment Categories", label: "${values('Category Name')}",
    desc: "Rentable equipment types — serialized or quantity-tracked, water or land",
    fields: [F("Category ID"), F("Category Name"), f("Equipment Class"), f("Tracking Mode"), f("Capacity"),
      f("Requires License"), f("Requires Briefing"), f("Minimum Age"), f("Hourly Rate"), f("Half Day Rate"),
      f("Full Day Rate"), f("Daily Rate"), f("Weekly Rate"), f("Security Deposit"), f("Cleaning Buffer Minutes"),
      f("Season"), f("Image"), f("Status"), T("Description")],
    filters: ["Equipment Class", "Tracking Mode", "Season", "Status"], extra: ["Category Name"] },

  { slug: "assets", name: "Equipment Assets", label: "${values('Asset Name')} (${values('Asset Tag')})",
    desc: "Individually serialized equipment with full economics and service history",
    fields: [F("Asset ID"), F("Asset Name"), f("Asset Tag"), f("Category"), f("Equipment Class"),
      f("Franchise"), f("Location"), f("Manufacturer"), f("Model"), f("Model Year"), f("Serial Number"),
      f("Registration Number"), f("HIN"), f("Purchase Date"), f("Purchase Price"), f("Current Value"),
      f("Engine Hours"), f("Next Service Hours"), f("Condition"), f("Fuel Level"), f("Last Inspection"),
      f("Lifetime Revenue"), f("Maintenance Cost"), f("Days Rented"), f("Days Available"), f("Photo"),
      f("QR Code"), f("Status"), T("Notes")],
    filters: ["Franchise", "Location", "Category", "Status"], extra: ["Asset Name", "Asset Tag", "Equipment Class", "Condition"] },

  { slug: "inventory", name: "Quantity Inventory", label: "${values('Item Name')} @ ${values('Location')}",
    desc: "Pooled non-serialized stock — life jackets, paddles, coolers, tubes",
    fields: [F("Inventory ID"), F("Item Name"), f("Category"), f("Franchise"), f("Location"),
      f("Quantity Total"), f("Quantity Available"), f("Quantity Out"), f("Quantity Damaged"),
      f("Unit Rate"), f("Security Deposit"), f("Status"), T("Notes")],
    filters: ["Franchise", "Location", "Category", "Status"], extra: ["Item Name"] },

  { slug: "customers", name: "Customers", label: "${values('First Name')} ${values('Last Name')}",
    desc: "Renter profiles — identity status, history and loyalty",
    fields: [F("Customer ID"), F("First Name"), F("Last Name"), f("Email"), f("Phone"), f("City"),
      f("State"), f("ZIP"), f("Emergency Contact"), f("Emergency Phone"), f("ID Verified"),
      f("License Last4"), f("Boater Certification"), f("Loyalty Tier"), f("Rentals Count"),
      f("Lifetime Spend"), f("First Rental"), f("Last Rental"), f("Marketing Opt In"), f("Status"), T("Notes")],
    filters: ["State", "Loyalty Tier", "ID Verified", "Status"], extra: ["Last Name", "Email", "Customer ID"] },

  { slug: "reservations", name: "Reservations", label: "${values('Confirmation Code')} - ${values('Customer Name')}",
    desc: "The booking record driving the entire rental lifecycle",
    fields: [F("Reservation ID"), F("Confirmation Code"), f("Customer"), f("Customer Name"),
      f("Customer Email"), f("Customer Phone"), f("Franchise"), f("Location"), f("Destination"),
      f("Category"), f("Asset"), f("Asset Assignment"), f("Start Date"), f("Start Time"), f("End Date"),
      f("End Time"), f("Duration Type"), f("Duration Hours"), f("Party Size"), f("Base Price"),
      f("Accessories Total"), f("Protection Plan"), f("Protection Fee"), f("Fees"), f("Tax"), f("Total"),
      f("Security Deposit"), f("Balance Due"), f("Source"), f("Waiver Signed"), f("Checked In At"),
      f("Released At"), f("Released By"), f("Returned At"), f("Return Fuel"), f("Late Minutes"),
      f("Exception"), f("Status"), T("Notes")],
    filters: ["Franchise", "Location", "Status", "Category", "Start Date"],
    extra: ["Confirmation Code", "Customer", "Customer Name", "Customer Email", "Asset", "Destination", "Source", "Exception", "Duration Type"],
    pairs: [["Asset", "Start Date"], ["Customer", "Status"], ["Destination", "Start Date"], ["Confirmation Code", "Customer Email"]] },

  { slug: "reservation-items", name: "Reservation Items", label: "${values('Description')} x${values('Quantity')}",
    desc: "Line items making every reservation total traceable",
    fields: [F("Item ID"), F("Reservation"), f("Confirmation Code"), f("Item Type"), f("Category"),
      f("Asset"), f("Description"), f("Quantity"), f("Unit Price"), f("Line Total"), f("Franchise")],
    filters: ["Reservation", "Item Type", "Franchise"], extra: ["Confirmation Code"] },

  { slug: "pricing-rules", name: "Pricing Rules", label: "${values('Rule Name')}",
    desc: "Layered pricing — corporate guidance, franchise overrides, seasonal and demand adjustments",
    fields: [F("Rule ID"), F("Rule Name"), f("Scope"), f("Franchise"), f("Location"), f("Category"),
      f("Duration Type"), f("Day Type"), f("Season"), f("Base Price"), f("Adjustment Type"),
      f("Adjustment Value"), f("Minimum Hours"), f("Advance Days"), f("Priority"), f("Effective Start"),
      f("Effective End"), f("Status"), T("Explanation")],
    filters: ["Scope", "Franchise", "Category", "Season"], extra: ["Rule Name", "Day Type", "Status"] },

  { slug: "payments", name: "Payments", label: "${values('Payment Type')} ${values('Amount')} - ${values('Confirmation Code')}",
    desc: "Provider-agnostic money movement with franchise and corporate allocation",
    fields: [F("Payment ID"), f("Reservation"), f("Confirmation Code"), f("Customer"), f("Franchise"),
      f("Payment Type"), f("Method"), f("Provider"), f("Provider Reference"), f("Amount"),
      f("Royalty Amount"), f("Marketing Amount"), f("Processing Fee"), f("Franchise Net"),
      f("Processed At"), f("Period"), f("Status"), T("Notes")],
    filters: ["Franchise", "Payment Type", "Status", "Period"], extra: ["Reservation", "Confirmation Code", "Customer"] },

  { slug: "protection-plans", name: "Protection Plans", label: "${values('Plan Name')}",
    desc: "Optional damage protection offered at checkout — underwritten by a licensed provider",
    fields: [F("Plan ID"), F("Plan Name"), f("Tier"), f("Provider"), f("Coverage Limit"), f("Deductible"),
      f("Daily Premium"), f("Percent Premium"), f("Applies To"), f("Status"), T("Description")],
    filters: ["Tier", "Provider", "Status"], extra: ["Plan Name"] },

  { slug: "waivers", name: "Waivers & Signatures", label: "${values('Document Type')} v${values('Document Version')} - ${values('Signature Name')}",
    desc: "Signed documents pinned to the exact version the customer accepted",
    fields: [F("Waiver ID"), f("Reservation"), f("Confirmation Code"), f("Customer"), f("Customer Name"),
      f("Franchise"), f("Location"), f("Asset"), f("Document Type"), f("Document Version"),
      f("Signature Name"), f("Signed At"), f("IP Address"), f("Status")],
    filters: ["Franchise", "Document Type", "Status"], extra: ["Reservation", "Customer", "Confirmation Code"] },

  { slug: "maintenance-orders", name: "Maintenance Work Orders", label: "${values('Work Order ID')} - ${values('Asset')}",
    desc: "Preventive, scheduled and damage-driven service that pulls assets from the fleet",
    fields: [F("Work Order ID"), f("Asset"), f("Asset Tag"), f("Franchise"), f("Location"),
      f("Maintenance Type"), f("Priority"), f("Reported By"), f("Assigned To"), f("Opened Date"),
      f("Scheduled Date"), f("Completed Date"), f("Engine Hours At Service"), f("Parts Cost"),
      f("Labor Cost"), f("Total Cost"), f("Downtime Days"), f("Damage Report"), f("Blocks Reservations"),
      f("Status"), T("Description")],
    filters: ["Franchise", "Status", "Maintenance Type", "Priority"], extra: ["Asset", "Asset Tag", "Location"],
    pairs: [["Asset", "Status"], ["Location", "Status"]] },

  { slug: "inspections", name: "Inspections", label: "${values('Inspection Type')} - ${values('Asset')}",
    desc: "Pre-rental, post-rental, safety and seasonal inspection records",
    fields: [F("Inspection ID"), f("Asset"), f("Asset Tag"), f("Reservation"), f("Franchise"), f("Location"),
      f("Inspection Type"), f("Inspector"), f("Inspected At"), f("Fuel Level"), f("Engine Hours"),
      f("Condition"), f("Photos Count"), f("Passed"), f("Issues Found"), T("Notes")],
    filters: ["Franchise", "Inspection Type", "Passed"], extra: ["Asset", "Reservation"] },

  { slug: "damage-reports", name: "Damage Reports", label: "${values('Damage ID')} - ${values('Severity')}",
    desc: "Visual damage capture that can pull equipment from service and start a claim",
    fields: [F("Damage ID"), f("Asset"), f("Asset Tag"), f("Reservation"), f("Confirmation Code"),
      f("Customer"), f("Franchise"), f("Location"), f("Reported By"), f("Reported At"), f("Severity"),
      f("Damage Area"), f("Photos Count"), f("Estimated Cost"), f("Customer Responsible"),
      f("Charge Amount"), f("Out Of Service"), f("Work Order"), f("Claim"), f("Status"), T("Description")],
    filters: ["Franchise", "Severity", "Status"], extra: ["Asset", "Reservation", "Customer", "Location"] },

  { slug: "incidents", name: "Safety Incidents", label: "${values('Incident Type')} - ${values('Severity')}",
    desc: "Safety events with escalation to corporate for serious cases",
    fields: [F("Incident ID"), f("Incident Type"), f("Severity"), f("Franchise"), f("Location"), f("Asset"),
      f("Reservation"), f("Customer"), f("Occurred At"), f("Reported By"), f("Injuries"),
      f("Authorities Notified"), f("Regulatory Report"), f("Corporate Reviewed"), f("Reviewed By"),
      f("Status"), T("Description")],
    filters: ["Franchise", "Incident Type", "Severity", "Status"], extra: ["Asset", "Reservation"] },

  { slug: "claims", name: "Insurance Claims", label: "${values('Claim ID')} - ${values('Status')}",
    desc: "Claims filed against a protection plan with the third-party provider",
    fields: [F("Claim ID"), f("Damage Report"), f("Incident"), f("Reservation"), f("Asset"), f("Customer"),
      f("Franchise"), f("Protection Plan"), f("Provider"), f("Claim Number"), f("Filed Date"),
      f("Amount Claimed"), f("Deductible"), f("Amount Approved"), f("Adjuster"), f("Decision Date"),
      f("Status"), T("Notes")],
    filters: ["Franchise", "Status", "Provider"], extra: ["Damage Report", "Reservation", "Asset"] },

  { slug: "reviews", name: "Customer Reviews", label: "${values('Rating')}★ ${values('Location')}",
    desc: "Post-rental ratings feeding franchise satisfaction and NPS",
    fields: [F("Review ID"), f("Reservation"), f("Customer"), f("Customer Name"), f("Franchise"),
      f("Location"), f("Destination"), f("Asset"), f("Category"), f("Rating"), f("Equipment Rating"),
      f("Staff Rating"), f("Value Rating"), f("Would Recommend"), f("NPS Score"), f("Submitted At"),
      f("Status"), T("Comment"), T("Response")],
    filters: ["Franchise", "Location", "Rating", "Status"], extra: ["Reservation", "Destination"] },

  { slug: "weather-events", name: "Weather Events", label: "${values('Weather Type')} - ${values('Destination')}",
    desc: "Weather operations — advisory through closure, always with a human decision",
    fields: [F("Event ID"), f("Destination"), f("Franchise"), f("Location"), f("Weather Type"),
      f("Severity"), f("Source"), f("Starts At"), f("Ends At"), f("Recommended Action"), f("Action Taken"),
      f("Reservations Affected"), f("Revenue At Risk"), f("Decision By"), f("Decision At"), f("Status"), T("Notes")],
    filters: ["Destination", "Franchise", "Weather Type", "Status"], extra: ["Severity"] },

  { slug: "training-courses", name: "Training Courses", label: "${values('Course Name')}",
    desc: "Curriculum for franchisees and staff",
    fields: [F("Course ID"), F("Course Name"), f("Audience"), f("Category"), f("Required"),
      f("Duration Minutes"), f("Valid Months"), f("Status"), T("Description")],
    filters: ["Audience", "Category", "Required", "Status"], extra: ["Course Name"] },

  { slug: "training-records", name: "Training Records", label: "${values('Employee Name')} - ${values('Course')}",
    desc: "Who has completed what, and when it expires",
    fields: [F("Record ID"), f("Course"), f("Employee"), f("Employee Name"), f("Franchise"), f("Role"),
      f("Assigned Date"), f("Completed Date"), f("Expires Date"), f("Score"), f("Status")],
    filters: ["Franchise", "Course", "Status", "Role"], extra: ["Employee"] },

  { slug: "notifications", name: "Notifications", label: "${values('Template')} -> ${values('Recipient')}",
    desc: "Channel-agnostic outbound messages queued by workflow",
    fields: [F("Notification ID"), f("Channel"), f("Template"), f("Recipient Type"), f("Recipient"),
      f("Recipient Address"), f("Reservation"), f("Confirmation Code"), f("Franchise"), f("Subject"),
      f("Scheduled At"), f("Sent At"), f("Status"), T("Body")],
    filters: ["Channel", "Recipient Type", "Status", "Franchise"], extra: ["Reservation"] },

  { slug: "royalty-statements", name: "Royalty Statements", label: "${values('Franchise')} ${values('Period')}",
    desc: "Monthly franchise statement — every figure traceable to payments",
    fields: [F("Statement ID"), f("Franchise"), f("Period"), f("Period Start"), f("Period End"),
      f("Gross Revenue"), f("Refunds"), f("Net Revenue"), f("Royalty Rate"), f("Royalty Amount"),
      f("Marketing Fee"), f("Platform Fee"), f("Insurance Commission"), f("Other Fees"), f("Total Due"),
      f("Franchise Net"), f("Reservation Count"), f("Issued Date"), f("Paid Date"), f("Status")],
    filters: ["Franchise", "Period", "Status"], extra: [] },

  { slug: "audit-log", name: "Audit Log", label: "${values('Entity Type')} ${values('Action')} by ${values('Changed By')}",
    desc: "Who changed what, from what, to what, and why",
    fields: [F("Audit ID"), f("Entity Type"), f("Entity Reference"), f("Action"), f("Field Changed"),
      f("Previous Value"), f("New Value"), f("Changed By"), f("Changed At"), f("Franchise"), T("Reason")],
    filters: ["Entity Type", "Action", "Franchise"], extra: ["Entity Reference", "Changed By"] },
];

// every subset of a form's filter set can be ANDed by the UI, so index them all
function combos(arr) {
  const out = [];
  const rec = (start, cur) => {
    if (cur.length >= 2) out.push([...cur]);
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return out;
}

const forms = FORMS.map(spec => {
  const single = [...new Set([...spec.filters, ...(spec.extra || [])])].map(x => `values[${x}]`).sort();
  const compound = combos(spec.filters).map(c => c.map(x => `values[${x}]`))
    .concat((spec.pairs || []).map(c => c.map(x => `values[${x}]`)));
  return {
    slug: spec.slug, name: spec.name, description: spec.desc,
    submissionLabelExpression: spec.label,
    fields: spec.fields,
    indexes: { single, compound },
  };
});

const app = {
  name: "BillysBoatWorks",
  slug: "billys",
  description: "The operating system for recreational rental franchises. Consumer marketplace, franchise operations console and corporate network management across Midwest lakes — reservations, fleet economics, maintenance, safety, protection claims, territory and franchise development.",
  category: "Hospitality",
  icon: "waves",
  color: "#0EA5E9",
  bg: "#E0F2FE",
  pages: [
    { path: "", name: "Marketplace", audience: "Consumer" },
    { path: "ops.html", name: "Franchise Operations", audience: "Franchise" },
    { path: "corporate.html", name: "Corporate Network", audience: "Corporate" },
  ],
  forms,
};

fs.writeFileSync(path.join(__dir, "app.json"), JSON.stringify(app, null, 2));
const idx = forms.reduce((s, f) => s + f.indexes.single.length + f.indexes.compound.length, 0);
console.log(`forms=${forms.length} fields=${forms.reduce((s,f)=>s+f.fields.length,0)} indexes=${idx}`);
for (const f of forms) console.log(`  ${f.slug.padEnd(22)} ${String(f.fields.length).padStart(2)} fields, ${f.indexes.single.length}+${f.indexes.compound.length} idx`);
