// RFP Intelligence API tests against a live Kinetic space (drives server.mjs through the launcher's helper contract).
//   KINETIC_URL=… KINETIC_USER=<admin> KINETIC_PASS=… node apps/corporate-brain/tests/rfp-api.test.mjs
// Uses only synthetic, clearly fictional documents ("Example Agency", tests/fixtures.mjs). Everything it creates —
// RFP rows, attachments, canonical questions, approved answers, knowledge entries, analyses, jobs, sources and the
// two temporary users — is removed at the end. (Audit rows stay: the audit log is append-only.)
import crypto from "crypto";
import { call, basic, kineticRequest } from "./harness.mjs";
import { SAMPLE, docx, pdf, xlsx } from "./fixtures.mjs";

const stamp = Date.now().toString(36).toUpperCase();
const ADMIN = basic();
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${name}${extra && !ok ? " — " + extra : ""}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b64 = (buf) => buf.toString("base64");
const created = { rfps: [], canonical: [], approved: [], knowledge: [], analyses: [], users: [] };

async function cleanup() {
  const del = async (form, q) => {
    for (let i = 0; i < 60; i++) {
      const r = await kineticRequest("GET", `/kapps/corporate-brain/forms/${form}/submissions?limit=25&q=${encodeURIComponent(q)}`, null, ADMIN);
      const subs = r.data.submissions || []; if (!subs.length) break;
      for (const s of subs) await kineticRequest("DELETE", `/submissions/${s.id}`, null, ADMIN);
    }
  };
  for (const id of created.analyses) { await del("rfp-analysis-items", `values[Analysis ID] = "${id}"`); await del("rfp-analyses", `values[Analysis ID] = "${id}"`); }
  for (const id of created.approved) await del("approved-answers", `values[Approved Answer ID] = "${id}"`);
  for (const id of created.knowledge) await del("knowledge-entries", `values[Knowledge ID] = "${id}"`);
  for (const id of created.canonical) await del("canonical-questions", `values[Canonical Question ID] = "${id}"`);
  for (const id of created.rfps) {
    const docs = (await kineticRequest("GET", `/kapps/corporate-brain/forms/rfp-documents/submissions?limit=25&include=values&q=${encodeURIComponent(`values[RFP Source ID] = "${id}"`)}`, null, ADMIN)).data.submissions || [];
    for (const d of docs) {
      const job = d.values["Import Job ID"];
      if (job) { await del("knowledge-entries", `values[Job ID] = "${job}"`); await del("sources", `values[Ingest Job ID] = "${job}"`); await del("research-jobs", `values[Job ID] = "${job}"`); }
      await del("relationships", `values[From ID] = "${d.values["Source ID"]}"`);
    }
    for (const f of ["rfp-answers", "rfp-questions", "rfp-documents", "rfp-sources"]) await del(f, `values[RFP Source ID] = "${id}"`);
  }
  for (const u of created.users) await kineticRequest("DELETE", `/users/${encodeURIComponent(u)}`, null, ADMIN);
}
async function waitFor(fn, what, ms = 120000) {
  const t0 = Date.now();
  for (;;) { const r = await fn(); if (r) return r; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(1500); }
}
const docRows = async (id, auth = ADMIN) => (await call("GET", `/rfp/documents/${id}`, null, { auth })).body;
const settled = (id) => waitFor(async () => { const d = await docRows(id); return ["extracted", "partial", "failed", "confirmed"].includes(d.document?.["Extraction Status"]) ? d : null; }, `extraction of ${id}`);

try {
  const meta = await call("GET", "/rfp/meta");
  check("meta lists the 20 initial categories and documents match strength", meta.body.categories?.length === 20 && meta.body.strength?.length === 3);

  // ── an RFP, unknown facts stay unknown ──
  const bad = await call("POST", "/rfp/sources", { values: { "Opportunity Name": `TEST RFP ${stamp}`, "Opportunity Status": "won" } });
  check("an outcome without a basis is refused (never inferred)", bad.status === 400);
  const src = await call("POST", "/rfp/sources", { values: { "Opportunity Name": `TEST RFP ${stamp}`, "Customer Name": `Example Agency ${stamp}`, "Solicitation Number": `EX-${stamp}`, "Procurement Type": "questionnaire", "Received At": "2026-01" } });
  check("create an RFP source", src.status === 201, JSON.stringify(src.body).slice(0, 200));
  const RFP = src.body.item["RFP Source ID"]; created.rfps.push(RFP);
  check("submission date and outcome default to unknown", !src.body.item["Submitted At"] && src.body.item["Opportunity Status"] === "unknown");

  // ── import a Word response document ──
  const docxBuf = SAMPLE.docxResponse();
  const imp = await call("POST", "/rfp/import", { rfpId: RFP, role: "response", documentDate: "2026-02-10", file: { name: "Example Security Response.docx", base64: b64(docxBuf) } }, { agent: "" });
  check("import registers the document and its Corporate Brain source", imp.status === 201 && !!imp.body.document?.["Source ID"] && imp.body.started === true, JSON.stringify(imp.body).slice(0, 300));
  const DOC1 = imp.body.document["Document ID"];
  check("the original file is stored as a Kinetic attachment", Array.isArray(imp.body.document["Original File"]) && imp.body.document["Original File"][0]?.name === "Example Security Response.docx", JSON.stringify(imp.body.document["Original File"]));
  const again = await call("POST", "/rfp/import", { rfpId: RFP, role: "response", file: { name: "Example Security Response.docx", base64: b64(docxBuf) } });
  check("re-importing the same file creates nothing (idempotent)", again.status === 201 && again.body.duplicate === true && again.body.document["Document ID"] === DOC1);

  const d1 = await settled(DOC1);
  check("extraction finished", d1.document["Extraction Status"] === "extracted", d1.document["Extraction Status"] + " " + d1.document["Extraction Notes"]);
  const byNum = (rows, n) => rows.find(r => r.question["Question Number"] === n);
  const sec1 = byNum(d1.rows, "SEC-1"), sec2 = byNum(d1.rows, "SEC-2"), sec3 = byNum(d1.rows, "SEC-3");
  check("four questions extracted in document order", d1.rows.length === 4 && d1.rows.map(r => r.question.Sequence).join() === "00001,00002,00003,00004", d1.rows.map(r => r.question["Question Number"]).join());
  check("question text is exact", sec1?.question["Question Text Original"] === "Does the system support SAML 2.0 single sign-on?");
  check("answer text is exact and cited to its table cell", sec1?.answers[0]?.["Answer Text Original"] === "Yes. The example platform supports SAML 2.0 with any compliant identity provider." && /Word table 1, row 2, column 3/.test(sec1.answers[0]["Location Label"]), sec1?.answers[0]?.["Location Label"]);
  check("every extracted citation was verified against the document", d1.rows.every(r => r.question["Citation Verified"] === "yes") && d1.rows.every(r => r.answers.every(a => a["Citation Verified"] === "yes")));
  check("a question with no answer is unanswered — nothing is invented", sec2?.question["Answer Status"] === "unanswered" && sec2.answers.length === 0);
  check("the repeated question is flagged as a duplicate", sec3?.question["Possible Duplicate Of"] === sec1?.question["Question ID"]);
  check("the labelled narrative answer was extracted with its paragraph", d1.rows[3]?.answers[0]?.["Location Label"]?.startsWith("Word paragraph 5"), d1.rows[3]?.answers[0]?.["Location Label"]);
  check("the answer date is the document date supplied at import, not guessed", sec1.answers[0]["Answer Date"] === "2026-02-10");
  check("categories are suggested (rule-based) and marked as suggestions", sec1.question.Category === "authn-authz" && sec1.question["Category Source"] === "rule-suggested");
  const file = await call("GET", `/rfp/documents/${DOC1}/file`);
  check("the cited original can be opened from the app", file.status === 200 || file.status === undefined);

  // ── spreadsheet + PDF in the same RFP ──
  const xl = await call("POST", "/rfp/import", { rfpId: RFP, role: "response", file: { name: "Example Questionnaire.xlsx", base64: b64(SAMPLE.xlsxQuestionnaire()) } });
  const dx = await settled(xl.body.document["Document ID"]);
  const enc = dx.rows.find(r => /encrypted in transit/.test(r.question["Question Text Original"]));
  check("spreadsheet rows extracted with worksheet cell citations", dx.rows.length === 3 && enc?.question["Location Label"] === 'Worksheet "Security", cell B4' && enc.answers[0]?.["Location Label"] === 'Worksheet "Security", cell D4', enc?.answers[0]?.["Location Label"]);
  check("spreadsheet compliance column kept beside the answer", enc?.answers[0]?.Compliance === "Response: Yes", enc?.answers[0]?.Compliance);
  const pd = await call("POST", "/rfp/import", { rfpId: RFP, role: "solicitation", file: { name: "Example RFP.pdf", base64: b64(SAMPLE.pdfRfp()) } });
  const dp = await settled(pd.body.document["Document ID"]);
  check("PDF questions extracted with page and line citations, no answers from a solicitation", dp.rows.length === 4 && dp.rows[0].question["Location Label"] === "PDF page 1, line 3" && dp.rows.every(r => !r.answers.length), dp.rows.map(r => r.question["Location Label"]).join(" | "));
  check("explicit requirement wording sets the requirement level", dp.rows.find(r => /REST API/.test(r.question["Question Text Original"]))?.question["Requirement Level"] === "mandatory");
  const scan = await call("POST", "/rfp/import", { rfpId: RFP, role: "solicitation", file: { name: "Scanned.pdf", base64: b64(pdf([], { scannedPage: true })) } });
  check("a scanned PDF is stored but clearly reported as unsupported", scan.body.unsupported === true && /scanned/i.test((scan.body.warnings || []).join(" ")), JSON.stringify(scan.body.warnings));

  // ── a revised document keeps both versions ──
  const rev = docx([{ h: 2, text: "3.1 Security" }, { table: [["Req #", "Requirement", "Vendor Response"],
    ["SEC-1", "Does the system support SAML 2.0 single sign-on?", "Yes. SAML 2.0 and OpenID Connect are supported."],
    ["SEC-2", "Describe how data is encrypted at rest.", "AES-256 for the example datastore."]] }]);
  const r2 = await call("POST", "/rfp/import", { rfpId: RFP, role: "response", file: { name: "Example Security Response v2.docx", base64: b64(rev) } });
  check("a revised file becomes revision 2 and points at revision 1", r2.body.document?.Revision === "2" && r2.body.document["Supersedes Document ID"] === DOC1, `${r2.body.document?.Revision} ${r2.body.document?.["Supersedes Document ID"]}`);
  const DOC2 = r2.body.document["Document ID"];
  await settled(DOC2);
  const q1 = await call("GET", `/rfp/questions/${sec1.question["Question ID"]}`);
  check("the revision's answer joined the same question; both answers kept", q1.body.answers.length === 2 && q1.body.answers.some(a => a["Document ID"] === DOC2 && a["Revision Of"] === sec1.answers[0]["Answer ID"]), q1.body.answers.map(a => a["Document ID"] + ":" + a["Revision Of"]).join());

  // ── review & confirm ──
  const conf = await call("POST", `/rfp/documents/${DOC1}/confirm`, { all: true });
  check("confirm re-checks citations against the original and confirms", conf.status === 200 && conf.body.confirmed === 4 && !conf.body.refused.length, JSON.stringify(conf.body));
  const after = await docRows(DOC1);
  const a1 = byNum(after.rows, "SEC-1").answers.find(a => a["Document ID"] === DOC1);
  check("confirmed answer records who confirmed it", a1["Answer Status"] === "confirmed" && !!a1["Confirmed By"]);
  const edit = await call("POST", `/rfp/questions/${sec1.question["Question ID"]}`, { action: "set-answer", text: "anything" });
  check("a confirmed row cannot be re-associated", edit.status === 409);
  const direct = await call("PUT", `/entities/rfp-answers/${a1._id}`, { values: { "Answer Text Original": "rewritten" } });
  check("the generic entity API cannot rewrite a historical answer", direct.status === 400);
  const badFix = await call("POST", `/rfp/answers/${a1["Answer ID"]}/correct`, { text: "Text that is not in the document", note: "typo" });
  check("a correction must be text found in the original document", badFix.status === 400);
  const fix = await call("POST", `/rfp/answers/${a1["Answer ID"]}/correct`, { text: "The example platform supports SAML 2.0 with any compliant identity provider.", note: "trim the leading Yes" });
  const q1b = await call("GET", `/rfp/questions/${sec1.question["Question ID"]}`);
  const old = q1b.body.answers.find(a => a["Answer ID"] === a1["Answer ID"]);
  check("a correction is a new confirmed revision; the original is kept as corrected", fix.status === 200 && old["Answer Status"] === "corrected" && old["Answer Text Original"] === a1["Answer Text Original"] && q1b.body.answers.some(a => a["Answer ID"] === fix.body.answerId && a["Revision Of"] === a1["Answer ID"]));
  // an unconfirmed row: reject a non-question, re-point an answer
  const enc2 = (await docRows(xl.body.document["Document ID"])).rows.find(r => /backups/.test(r.question["Question Text Original"]));
  const setA = await call("POST", `/rfp/questions/${enc2.question["Question ID"]}`, { action: "set-answer", text: "Retained for 30 days in the example environment." });
  check("a reviewer can re-associate an unconfirmed answer with text found in the document", setA.status === 200 && setA.body.location === 'Worksheet "Security", cell D6', JSON.stringify(setA.body).slice(0, 200));
  const setBad = await call("POST", `/rfp/questions/${enc2.question["Question ID"]}`, { action: "set-answer", text: "We back up hourly." });
  check("…but not with text that is not in the document", setBad.status === 400);

  // ── search ──
  await sleep(500);
  const s1 = await call("GET", `/rfp/search?q=${encodeURIComponent("SAML single sign-on")}&rfpId=${RFP}`);
  const top = s1.body.hits?.[0];
  check("search finds the historical question with answer, RFP, customer and citation", top && /SAML/.test(top.text) && !!top.answerPreview && top.rfp === `TEST RFP ${stamp}` && top.customer === `Example Agency ${stamp}` && /Word table 1/.test(top.location), JSON.stringify(top).slice(0, 300));
  check("search results are labelled historical evidence with a match strength", top?.contentClass === "historical-evidence" && top.strength === "strong");
  const s2 = await call("GET", `/rfp/search?q=${encodeURIComponent("identity provider integration")}&category=authn-authz&rfpId=${RFP}`);
  check("search by meaning-related words and category filter", s2.body.hits?.length >= 1 && s2.body.hits.every(h => h.category === "authn-authz"), JSON.stringify(s2.body.hits?.map(h => h.category)));

  // ── canonical questions & approved answers ──
  const canon = await call("POST", "/rfp/canonical", { text: `Does the solution support SAML single sign-on? (${stamp})`, questionIds: [sec1.question["Question ID"], sec3.question["Question ID"]] });
  const CQ = canon.body.item["Canonical Question ID"]; created.canonical.push(CQ);
  const grouped = await call("GET", `/rfp/questions?canonical=${CQ}`);
  check("related questions grouped under one canonical question, original wording kept", grouped.body.items.length === 2 && grouped.body.items.every(q => q["Question Text Original"] === "Does the system support SAML 2.0 single sign-on?"));
  const unconfirmedPromote = await call("POST", "/rfp/approved/promote", { answerId: (await docRows(DOC2)).rows[0].answers.find(a => a["Document ID"] === DOC2)?.["Answer ID"] });
  check("an unconfirmed historical answer cannot be promoted", unconfirmedPromote.status === 409);
  const prom = await call("POST", "/rfp/approved/promote", { answerId: fix.body.answerId });
  const AA = prom.body.item?.["Approved Answer ID"]; created.approved.push(AA);
  check("promote a confirmed historical answer to a draft approved answer with evidence", prom.status === 201 && prom.body.item["Approval Status"] === "draft" && prom.body.item["Canonical Question ID"] === CQ && JSON.parse(prom.body.item["Evidence References"])[0].answerId === fix.body.answerId);
  check("an authentication answer is marked sensitive", prom.body.item.Sensitive === "yes");
  const early = await call("POST", `/rfp/approved/${AA}/approve`, { comment: "ok", confirmSensitive: true });
  check("cannot approve before it is submitted for review", early.status === 409);
  await call("PUT", `/rfp/approved/${AA}`, { values: { "Product Versions": "Example 6.x", "Applicable Environments": "hosted", "Deployment Conditions": "Customer IdP must support SAML 2.0" } });
  const sub = await call("POST", `/rfp/approved/${AA}/submit`, {});
  check("submit for review", sub.body.item?.["Approval Status"] === "needs-review");
  const agentApprove = await call("POST", `/rfp/approved/${AA}/approve`, { comment: "ok", confirmSensitive: true }, { agent: "test-agent" });
  check("an agent can never approve", agentApprove.status === 403);
  const noConfirm = await call("POST", `/rfp/approved/${AA}/approve`, { comment: "ok" });
  check("a sensitive answer needs explicit confirmation", noConfirm.status === 400);
  const appr = await call("POST", `/rfp/approved/${AA}/approve`, { comment: "Checked against the current SSO docs", confirmSensitive: true });
  check("a reviewer approves; review date and approver recorded", appr.status === 200 && appr.body.item["Approval Status"] === "approved" && !!appr.body.item["Approved By"] && /^\d{4}-\d{2}-\d{2}$/.test(appr.body.item["Review Due At"]), JSON.stringify(appr.body).slice(0, 300));
  const KID = appr.body.item["Knowledge ID"]; created.knowledge.push(KID);
  const kn = await call("GET", `/knowledge/${KID}`);
  check("the approved answer is verified knowledge in the Brain (Lens rfp) with its sources", kn.body.entry?.["Review Status"] === "verified" && kn.body.entry.Lens === "rfp" && kn.body.sources.length >= 1);
  const editApproved = await call("PUT", `/rfp/approved/${AA}`, { values: { "Approved Answer": "changed" } });
  check("an approved answer is not edited in place", editApproved.status === 409);
  const det = await call("GET", `/rfp/approved/${AA}`);
  check("audit trail records draft → submit → approve", ["promote", "approval:submit", "approval:approve"].every(a => det.body.audit.some(x => x.Action === a)), det.body.audit.map(x => x.Action).join());
  const searchAgain = await call("GET", `/rfp/search?q=${encodeURIComponent("SAML single sign-on")}&rfpId=${RFP}`);
  check("search shows the current approved answer next to the historical one", searchAgain.body.hits?.[0]?.approved?.[0]?.id === AA && searchAgain.body.approved?.some(a => a.id === AA && a.contentClass === "current-approved"));

  // ── new RFP analysis ──
  const newRfp = pdf([["Example County RFP EX-NEW", "1. Does the solution support SAML 2.0 single sign-on?", "2. Describe your approach to quantum teleportation of tickets?"]]);
  const an = await call("POST", "/rfp/analyses", { title: `TEST analysis ${stamp}`, customer: "Example County", files: [{ name: "Example County RFP.pdf", base64: b64(newRfp) }] });
  check("start a new RFP analysis", an.status === 201, JSON.stringify(an.body).slice(0, 300));
  const AN = an.body.analysis["Analysis ID"]; created.analyses.push(AN); created.rfps.push(an.body.rfp["RFP Source ID"]);
  const res = await waitFor(async () => { const x = (await call("GET", `/rfp/analyses/${AN}`)).body; return ["ready", "failed"].includes(x.analysis.Status) ? x : null; }, "analysis");
  const it1 = res.items.find(x => /SAML/.test(x["Question Text Original"])), it2 = res.items.find(x => /teleportation/.test(x["Question Text Original"]));
  check("analysis keeps the RFP's numbering and order", res.items.map(x => x["Question Number"]).join() === "1,2", res.items.map(x => x["Question Number"]).join());
  check("a matching requirement gets the approved answer as a labelled AI draft with citations", it1?.["Draft Basis"] === "approved-answer" && it1["Content Class"] === "ai-generated-draft" && it1["Draft Answer"] === appr.body.item["Approved Answer"] && JSON.parse(it1.Citations).some(c => c.id === AA), JSON.stringify(it1).slice(0, 400));
  check("a requirement without evidence gets no draft and is flagged", it2 && !it2["Draft Answer"] && it2["Review Status"] === "needs-evidence" && it2["Draft Basis"] === "no-evidence");
  const acc = await call("POST", `/rfp/analysis-items/${it1["Analysis Item ID"]}/review`, { action: "accept" });
  check("a person accepts the draft", acc.body.item?.["Review Status"] === "accepted");
  const csv = await call("GET", `/rfp/analyses/${AN}/export.csv`);
  check("export the reviewed matrix (CSV)", csv.status === 200 || csv.status === undefined);

  // ── retrieval for other agents ──
  const ret = await call("GET", `/rfp/retrieve?q=${encodeURIComponent("SAML single sign-on")}&drafts=1`);
  const classes = new Set(ret.body.results.map(x => x.contentClass));
  check("shared retrieval distinguishes approved knowledge, historical evidence and AI drafts", classes.has("current-approved") && classes.has("historical-evidence") && classes.has("ai-generated-draft"), [...classes].join());

  // ── permissions with real non-admin users ──
  const pw = crypto.randomBytes(12).toString("base64url") + "a1!";
  for (const [u, team] of [[`cb-rfp-member-${stamp}`.toLowerCase(), "Corporate Brain::Members"], [`cb-rfp-outsider-${stamp}`.toLowerCase(), null]]) {
    const r = await kineticRequest("POST", "/users", { username: u, displayName: u, email: `${u}@example.invalid`, password: pw, enabled: true, spaceAdmin: false }, ADMIN);
    if (r.status < 300) created.users.push(u);
    if (team) await kineticRequest("POST", "/memberships", { team: { name: team }, user: { username: u } }, ADMIN);
  }
  const [MEMBER, OUTSIDER] = created.users.map(u => basic(u, pw));
  check("non-members are refused", (await call("GET", "/rfp/summary", null, { auth: OUTSIDER })).status === 403);
  const restrictedRfp = await call("POST", "/rfp/sources", { values: { "Opportunity Name": `TEST restricted RFP ${stamp}` }, restricted: true });
  created.rfps.push(restrictedRfp.body.item["RFP Source ID"]);
  const mList = await call("GET", "/rfp/sources?library=all", null, { auth: MEMBER });
  check("members see internal RFPs but not restricted ones", mList.status === 200 && mList.body.items.some(x => x["RFP Source ID"] === RFP) && !mList.body.items.some(x => x["Access Scope"] === "restricted"), `status ${mList.status}`);
  const mRestricted = await call("GET", `/rfp/sources/${restrictedRfp.body.item["RFP Source ID"]}`, null, { auth: MEMBER });
  check("a restricted RFP is not visible to a member (Kinetic policy)", mRestricted.status === 404);
  const mImportRestricted = await call("POST", "/rfp/import", { rfpId: restrictedRfp.body.item["RFP Source ID"], file: { name: "x.txt", base64: b64(Buffer.from("Q1. Is this restricted?")) } }, { auth: MEMBER });
  check("a member cannot import into a restricted RFP", mImportRestricted.status === 404 || mImportRestricted.status === 403);
  const mApprove = await call("POST", `/rfp/approved/${AA}/outdate`, { comment: "x" }, { auth: MEMBER });
  check("members cannot change approval status", mApprove.status === 403);
  const mSearch = await call("GET", `/rfp/search?q=SAML&rfpId=${RFP}`, null, { auth: MEMBER });
  check("members can search the internal library", mSearch.status === 200 && mSearch.body.hits.length >= 1);
  const mCoreAnswer = await kineticRequest("PUT", `/submissions/${a1._id}`, { values: { "Answer Text Original": "tampered" } }, MEMBER);
  check("members cannot change a confirmed historical answer through the Core API", mCoreAnswer.status === 403 || mCoreAnswer.status === 401, `status ${mCoreAnswer.status}`);

  // ── supersede ──
  const p2 = await call("POST", "/rfp/approved/promote", { answerId: fix.body.answerId, canonicalId: CQ, text: "The example platform supports SAML 2.0 and OpenID Connect." });
  const AA2 = p2.body.item["Approved Answer ID"]; created.approved.push(AA2);
  await call("PUT", `/rfp/approved/${AA2}`, { values: { Supersedes: AA } });
  await call("POST", `/rfp/approved/${AA2}/submit`, {});
  const appr2 = await call("POST", `/rfp/approved/${AA2}/approve`, { comment: "Adds OIDC", confirmSensitive: true });
  created.knowledge.push(appr2.body.item?.["Knowledge ID"]);
  const oldA = await call("GET", `/rfp/approved/${AA}`);
  check("approving a replacement supersedes the old approved answer (and its knowledge entry)", oldA.body.answer["Approval Status"] === "superseded" && oldA.body.answer["Superseded By"] === AA2 && oldA.body.knowledge?.["Review Status"] === "superseded",
    `${oldA.body.answer["Approval Status"]} ${oldA.body.knowledge?.["Review Status"]}`);
} catch (e) {
  fail++; console.log("✗ test run aborted:", e.stack);
} finally {
  await cleanup().catch(e => console.log("cleanup error:", e.message));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
