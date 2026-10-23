// Corporate Brain data model — single source of truth for forms, fields and indexes.
//   node apps/corporate-brain/model.mjs        → regenerates app.json
// Every form gets: a stable "<Entity> ID", Record Status, Source IDs (provenance) and
// Kinetic's own createdAt/createdBy/updatedAt/updatedBy metadata.
// List-valued fields (IDs) are stored as JSON arrays in text fields.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const f = (name, opts = {}) => ({ name, ...opts });
const long = name => f(name, { rows: 4 });
const PROV = [f("Record Status"), long("Source IDs"), f("Created Via")];

export const FORMS = [
  {
    slug: "companies", name: "Companies", idField: "Company ID", label: "Name",
    description: "Organizations: customers, prospects, partners, vendors and Kinetic itself",
    fields: [f("Company ID", { required: true }), f("Name", { required: true }), f("Name Key"), f("Aliases"), f("Domain"),
      f("Industry"), f("Country"), f("Customer Status"), long("Customer Status Basis"), f("First Known Date"),
      long("Description"), f("Merged Into"), ...PROV],
    unique: ["values[Company ID]"],
    single: ["values[Record Status]", "values[Customer Status]", "values[Name Key]", "values[Name]"],
    compound: [["values[Record Status]", "values[Name Key]"], ["values[Customer Status]", "values[Name Key]"]],
  },
  {
    slug: "people", name: "People", idField: "Person ID", label: "Full Name",
    description: "Individuals and their history with Kinetic",
    fields: [f("Person ID", { required: true }), f("Full Name", { required: true }), f("Name Key"), f("Email"),
      f("Primary Company ID"), f("Title"), f("Kinetic Relationship"), long("Description"), f("Merged Into"), ...PROV],
    unique: ["values[Person ID]"],
    single: ["values[Record Status]", "values[Name Key]", "values[Primary Company ID]", "values[Email]"],
    compound: [["values[Primary Company ID]", "values[Name Key]"], ["values[Record Status]", "values[Name Key]"]],
  },
  {
    slug: "relationships", name: "Relationships", idField: "Relationship ID", label: "Relationship Type",
    description: "Typed many-to-many links between entities by stable ID (never by display name)",
    fields: [f("Relationship ID", { required: true }), f("From Type"), f("From ID", { required: true }), f("To Type"),
      f("To ID", { required: true }), f("Relationship Type", { required: true }), f("Role"), f("Start Date"),
      f("End Date"), f("Date Precision"), long("Notes"), ...PROV],
    unique: ["values[Relationship ID]"],
    single: ["values[From ID]", "values[To ID]", "values[Relationship Type]", "values[Record Status]"],
    compound: [["values[From ID]", "values[Relationship Type]"], ["values[To ID]", "values[Relationship Type]"]],
  },
  {
    slug: "communications", name: "Communications", idField: "Communication ID", label: "Subject",
    description: "Email, meeting and conversation metadata (bodies stay in the source system)",
    fields: [f("Communication ID", { required: true }), f("Channel"), f("Subject"), f("Communication Date"),
      long("Participants"), f("Company ID"), long("Company IDs"), long("Person IDs"), f("Source ID"), long("Summary"), ...PROV],
    unique: ["values[Communication ID]"],
    single: ["values[Company ID]", "values[Source ID]", "values[Communication Date]", "values[Record Status]"],
    compound: [["values[Company ID]", "values[Communication Date]"]],
  },
  {
    slug: "historical-events", name: "Historical Events", idField: "Event ID", label: "Title",
    description: "Significant dated events; never overwritten when later information arrives",
    fields: [f("Event ID", { required: true }), f("Title", { required: true }), f("Event Type"), f("Event Date"),
      f("Date Precision"), f("Company ID"), f("Project ID"), f("Product ID"), long("Person IDs"), long("Description"),
      f("Verification Status"), f("Knowledge ID"), ...PROV],
    unique: ["values[Event ID]"],
    single: ["values[Company ID]", "values[Event Date]", "values[Event Type]", "values[Verification Status]",
      "values[Project ID]", "values[Product ID]", "values[Record Status]", "values[Knowledge ID]"],
    compound: [["values[Company ID]", "values[Event Date]"], ["values[Event Type]", "values[Event Date]"],
      ["values[Record Status]", "values[Event Date]"], ["values[Project ID]", "values[Event Date]"], ["values[Product ID]", "values[Event Date]"]],
  },
  {
    slug: "decisions", name: "Decisions", idField: "Decision ID", label: "Title",
    description: "Business and technical decisions with context, rationale and alternatives",
    fields: [f("Decision ID", { required: true }), f("Title", { required: true }), f("Decision Date"), f("Date Precision"),
      f("Decision Area"), long("Context"), long("Decision"), long("Rationale"), long("Alternatives Considered"),
      long("Decided By"), f("Company ID"), f("Project ID"), f("Product ID"), f("Verification Status"), ...PROV],
    unique: ["values[Decision ID]"],
    single: ["values[Company ID]", "values[Decision Date]", "values[Verification Status]", "values[Record Status]", "values[Product ID]"],
    compound: [["values[Record Status]", "values[Decision Date]"]],
  },
  {
    slug: "knowledge-entries", name: "Knowledge Entries", idField: "Knowledge ID", label: "Title",
    description: "Facts, interpretations, narratives, lessons, claims and recollections — each with evidence and review status",
    fields: [f("Knowledge ID", { required: true }), f("Knowledge Type", { required: true }), f("Subject Type"),
      f("Subject ID"), f("Company ID"), f("Title", { required: true }), long("Statement"), long("Supporting Source IDs"),
      f("Extraction Method"), f("Model Confidence"), f("Review Status"), f("Verified By"), f("Verified At"),
      f("Superseded By"), f("Supersedes"), long("Contradicts"), long("Review History"), f("Job ID"),
      f("Last Reviewed At"), f("Record Status"), f("Created Via")],
    unique: ["values[Knowledge ID]"],
    single: ["values[Review Status]", "values[Knowledge Type]", "values[Subject ID]", "values[Company ID]", "values[Job ID]", "values[Record Status]"],
    compound: [["values[Subject ID]", "values[Review Status]"], ["values[Company ID]", "values[Review Status]"],
      ["values[Knowledge Type]", "values[Review Status]"], ["values[Company ID]", "values[Knowledge Type]"],
      ["values[Company ID]", "values[Knowledge Type]", "values[Review Status]"]],
  },
  {
    slug: "sources", name: "Sources", idField: "Source ID", label: "Title",
    description: "References to original evidence; the source system stays authoritative for content",
    fields: [f("Source ID", { required: true }), f("Source Type"), f("Source System", { required: true }),
      f("Original ID", { required: true }), f("Title"), f("Source Date"), f("Owner"), f("Access Scope"),
      f("Original URL"), long("Excerpt"), f("Content Hash"), f("Processing Status"), f("Company ID"),
      long("Company IDs"), long("Person IDs"), f("Ingest Job ID"), f("Last Synced At"), long("Processing Error"),
      f("Record Status"), f("Created Via")],
    unique: ["values[Source ID]"],
    single: ["values[Company ID]", "values[Source System]", "values[Processing Status]", "values[Ingest Job ID]",
      "values[Source Date]", "values[Record Status]", "values[Access Scope]"],
    compound: [["values[Company ID]", "values[Source Date]"], ["values[Source System]", "values[Processing Status]"], ["values[Source System]", "values[Original ID]"],
      ["values[Company ID]", "values[Source System]"], ["values[Company ID]", "values[Processing Status]"], ["values[Company ID]", "values[Source System]", "values[Processing Status]"],
      // members' queries are prefixed with Access Scope (store.setScope), so every filter combination needs an Access Scope-first twin
      ["values[Access Scope]", "values[Company ID]"], ["values[Access Scope]", "values[Processing Status]"],
      ["values[Access Scope]", "values[Company ID]", "values[Processing Status]"], ["values[Access Scope]", "values[Source System]"],
      ["values[Access Scope]", "values[Source System]", "values[Processing Status]"], ["values[Access Scope]", "values[Company ID]", "values[Source System]"],
      ["values[Access Scope]", "values[Company ID]", "values[Source System]", "values[Processing Status]"], ["values[Access Scope]", "values[Ingest Job ID]"]],
  },
  {
    slug: "projects", name: "Projects", idField: "Project ID", label: "Name",
    description: "Customer implementations and internal projects",
    fields: [f("Project ID", { required: true }), f("Name", { required: true }), f("Name Key"), f("Company ID"),
      f("Project Type"), f("Project Status"), f("Start Date"), f("End Date"), f("Date Precision"), long("Product IDs"),
      long("Description"), ...PROV],
    unique: ["values[Project ID]"],
    single: ["values[Company ID]", "values[Record Status]", "values[Name Key]", "values[Project Status]"],
    compound: [["values[Company ID]", "values[Start Date]"], ["values[Company ID]", "values[Name Key]"]],
  },
  {
    slug: "products", name: "Products", idField: "Product ID", label: "Name",
    description: "Kinetic products and major capabilities",
    fields: [f("Product ID", { required: true }), f("Name", { required: true }), f("Name Key"), f("Category"),
      f("Introduced Date"), f("Product Status"), long("Description"), ...PROV],
    unique: ["values[Product ID]"],
    single: ["values[Record Status]", "values[Name Key]", "values[Category]"],
    compound: [],
  },
  {
    slug: "research-jobs", name: "Research Jobs", idField: "Job ID", label: "Title",
    description: "Historical research and ingestion jobs with checkpoints, counters and errors",
    fields: [f("Job ID", { required: true }), f("Title", { required: true }), f("Job Type"), f("Connector"),
      long("Scope"), f("Subject Type"), f("Subject ID"), f("Status"), long("Checkpoint"), f("Batch Size"),
      f("Items Discovered"), f("Items Processed"), f("Items Skipped"), f("Items Failed"), long("Errors"),
      f("Requested By"), f("Started At"), f("Completed At"), long("Summary"), long("Open Questions"), f("Attempts"),
      f("Record Status"), f("Created Via")],
    unique: ["values[Job ID]"],
    single: ["values[Status]", "values[Job Type]", "values[Subject ID]", "values[Connector]", "values[Record Status]"],
    compound: [["values[Status]", "values[Job Type]"]],
  },
  {
    slug: "audit-log", name: "Audit Log", idField: "Audit ID", label: "Action",
    description: "Append-only record of material changes by users and agents (review decisions, merges, ingestion writes)",
    fields: [f("Audit ID", { required: true }), f("Action", { required: true }), f("Entity Type"), f("Entity ID"),
      f("Actor"), f("Actor Type"), f("From Status"), f("To Status"), long("Comment"), long("Details"), f("Occurred At")],
    unique: ["values[Audit ID]"],
    single: ["values[Entity ID]", "values[Action]", "values[Actor]", "values[Occurred At]"],
    compound: [["values[Entity ID]", "values[Occurred At]"]],
  },
];

export const KAPP = { slug: "corporate-brain", name: "Corporate Brain" };

export const FORM_BY_SLUG = Object.fromEntries(FORMS.map(x => [x.slug, x]));

// Entity type → form slug, used by relationships, subject references and the UI.
export const ENTITY_FORMS = {
  company: "companies", person: "people", communication: "communications", event: "historical-events",
  decision: "decisions", knowledge: "knowledge-entries", source: "sources", project: "projects", product: "products", job: "research-jobs",
};

export const ID_PREFIX = {
  companies: "CO", people: "PE", relationships: "RL", communications: "CM", "historical-events": "EV", decisions: "DC",
  "knowledge-entries": "KN", sources: "SR", projects: "PR", products: "PD", "research-jobs": "JB", "audit-log": "AU",
};

export const REVIEW_STATUSES = ["proposed", "verified", "disputed", "rejected", "superseded", "needs-research"];
export const KNOWLEDGE_TYPES = ["fact", "interpretation", "narrative", "lesson", "claim", "recollection", "summary"];
export const DATE_PRECISIONS = ["exact", "month", "year", "approximate", "unknown"];

export function toAppJson() {
  return {
    name: KAPP.name,
    slug: KAPP.slug,
    description: "Kinetic Data's institutional memory: companies, people, events, decisions and knowledge, every claim traceable to evidence and human-reviewed.",
    category: "Knowledge",
    icon: "brain",
    color: "#3B2F6B",
    bg: "#ECE8F7",
    forms: FORMS.map(x => ({
      slug: x.slug, name: x.name, description: x.description,
      submissionLabelExpression: "${values('" + x.label + "')}",
      fields: x.fields,
      indexes: { single: [...x.unique.filter(u => typeof u === "string"), ...x.single], compound: [...x.unique.filter(u => Array.isArray(u)), ...x.compound] },
      uniqueIndexes: x.unique.map(u => (Array.isArray(u) ? u : [u])),
    })),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.writeFileSync(path.join(HERE, "app.json"), JSON.stringify(toAppJson(), null, 2) + "\n");
  console.log(`app.json written: ${FORMS.length} forms, ${FORMS.reduce((n, x) => n + x.fields.length, 0)} fields`);
}
