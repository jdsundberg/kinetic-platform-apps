// RFP Intelligence unit tests — document parsing, question/answer extraction, citations, similarity and categories.
// Offline: synthetic fixtures only (tests/fixtures.mjs), no Kinetic server.   node apps/corporate-brain/tests/rfp.test.mjs
import zlib from "zlib";
import { parseDocument, locLabel, detectFormat } from "../lib/docparse.mjs";
import { extractQuestions, verifyCitation, locate, similarity, classify, tokens, levelFromValue } from "../lib/rfp-extract.mjs";
import { SAMPLE, docx, xlsx, pdf } from "./fixtures.mjs";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${name}${extra && !ok ? " — " + extra : ""}`); };
const ex = (buf, name, role = "response") => extractQuestions(parseDocument(buf, name), { role });

// ── formats ──
check("format detection by content, not just extension", detectFormat("x.bin", SAMPLE.pdfRfp()) === "pdf" && detectFormat("x.bin", SAMPLE.docxResponse()) === "docx" && detectFormat("x.bin", SAMPLE.xlsxQuestionnaire()) === "xlsx");
check("legacy binary Office files are reported unsupported", parseDocument(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), "old.doc").format === "unsupported");

// ── Word: table matrix + numbered narrative ──
const w = ex(SAMPLE.docxResponse(), "r.docx");
const sec1 = w.items.find(q => q.number === "SEC-1"), sec2 = w.items.find(q => q.number === "SEC-2"), sec3 = w.items.find(q => q.number === "SEC-3"), wc = w.items.find(q => /WCAG/.test(q.text));
check("Word table: question, answer and requirement number from a labelled matrix", sec1?.answer?.text.startsWith("Yes. The example platform") && sec1.status === "extracted");
check("Word table citation names table, row, column and section", locLabel(sec1.answer.loc) === 'Word table 1, row 2, column 3 (section "3.1 Security")', locLabel(sec1.answer.loc));
check("an empty response cell is unanswered, never filled in", sec2?.answer === null && sec2.answerStatus === "unanswered");
check("the same question twice in one document is a duplicate", sec3?.duplicateOfSeq === sec1.seq);
check("numbered narrative question with a labelled Response: answer", wc?.number === "1" && wc.answer?.text === "The example user interface targets WCAG 2.1 AA; a VPAT is available on request." && wc.status === "extracted");
check("narrative answers follow the question only in response documents", ex(SAMPLE.docxResponse(), "r.docx", "solicitation").items.every(q => !q.answer));
const unlabeled = ex(docx([{ p: "Describe your backup approach?", num: true }, { p: "Nightly snapshots are kept for 30 days." }]), "u.docx");
check("an unlabelled following paragraph is only a candidate answer (needs_review)", unlabeled.items[0]?.answer && unlabeled.items[0].status === "needs_review" && unlabeled.items[0].answerStatus === "needs_review");

// ── Excel: multi-row header, merged banner, X marks, priority column, section rows ──
const j = xlsx({ Standards: [
  ["Control", "", "Control Name", "Phase 1 Bid Response", "", "", ""],
  ["", "", "", "Requirement Managed by", "", "Describe how Control is Met.", "Priority"],
  ["", "", "", "Agency", "Vendor", "Description", ""],
  ["AC", "", "", "", "", "", ""],
  ["AC-1", "", "Access Control Policy and Procedures", "", "X", "The example vendor maintains an access control policy reviewed yearly.", "Must Have"],
  ["", "AC-2(1)", "AUTOMATED ACCOUNT MANAGEMENT", "X", "X", "Accounts are provisioned from the agency directory.", "Nice To Have"],
  ["AC-3", "", "Access Enforcement", "", "X", "", "Must Have"],
] }, { Standards: ["D1:G1", "D2:E2"] });
const jx = ex(j, "j.xlsx");
const ac1 = jx.items.find(q => q.number === "AC-1"), ac21 = jx.items.find(q => q.number === "AC-2(1)"), ac3 = jx.items.find(q => q.number === "AC-3");
check("spreadsheet: control ID columns, question column under a multi-row header", jx.items.length === 3 && ac1?.text === "Access Control Policy and Procedures" && ac21?.text === "AUTOMATED ACCOUNT MANAGEMENT", jx.notes.join(" | "));
check("spreadsheet answer cited to its exact cell", ac1?.answer?.text === "The example vendor maintains an access control policy reviewed yearly." && locLabel(ac1.answer.loc) === 'Worksheet "Standards", cell F5', ac1 && locLabel(ac1.answer?.loc || {}));
check("X marks read as compliance under their merged banner", ac21?.answer?.compliance === "Requirement Managed by: Agency; Requirement Managed by: Vendor", ac21?.answer?.compliance);
check("priority column sets the requirement level", ac1?.level === "mandatory" && ac21?.level === "optional" && /Priority/.test(ac1.levelBasis));
check("a lone label row becomes the section", ac1?.section === "AC", ac1?.section);
check("NIST control families map to categories", ac1?.category === "authn-authz");
check("compliance marks without a written answer still count as an answer, kept as compliance", ac3?.answer?.compliance === "Requirement Managed by: Vendor" || ac3?.answerStatus === "answered", JSON.stringify(ac3?.answer));
const noHeader = ex(xlsx({ S: [["What is your uptime commitment?", "99.9% monthly for the example service."], ["Do you support MFA?", "Yes, TOTP and WebAuthn."]] }), "n.xlsx");
check("no header row: question/answer pairing inferred, so every row needs review", noHeader.items.length === 2 && noHeader.items.every(q => q.status === "needs_review" && q.answerStatus === "needs_review"), JSON.stringify(noHeader.items.map(q => q.status)));
const instr = ex(xlsx({ Instructions: [["This tool helps agencies evaluate vendors."], ["o Complete column F for each control."], ["Reference links follow."]] }), "i.xlsx");
check("instruction sheets are not mistaken for questions", instr.items.length === 0);
const dd = ex(xlsx({ S: [["ID", "Requirement", "Prioritization", "How are you able to offer this?", "Vendor Notes"], ...Array.from({ length: 12 }, (_, i) => [`GF-${i + 1}`, `Support example capability number ${i + 1} for the agency`, "Must Have", i % 2 ? "Included in default offering" : "Available through customization", i === 3 ? "" : `Notes ${i + 1}: explained in detail.`])] }), "d.xlsx");
check("dropdown answer column is compliance; free text is the answer", dd.items[0].answer.text === "Notes 1: explained in detail." && /How are you able to offer this\?: Available through customization/.test(dd.items[0].answer.compliance), JSON.stringify(dd.items[0].answer));
check("a row with only a dropdown choice keeps it as the answer text", dd.items[3].answer?.text === "Included in default offering", JSON.stringify(dd.items[3].answer));

// ── CSV and text ──
const csv = ex(Buffer.from('ID,Question,Answer\r\n1,"Do you encrypt data at rest?","Yes, ""AES-256""."\r\n2,Describe your SLA for support?,\r\n'), "q.csv");
check("CSV with quoted cells; cell citations", csv.items[0]?.answer?.text === 'Yes, "AES-256".' && locLabel(csv.items[0].answer.loc) === "CSV row 2, column C (cell C2)" && csv.items[1].answerStatus === "unanswered", JSON.stringify(csv.items.map(q => q.answer)));
const txt = ex(Buffer.from("Section 2 Security\n2.1 Do you support SSO?\nAnswer: Yes, SAML 2.0.\n2.2 Describe your patching process?\n"), "q.txt");
check("plain text numbered questions with Answer: labels and line citations", txt.items.length === 2 && txt.items[0].answer?.text === "Yes, SAML 2.0." && locLabel(txt.items[0].answer.loc) === "Line 3" && txt.items[1].answerStatus === "unanswered");

// ── PDF ──
const p = parseDocument(SAMPLE.pdfRfp(), "r.pdf");
check("PDF text by page and line", p.pages === 2 && p.blocks.some(b => b.text === "4.3 The solution shall provide a REST API for integrations." && b.loc.page === 2 && b.loc.line === 1));
const a85 = (() => { // the same PDF with its content streams wrapped in ASCII85 (as ReportLab writes them)
  const enc = (buf) => { let out = ""; for (let i = 0; i < buf.length; i += 4) { const ch = buf.slice(i, i + 4); const pad = 4 - ch.length; const b = Buffer.concat([ch, Buffer.alloc(pad)]); let v = b.readUInt32BE(0); if (!v && !pad) { out += "z"; continue; } const d = []; for (let k = 0; k < 5; k++) { d.unshift(String.fromCharCode(33 + (v % 85))); v = Math.floor(v / 85); } out += d.join("").slice(0, 5 - pad); } return out + "~>"; };
  const content = zlib.deflateSync(Buffer.from("BT /F1 11 Tf 72 700 Td (Q1. Describe your release cadence?) Tj ET", "latin1"));
  const body = enc(content);
  const objs = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${body.length} /Filter [/ASCII85Decode /FlateDecode] >>\nstream\n${body}\nendstream`, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`];
  return Buffer.from(`%PDF-1.4\n${objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join("")}trailer\n<< /Root 1 0 R >>\n%%EOF`, "latin1");
})();
check("PDF content streams with ASCII85 + Flate filters", parseDocument(a85, "a.pdf").blocks[0]?.text === "Q1. Describe your release cadence?", JSON.stringify(parseDocument(a85, "a.pdf").blocks));
const scanned = parseDocument(pdf([["Cover page"]], { scannedPage: true }), "s.pdf");
check("scanned pages are reported (no OCR, no guessing)", scanned.scannedPages === 1 && /scanned/i.test(scanned.warnings.join(" ")));
check("an encrypted PDF is refused with instructions", /encrypted/i.test(parseDocument(Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R /Encrypt 2 0 R >>"), "e.pdf").warnings.join(" ")));
const pq = ex(SAMPLE.pdfRfp(), "r.pdf", "solicitation");
check("PDF solicitation: numbered questions with page/line citations and no answers", pq.items.length === 4 && pq.items.every(q => !q.answer) && pq.items[0].number === "4.1" && locLabel(pq.items[0].loc) === "PDF page 1, line 3");
check("shall/must wording marks a requirement mandatory, with its basis", pq.items[2].level === "mandatory" && pq.items[2].levelBasis === "wording: shall/must");

// ── citations ──
const wd = parseDocument(SAMPLE.docxResponse(), "r.docx");
check("verifyCitation: exact text at its location passes", verifyCitation(wd, sec1.answer.loc, sec1.answer.text));
check("verifyCitation: other text at that location fails", !verifyCitation(wd, sec1.answer.loc, "No, it does not."));
check("locate finds a pasted passage's exact location", locLabel(locate(wd, "a VPAT is available on request")) === 'Word paragraph 5 (section "3.2 Accessibility")');
check("locate refuses text the document does not contain", locate(wd, "We are FedRAMP High authorized") === null);

// ── similarity & categories ──
check("SSO wording variants are related (synonym groups)", similarity("Does the system support SAML authentication?", "Describe your single sign-on capabilities with our identity provider.") >= 0.35);
check("unrelated questions are not", similarity("Does the system support SAML authentication?", "What training options are provided?") < 0.15);
check("identical meaning scores high", similarity("Is customer data encrypted at rest?", "Is data at rest encrypted for customers?") >= 0.8);
check("tokens drop filler words and keep the subject", tokens("Please describe how the vendor solution supports backups").includes("§3"));
const cats = [["Do you hold a SOC 2 Type II report?", "compliance-certifications"], ["Describe your disaster recovery RPO and RTO.", "backup-dr"], ["Is the product WCAG 2.1 AA conformant?", "accessibility"],
  ["Provide three customer references.", "customer-references"], ["Describe your pricing and licensing model.", "pricing-licensing"], ["Does the platform include AI or machine learning features?", "ai-capabilities"],
  ["Describe your REST API.", "integrations-apis"], ["What is your guaranteed uptime?", "high-availability"], ["Describe your data retention and privacy practices.", "data-management-privacy"]];
for (const [q, c] of cats) check(`category: ${q}`, classify(q).category === c, classify(q).category);
check("priority values read as levels", levelFromValue("Must Have") === "mandatory" && levelFromValue("Nice To Have") === "optional" && levelFromValue("M") === "mandatory" && levelFromValue("Included") === "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
