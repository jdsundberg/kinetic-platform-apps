// Rule-based candidate extraction. Deterministic and conservative: it only proposes what the
// source metadata literally shows (a contract document exists, a meeting happened on a date, these
// people exchanged an email). Everything it produces is "proposed" and goes to human review.
// An LLM extractor can be registered alongside it (see historian model providers) — never instead
// of review.
import { parseDateMention } from "./core.mjs";

const DOC_KINDS = [
  [/\b(master (services|license|subscription) agreement|msa)\b/i, "Master agreement", "contract"],
  [/\b(licen[cs]e agreement|eula)\b/i, "License agreement", "contract"],
  [/(\border form\b|purchase[ _]order|\bpo\b|\d{4}po\b)/i, "Order", "contract"],
  [/\b(statement of work|\bsow\b)\b/i, "Statement of work", "contract"],
  [/\b(renewal|amendment|addendum)\b/i, "Contract change", "contract"],
  [/\b(nda|non-?disclosure)\b/i, "NDA", "contract"],
  [/\b(proposal|rfp|rfi|rfq)\b/i, "Proposal / RFP", "proposal"],
  [/\b(invoice)\b/i, "Invoice", "commercial"],
  [/\b(notes|minutes|meeting|check-?in|onsite)\b/i, "Meeting notes", "meeting"],
  [/\b(kickoff|kick-off|go-?live|launch)\b/i, "Implementation milestone", "implementation"],
];

export function classifyDocument(title) {
  for (const [re, label, eventType] of DOC_KINDS) if (re.test(title || "")) return { label, eventType };
  return null;
}

// rec: normalized source record; ctx: { companies: [{ "Company ID", Name }], people: [...], sourceId }
export function extractCandidates(rec, ctx) {
  const out = { events: [], knowledge: [], communications: [] };
  // A Gmail label is a folder name, not a document — "Companies/Staples RFP" is not an RFP on file.
  if (rec.sourceType === "label") return out;
  const company = ctx.companies[0];
  const kind = classifyDocument(rec.title);
  const titleDate = parseDateMention(rec.title);
  // A file's creation date in its system is when it was stored, not necessarily when the document was
  // made or signed — so it only ever yields an approximate date.
  const when = titleDate || (rec.date ? { date: String(rec.date).slice(0, 10), precision: "approximate" } : null);
  const sys = { "google-drive": "Google Drive", gmail: "Gmail", github: "GitHub", kinetic: "Kinetic Platform", manual: "manual notes" }[rec.system] || rec.system;

  if (kind && company && ["contract", "proposal", "implementation", "commercial"].includes(kind.eventType)) {
    const dateText = when ? ` dated ${when.date}${titleDate ? " (from the document title)" : " (approximately — the file's creation date in " + sys + ")"}` : "";
    out.knowledge.push({
      knowledgeType: "fact", subjectType: "company", subjectId: company["Company ID"], companyId: company["Company ID"],
      title: `${kind.label} on file: ${rec.title}`.slice(0, 240),
      statement: `${sys} holds a document titled "${rec.title}"${dateText}, associated with ${company.Name}. This establishes that the document exists; its terms have not been reviewed.`,
      sourceIds: [ctx.sourceId], extractionMethod: "rule-based", important: kind.eventType === "contract",
    });
    out.events.push({
      title: `${kind.label}: ${rec.title}`.slice(0, 240), eventType: kind.eventType, date: when?.date || "", precision: when?.precision || "unknown",
      companyId: company["Company ID"], description: `Derived from the existence and title of a ${sys} document. Terms and signature status unverified.`,
      linkKnowledgeIndex: out.knowledge.length - 1,
    });
  }
  if (rec.sourceType === "email" || rec.sourceType === "meeting") {
    out.communications.push({
      channel: rec.sourceType, subject: rec.title, date: rec.date || "", companyId: company?.["Company ID"] || "",
      participants: rec.participants || [], summary: "",
    });
  }
  if (kind && kind.eventType === "meeting" && company) {
    out.events.push({
      title: `Meeting notes: ${rec.title}`.slice(0, 240), eventType: "meeting", date: when?.date || "", precision: when ? when.precision : "unknown",
      companyId: company["Company ID"], description: `Notes document in ${sys}; meeting date ${titleDate ? "taken from the title" : "approximated by the document's creation date"}.`,
    });
  }
  return out;
}
