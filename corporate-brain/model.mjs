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
const SALES_REVIEW = [f("Knowledge ID"), f("Verification Status")];
// RFP Intelligence rows carry their own Access Scope so the CB Restricted Source policy can judge each submission.
const SCOPED = [f("Access Scope")];

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
      f("Last Reviewed At"), f("Record Status"), f("Created Via"), f("Lens")],
    unique: ["values[Knowledge ID]"],
    single: ["values[Review Status]", "values[Knowledge Type]", "values[Subject ID]", "values[Company ID]", "values[Job ID]", "values[Record Status]", "values[Lens]"],
    compound: [["values[Subject ID]", "values[Review Status]"], ["values[Company ID]", "values[Review Status]"],
      ["values[Knowledge Type]", "values[Review Status]"], ["values[Company ID]", "values[Knowledge Type]"],
      ["values[Company ID]", "values[Knowledge Type]", "values[Review Status]"], ["values[Lens]", "values[Review Status]"]],
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
  // ── Sales lens: how Kinetic sells and why. Each record is backed by a knowledge entry (Lens "sales") that carries
  // its review; the record's Verification Status follows that entry, the same way events follow theirs.
  {
    slug: "sales-principles", name: "Sales Principles", idField: "Principle ID", label: "Title",
    description: "Rules Kinetic follows when selling, in the founders' words, backed by the deals where they showed up",
    fields: [f("Principle ID", { required: true }), f("Title", { required: true }), long("Statement"), f("Theme"),
      f("In Effect From"), f("In Effect To"), f("Date Precision"), long("Deal IDs"), long("Rationale"), long("Exceptions"),
      f("Superseded By"), ...SALES_REVIEW, ...PROV],
    unique: ["values[Principle ID]"],
    single: ["values[Verification Status]", "values[Theme]", "values[Knowledge ID]", "values[Record Status]"],
    compound: [["values[Verification Status]", "values[Theme]"]],
  },
  {
    slug: "pricing-models", name: "Pricing Models", idField: "Pricing Model ID", label: "Name",
    description: "Licensing and pricing models over time: when each started and ended, its price points and why it changed",
    fields: [f("Pricing Model ID", { required: true }), f("Name", { required: true }), f("Name Key"), f("Licensing Basis"),
      f("Product ID"), f("Start Date"), f("End Date"), f("Date Precision"), long("Price Points"), long("Why Introduced"),
      long("Why Changed"), f("Replaced By"), ...SALES_REVIEW, ...PROV],
    unique: ["values[Pricing Model ID]"],
    single: ["values[Verification Status]", "values[Knowledge ID]", "values[Record Status]", "values[Licensing Basis]"],
    compound: [["values[Record Status]", "values[Start Date]"]],
  },
  {
    slug: "deals", name: "Deals", idField: "Deal ID", label: "Title",
    description: "One opportunity: the ask, the competition, the outcome and the reason (prices live in Deal Pricing)",
    fields: [f("Deal ID", { required: true }), f("Title", { required: true }), f("Company ID"), f("Deal Date"),
      f("Date Precision"), f("Deal Type"), long("Ask"), long("Competitor IDs"), f("Outcome"), long("Outcome Reason"),
      f("Pricing Model ID"), f("Partner Model ID"), f("Copper Opportunity ID"), ...SALES_REVIEW, ...PROV],
    unique: ["values[Deal ID]"],
    single: ["values[Verification Status]", "values[Company ID]", "values[Outcome]", "values[Knowledge ID]",
      "values[Record Status]", "values[Copper Opportunity ID]"],
    compound: [["values[Verification Status]", "values[Outcome]"], ["values[Company ID]", "values[Deal Date]"]],
  },
  {
    // Deal-level prices are commercially sensitive: readable only by reviewers and the Sales, Legal and Executive
    // teams (CB Deal Pricing policy), so they sit on their own form rather than on the deal.
    slug: "deal-pricing", name: "Deal Pricing", idField: "Deal Pricing ID", label: "Deal ID",
    description: "Quoted and final prices, discounts and terms for a deal — restricted to Sales, Legal and Executive",
    fields: [f("Deal Pricing ID", { required: true }), f("Deal ID", { required: true }), f("Company ID"), f("Quoted Price"),
      f("Final Price"), f("Currency"), f("Discount"), long("Discount Reason"), long("Terms"), ...PROV],
    unique: ["values[Deal Pricing ID]"],
    single: ["values[Deal ID]", "values[Company ID]"],
    compound: [],
  },
  {
    slug: "sales-objections", name: "Sales Objections", idField: "Objection ID", label: "Title",
    description: "What customers pushed back on, and the responses that worked or failed",
    fields: [f("Objection ID", { required: true }), f("Title", { required: true }), long("Objection"), f("Category"),
      long("Responses"), long("Deal IDs"), f("Competitor ID"), ...SALES_REVIEW, ...PROV],
    unique: ["values[Objection ID]"],
    single: ["values[Verification Status]", "values[Category]", "values[Knowledge ID]", "values[Record Status]"],
    compound: [["values[Verification Status]", "values[Category]"]],
  },
  {
    slug: "competitors", name: "Competitors", idField: "Competitor ID", label: "Name",
    description: "Who Kinetic met in deals, and where it won or lost against them",
    fields: [f("Competitor ID", { required: true }), f("Name", { required: true }), f("Name Key"), f("Company ID"),
      f("Category"), long("Where We Win"), long("Where We Lose"), long("Deal IDs"), ...SALES_REVIEW, ...PROV],
    unique: ["values[Competitor ID]"],
    single: ["values[Verification Status]", "values[Name Key]", "values[Knowledge ID]", "values[Record Status]"],
    compound: [["values[Record Status]", "values[Name Key]"]],
  },
  {
    slug: "partner-models", name: "Partner Models", idField: "Partner Model ID", label: "Name",
    description: "Reseller, referral, OEM and teaming arrangements and their terms over time",
    fields: [f("Partner Model ID", { required: true }), f("Name", { required: true }), f("Name Key"), f("Partner Type"),
      f("Start Date"), f("End Date"), f("Date Precision"), long("Terms"), long("Partner Company IDs"), long("Rationale"),
      ...SALES_REVIEW, ...PROV],
    unique: ["values[Partner Model ID]"],
    single: ["values[Verification Status]", "values[Partner Type]", "values[Knowledge ID]", "values[Record Status]"],
    compound: [["values[Verification Status]", "values[Partner Type]"]],
  },
  // ── RFP Intelligence: every question Kinetic has been asked in a procurement, the exact answer it gave and where
  // that answer sits in the original document. Historical answers are evidence; approved answers are current knowledge.
  {
    slug: "rfp-sources", name: "RFP Sources", idField: "RFP Source ID", label: "Opportunity Name",
    description: "A procurement (RFP, RFQ, RFI, questionnaire) and its documents; unknown dates and outcomes stay unknown",
    fields: [f("RFP Source ID", { required: true }), f("Opportunity Name", { required: true }), f("Customer Name"), f("Company ID"),
      f("Solicitation Number"), f("Procurement Type"), f("Received At"), f("Due At"), f("Submitted At"), f("Opportunity Status"),
      long("Status Basis"), f("Deal ID"), f("Library Status"), long("Document IDs"), f("Question Count"), f("Answered Count"), f("Approved Count"),
      long("Notes"), ...SCOPED, ...PROV],
    unique: ["values[RFP Source ID]"],
    single: ["values[Record Status]", "values[Company ID]", "values[Solicitation Number]", "values[Access Scope]", "values[Procurement Type]", "values[Library Status]"],
    compound: [["values[Access Scope]", "values[Record Status]"]],
  },
  {
    slug: "rfp-documents", name: "RFP Documents", idField: "Document ID", label: "File Name",
    description: "One revision of one procurement document; the original file is kept as an attachment and never changed",
    fields: [f("Document ID", { required: true }), f("RFP Source ID", { required: true }), f("File Name", { required: true }), f("File Type"),
      f("Document Role"), f("Revision"), f("Supersedes Document ID"), f("Content Hash"), f("Document Key"), f("Source ID"), f("Original URL"),
      f("Original File", { renderType: "attachment", allowMultiple: false }), f("File Size"), f("Page Count"), f("Document Date"), f("Extraction Status"), long("Extraction Notes"),
      f("Question Count"), f("Answered Count"), f("Needs Review Count"), f("Import Job ID"), ...SCOPED, ...PROV],
    unique: ["values[Document ID]", "values[Document Key]"],
    single: ["values[RFP Source ID]", "values[Source ID]", "values[Content Hash]", "values[Extraction Status]", "values[Record Status]", "values[Access Scope]"],
    compound: [["values[Access Scope]", "values[RFP Source ID]"]],
  },
  {
    slug: "rfp-questions", name: "RFP Questions", idField: "Question ID", label: "Question Number",
    description: "A question exactly as a procurement asked it, where it sits in the document, and its extraction review state",
    fields: [f("Question ID", { required: true }), f("RFP Source ID", { required: true }), f("Document ID"), f("Question Number"),
      long("Question Text Original"), long("Question Text Normalized"), f("Question Key"), f("Row Key"), f("Sequence"), f("Section"), f("Subsection"),
      f("Category"), f("Tags"), f("Category Source"), long("Source Location"), f("Location Label"), f("Requirement Level"), f("Requirement Basis"),
      f("Extraction Status"), long("Extraction Reason"), f("Answer Status"), long("Answer Preview"), f("Latest Answer ID"), f("Possible Duplicate Of"),
      f("Duplicate Score"), f("Canonical Question ID"), f("Citation Verified"), f("Confirmed By"), f("Confirmed At"), ...SCOPED, ...PROV],
    unique: ["values[Question ID]", "values[Row Key]"],
    single: ["values[RFP Source ID]", "values[Document ID]", "values[Canonical Question ID]", "values[Question Key]", "values[Extraction Status]",
      "values[Category]", "values[Access Scope]", "values[Record Status]"],
    compound: [["values[Access Scope]", "values[RFP Source ID]"], ["values[Access Scope]", "values[Document ID]"],
      ["values[Access Scope]", "values[Canonical Question ID]"], ["values[Access Scope]", "values[Question Key]"]],
  },
  {
    slug: "rfp-answers", name: "RFP Historical Answers", idField: "Answer ID", label: "Answer ID",
    description: "The exact answer Kinetic gave (or drafted) in one document revision; immutable once confirmed — corrections are new revisions",
    fields: [f("Answer ID", { required: true }), f("Question ID", { required: true }), f("RFP Source ID"), f("Document ID"),
      long("Answer Text Original"), long("Answer Parts"), long("Compliance"), f("Answer Date"), f("Date Precision"), long("Source Location"),
      f("Location Label"), f("Document Version"), f("Product Version"), f("Answer Status"), f("Answer Key"), f("Citation Verified"),
      f("Confirmed By"), f("Confirmed At"), f("Revision Of"), long("Correction Note"), ...SCOPED, ...PROV],
    unique: ["values[Answer ID]", "values[Answer Key]"],
    single: ["values[Question ID]", "values[RFP Source ID]", "values[Document ID]", "values[Answer Status]", "values[Access Scope]", "values[Record Status]"],
    compound: [["values[Access Scope]", "values[Question ID]"], ["values[Access Scope]", "values[Document ID]"], ["values[Access Scope]", "values[RFP Source ID]"]],
  },
  {
    slug: "canonical-questions", name: "Canonical Questions", idField: "Canonical Question ID", label: "Canonical Question",
    description: "One subject many historical questions share; each keeps its own wording and its own answers",
    fields: [f("Canonical Question ID", { required: true }), f("Canonical Question", { required: true }), f("Subject Key"), f("Category"), f("Tags"),
      long("Description"), f("Question Count"), ...PROV],
    unique: ["values[Canonical Question ID]"],
    single: ["values[Record Status]", "values[Category]", "values[Subject Key]"],
    compound: [],
  },
  {
    slug: "approved-answers", name: "Approved Answers", idField: "Approved Answer ID", label: "Canonical Question",
    description: "Current reusable answers, approved by a reviewer for stated product versions and environments, with evidence and a review date",
    fields: [f("Approved Answer ID", { required: true }), f("Canonical Question ID"), f("Canonical Question"), long("Approved Answer"), f("Category"),
      f("Product Versions"), long("Deployment Conditions"), f("Applicable Environments"), long("Evidence References"), long("Historical Answer IDs"),
      f("Owner"), f("Approval Status"), f("Sensitive"), f("Approved By"), f("Approved At"), f("Review Due At"), f("Superseded By"), f("Supersedes"),
      f("Knowledge ID"), long("Review History"), ...PROV],
    unique: ["values[Approved Answer ID]"],
    single: ["values[Canonical Question ID]", "values[Approval Status]", "values[Category]", "values[Knowledge ID]", "values[Record Status]", "values[Owner]"],
    compound: [["values[Approval Status]", "values[Category]"]],
  },
  {
    slug: "rfp-analyses", name: "RFP Analyses", idField: "Analysis ID", label: "Title",
    description: "A new RFP analysed against the question library: a reviewable requirements matrix of AI-generated drafts",
    fields: [f("Analysis ID", { required: true }), f("Title", { required: true }), f("RFP Source ID"), f("Customer Name"), f("Solicitation Number"),
      f("Due At"), long("Document IDs"), f("Status"), f("Item Count"), f("Drafted Count"), f("No Evidence Count"), f("Conflict Count"),
      f("Job ID"), long("Notes"), ...PROV],
    unique: ["values[Analysis ID]"],
    single: ["values[Record Status]", "values[Status]", "values[RFP Source ID]"],
    compound: [],
  },
  {
    slug: "rfp-analysis-items", name: "RFP Analysis Items", idField: "Analysis Item ID", label: "Question Number",
    description: "One requirement of a new RFP with its AI-generated draft, the evidence it used and its review",
    fields: [f("Analysis Item ID", { required: true }), f("Analysis ID", { required: true }), f("Sequence"), f("Question Number"),
      long("Question Text Original"), f("Section"), f("Requirement Level"), f("Requirement Basis"), long("Source Location"), f("Location Label"),
      f("Document ID"), f("Category"), long("Draft Answer"), f("Draft Basis"), f("Content Class"), long("Approved Answer IDs"), long("Matched Questions"),
      long("Citations"), f("Match Strength"), f("Match Score"), long("Conflicts"), f("Review Status"), long("Final Answer"), f("Reviewed By"),
      f("Reviewed At"), f("Record Status"), f("Created Via")],
    unique: ["values[Analysis Item ID]"],
    single: ["values[Analysis ID]", "values[Review Status]"],
    compound: [["values[Analysis ID]", "values[Sequence]"]],
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
  principle: "sales-principles", pricingmodel: "pricing-models", deal: "deals", objection: "sales-objections",
  competitor: "competitors", partnermodel: "partner-models",
  rfp: "rfp-sources", rfpdocument: "rfp-documents", rfpquestion: "rfp-questions", rfpanswer: "rfp-answers",
  canonical: "canonical-questions", approvedanswer: "approved-answers", rfpanalysis: "rfp-analyses",
};
// RFP Intelligence forms whose rows carry Access Scope (members only ever see "internal" rows)
export const RFP_SCOPED_FORMS = ["rfp-sources", "rfp-documents", "rfp-questions", "rfp-answers"];
export const RFP_FORMS = new Set([...RFP_SCOPED_FORMS, "canonical-questions", "approved-answers", "rfp-analyses", "rfp-analysis-items"]);
export const PROCUREMENT_TYPES = ["rfp", "rfq", "rfi", "questionnaire", "other"];
export const DOCUMENT_ROLES = ["response", "solicitation", "combined", "reference"];
export const APPROVAL_STATUSES = ["draft", "needs-review", "approved", "outdated", "superseded", "historical-only"];

// Sales lens: entity type → its form and the Knowledge Type of the entry that carries its review.
// Deal pricing is deliberately not an entity type: it is only reachable through its deal, by permitted roles.
export const SALES_KINDS = {
  principle: { form: "sales-principles", knowledgeType: "principle", label: "Principle" },
  pricingmodel: { form: "pricing-models", knowledgeType: "pricing-model", label: "Pricing model" },
  deal: { form: "deals", knowledgeType: "deal", label: "Deal" },
  objection: { form: "sales-objections", knowledgeType: "objection", label: "Objection" },
  competitor: { form: "competitors", knowledgeType: "competitor", label: "Competitor" },
  partnermodel: { form: "partner-models", knowledgeType: "partner-model", label: "Partner model" },
};
export const SALES_FORMS = new Set(Object.values(SALES_KINDS).map(k => k.form));
// A principle is a pattern, not an anecdote: it needs this many linked deals before it can be verified (John, 2026-10-27).
export const PRINCIPLE_MIN_DEALS = 2;

export const ID_PREFIX = {
  companies: "CO", people: "PE", relationships: "RL", communications: "CM", "historical-events": "EV", decisions: "DC",
  "knowledge-entries": "KN", sources: "SR", projects: "PR", products: "PD", "research-jobs": "JB", "audit-log": "AU",
  "sales-principles": "SP", "pricing-models": "PM", deals: "DL", "deal-pricing": "DP", "sales-objections": "OB",
  competitors: "CP", "partner-models": "PT",
  "rfp-sources": "RS", "rfp-documents": "RD", "rfp-questions": "RQ", "rfp-answers": "RA", "canonical-questions": "CQ",
  "approved-answers": "AA", "rfp-analyses": "AN", "rfp-analysis-items": "AI",
};

export const REVIEW_STATUSES = ["proposed", "verified", "disputed", "rejected", "superseded", "needs-research"];
export const KNOWLEDGE_TYPES = ["fact", "interpretation", "narrative", "lesson", "claim", "commitment", "recollection", "summary",
  "principle", "pricing-model", "deal", "objection", "competitor", "partner-model", "approved-answer"];
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
