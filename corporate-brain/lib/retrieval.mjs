// RetrievalService — the one place the app, the historian and the UI go to find knowledge.
// Version 1 uses only Kinetic-native capabilities:
//   • structured: KQL equality on indexed fields (company, status, type, dates)
//   • prefix:     KQL starts-with (=*) on normalized "Name Key" fields (requires orderBy)
//   • keyword:    bounded server-side scan of the most recent records, token-scored
// A future native Kinetic semantic provider plugs in as another provider (see
// FUTURE_NATIVE_VECTOR_SEARCH.md); callers and the UI do not change.
import { kq } from "./store.mjs";
import { nameKey, sortableDate } from "./core.mjs";

export const SEARCHABLE = {
  company: { form: "companies", id: "Company ID", title: "Name", text: ["Aliases", "Description", "Domain", "Industry"], prefix: "Name Key", date: "First Known Date", status: "Customer Status" },
  person: { form: "people", id: "Person ID", title: "Full Name", text: ["Email", "Title", "Description"], prefix: "Name Key", status: "Kinetic Relationship", company: "Primary Company ID" },
  project: { form: "projects", id: "Project ID", title: "Name", text: ["Description", "Project Type"], prefix: "Name Key", date: "Start Date", status: "Project Status", company: "Company ID" },
  product: { form: "products", id: "Product ID", title: "Name", text: ["Description", "Category"], prefix: "Name Key", date: "Introduced Date", status: "Product Status" },
  knowledge: { form: "knowledge-entries", id: "Knowledge ID", title: "Title", text: ["Statement"], status: "Review Status", company: "Company ID", kind: "Knowledge Type" },
  event: { form: "historical-events", id: "Event ID", title: "Title", text: ["Description", "Event Type"], date: "Event Date", status: "Verification Status", company: "Company ID", kind: "Event Type" },
  decision: { form: "decisions", id: "Decision ID", title: "Title", text: ["Context", "Decision", "Rationale"], date: "Decision Date", status: "Verification Status", company: "Company ID" },
  source: { form: "sources", id: "Source ID", title: "Title", text: ["Excerpt", "Owner", "Source Type"], date: "Source Date", status: "Processing Status", company: "Company ID", kind: "Source System" },
  communication: { form: "communications", id: "Communication ID", title: "Subject", text: ["Summary", "Participants"], date: "Communication Date", company: "Company ID", kind: "Channel" },
};

const tokens = (s) => nameKey(s).split(" ").filter(t => t.length > 1);

function toHit(type, rec, score, matchedBy) {
  const d = SEARCHABLE[type];
  const text = d.text.map(f => rec[f]).filter(Boolean).join(" · ");
  return {
    type, form: d.form, id: rec[d.id], submissionId: rec._id, title: rec[d.title] || "(untitled)",
    snippet: text.slice(0, 220), status: d.status ? rec[d.status] || "" : "", kind: d.kind ? rec[d.kind] || "" : "",
    date: d.date ? rec[d.date] || "" : "", companyId: d.company ? rec[d.company] || "" : (type === "company" ? rec[d.id] : ""),
    score, matchedBy,
  };
}

function scoreRecord(type, rec, toks) {
  if (!toks.length) return 1;
  const d = SEARCHABLE[type];
  const title = nameKey(rec[d.title]);
  const body = nameKey(d.text.map(f => rec[f]).join(" "));
  let s = 0;
  for (const t of toks) {
    if (title.split(" ").includes(t)) s += 3; else if (title.includes(t)) s += 2;
    else if (body.split(" ").includes(t)) s += 1; else if (body.includes(t)) s += 0.5; else return 0; // AND semantics
  }
  return s;
}

// Builds the structured KQL for a type from filters, using only indexed fields.
export function structuredQuery(type, f = {}) {
  const d = SEARCHABLE[type]; const parts = [];
  if (f.companyId && d.company) parts.push(`values[${d.company}] = ${kq(f.companyId)}`);
  if (f.status && d.status && ["knowledge", "event", "decision", "source"].includes(type)) parts.push(`values[${d.status}] = ${kq(f.status)}`);
  if (f.kind && d.kind && ["knowledge", "event"].includes(type)) parts.push(`values[${d.kind}] = ${kq(f.kind)}`);
  return parts.join(" AND ");
}

export const providers = {
  structured: { name: "Kinetic KQL (indexed filters)", kind: "structured", available: true },
  prefix: { name: "Kinetic KQL starts-with on Name Key", kind: "prefix", available: true },
  keyword: { name: "Bounded keyword scan (Kinetic submissions)", kind: "keyword", available: true },
  semantic: { name: "Native Kinetic semantic search", kind: "semantic", available: false, note: "Planned platform enhancement — see FUTURE_NATIVE_VECTOR_SEARCH.md" },
};

export function createRetrieval(store, { scanPages = 8 } = {}) {
  async function searchType(type, q, f) {
    const d = SEARCHABLE[type]; const toks = tokens(q); const notes = [];
    let recs = [], matchedBy = "keyword", truncated = false;
    const sq = structuredQuery(type, f);
    if (d.prefix && q && !sq) {
      // prefix on the normalized name, then fall back to keyword scan for words mid-name
      const key = nameKey(q);
      const r = await store.page(d.form, { q: `values[${d.prefix}] =* ${kq(key)}`, orderBy: `values[${d.prefix}]`, limit: 25 });
      recs = r.items; matchedBy = "prefix";
      if (recs.length < 25) {
        const scan = await store.collect(d.form, "", { maxPages: scanPages });
        truncated = scan.truncated;
        const seen = new Set(recs.map(x => x._id));
        recs = recs.concat(scan.items.filter(x => !seen.has(x._id)));
      }
    } else {
      const scan = await store.collect(d.form, sq, { maxPages: scanPages });
      recs = scan.items; truncated = scan.truncated; matchedBy = sq ? (q ? "structured+keyword" : "structured") : "keyword";
    }
    if (truncated) notes.push(`${type}: scanned the most recent ${recs.length} records; add filters to narrow`);
    let hits = recs.map(r => ({ r, s: scoreRecord(type, r, toks) })).filter(x => x.s > 0);
    if (f.from || f.to) {
      hits = hits.filter(({ r }) => {
        const dt = d.date ? sortableDate(r[d.date]) : ""; if (!dt) return false; // undated records cannot satisfy a date range
        return (!f.from || dt >= sortableDate(f.from)) && (!f.to || dt <= sortableDate(f.to).replace(/-00/g, "-99"));
      });
    }
    if (f.status && d.status && !["knowledge", "event", "decision", "source"].includes(type)) hits = hits.filter(({ r }) => r[d.status] === f.status);
    return { hits: hits.map(({ r, s }) => toHit(type, r, s, matchedBy)), notes };
  }

  // query: { q, types?: [..], companyId?, status?, kind?, from?, to?, limit? }
  async function search(query = {}) {
    const types = (query.types && query.types.length ? query.types : Object.keys(SEARCHABLE)).filter(t => SEARCHABLE[t]);
    const results = await Promise.all(types.map(t => searchType(t, query.q || "", query).catch(e => ({ hits: [], notes: [`${t}: ${e.message}`] }))));
    const hits = results.flatMap(r => r.hits).sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)));
    return {
      query, providers: Object.values(providers).filter(p => p.available).map(p => p.name),
      semantic: providers.semantic, total: hits.length, hits: hits.slice(0, query.limit || 50), notes: results.flatMap(r => r.notes),
    };
  }
  return { search, searchType };
}
