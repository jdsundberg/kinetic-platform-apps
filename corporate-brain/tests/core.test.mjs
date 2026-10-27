// Unit tests for critical pure logic: identifiers, truth model, extraction, record validation.
//   node --test apps/corporate-brain/tests/core.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { sourceIdFor, nameKey, reviewTransition, newKnowledgeValues, parseDateMention, parseList, linkContradiction, salesVerifyError } from "../lib/core.mjs";
import { extractCandidates, classifyDocument } from "../lib/extract.mjs";
import { validateRecord, SHARED_DOMAIN } from "../lib/ingest.mjs";
import { structuredQuery } from "../lib/retrieval.mjs";

test("source identity is deterministic and case-safe", () => {
  assert.equal(sourceIdFor("gmail", "AbC"), sourceIdFor("gmail", "AbC"));
  assert.notEqual(sourceIdFor("gmail", "AbC"), sourceIdFor("gmail", "abc"), "case-sensitive IDs must not collide in a case-insensitive unique index");
  assert.notEqual(sourceIdFor("gmail", "x"), sourceIdFor("google-drive", "x"));
  assert.match(sourceIdFor("github", "r@1"), /^SR-[0-9A-F]{20}$/);
  assert.throws(() => sourceIdFor("", "x"));
});

test("name keys normalize legal suffixes, accents and punctuation", () => {
  assert.equal(nameKey("Vattenfall AB"), "vattenfall");
  assert.equal(nameKey("Schneider Electric SE."), "schneider electric se");
  assert.equal(nameKey("Nestlé S.A."), "nestle s a");
});

const entry = (over = {}) => ({ "Knowledge Type": "fact", "Review Status": "proposed", "Supporting Source IDs": '["SR-1"]', "Review History": "[]", ...over });

test("new knowledge always starts proposed, whoever creates it", () => {
  const v = newKnowledgeValues({ knowledgeType: "fact", title: "T", statement: "S", sourceIds: ["SR-1"], modelConfidence: 0.99 }, { actor: "agent-x", actorType: "agent" });
  assert.equal(v["Review Status"], "proposed");
  assert.equal(v["Model Confidence"], "0.99");
  assert.equal(v["Verified By"], undefined);
  assert.throws(() => newKnowledgeValues({ knowledgeType: "fact", title: "", statement: "S" }, { actor: "u" }));
});

test("only a human reviewer can verify; AI confidence never does", () => {
  assert.equal(reviewTransition(entry({ "Model Confidence": "1.0" }), "approve", { reviewer: "bot", actorType: "agent" }).ok, false);
  assert.equal(reviewTransition(entry(), "approve", { reviewer: "jane", actorType: "connector" }).ok, false);
  const ok = reviewTransition(entry(), "approve", { reviewer: "jane", actorType: "user", now: "2026-01-01T00:00:00Z" });
  assert.equal(ok.ok, true);
  assert.equal(ok.values["Review Status"], "verified");
  assert.equal(ok.values["Verified By"], "jane");
  assert.equal(JSON.parse(ok.values["Review History"]).at(-1).action, "approve");
});

test("facts need evidence to be verified; recollections and claims are evidence themselves", () => {
  assert.equal(reviewTransition(entry({ "Supporting Source IDs": "[]" }), "approve", { reviewer: "jane" }).ok, false);
  assert.equal(reviewTransition(entry({ "Knowledge Type": "narrative", "Supporting Source IDs": "" }), "approve", { reviewer: "jane" }).ok, false);
  assert.equal(reviewTransition(entry({ "Knowledge Type": "recollection", "Supporting Source IDs": "[]" }), "approve", { reviewer: "jane" }).ok, true);
});

test("review state machine rejects illegal transitions and requires reasons", () => {
  assert.equal(reviewTransition(entry({ "Review Status": "superseded" }), "approve", { reviewer: "j" }).ok, false);
  assert.equal(reviewTransition(entry({ "Review Status": "verified" }), "reject", { reviewer: "j", comment: "x" }).ok, false, "verified history is disputed or superseded, not rejected");
  assert.equal(reviewTransition(entry(), "reject", { reviewer: "j" }).ok, false, "comment required");
  assert.equal(reviewTransition(entry(), "dispute", { reviewer: "j", comment: "conflicts with SR-9" }).values["Review Status"], "disputed");
  assert.equal(reviewTransition(entry(), "supersede", { reviewer: "j" }).ok, false, "needs replacement id");
  assert.equal(reviewTransition(entry(), "nonsense", { reviewer: "j" }).ok, false);
  assert.equal(reviewTransition(entry(), "approve", {}).ok, false, "named reviewer required");
});

test("un-verifying clears the verifier", () => {
  const t = reviewTransition(entry({ "Review Status": "verified", "Verified By": "jane" }), "dispute", { reviewer: "bob", comment: "new contract found" });
  assert.equal(t.values["Verified By"], "");
  assert.equal(t.from, "verified");
});

test("contradictions are linked both ways and nothing is overwritten", () => {
  const l = linkContradiction({ "Knowledge ID": "KN-A", Contradicts: "[]" }, { "Knowledge ID": "KN-B", Contradicts: '["KN-C"]' });
  assert.deepEqual(JSON.parse(l.a), ["KN-B"]);
  assert.deepEqual(JSON.parse(l.b), ["KN-C", "KN-A"]);
});

test("dates are only parsed when literally present, with honest precision", () => {
  assert.deepEqual(parseDateMention("License Agreement - TERM - 28FEB18.docx"), { date: "2018-02-28", precision: "exact" });
  assert.deepEqual(parseDateMention("2025.03.18_Vattenfall Checkin"), { date: "2025-03-18", precision: "exact" });
  assert.deepEqual(parseDateMention("September 2022 - Vattenfall"), { date: "2022-09", precision: "month" });
  assert.deepEqual(parseDateMention("2024 - EULA"), { date: "2024", precision: "year" });
  assert.equal(parseDateMention("Vattenfall Proposal"), null);
});

test("extraction proposes contract facts/events only with a company, and never verifies", () => {
  const co = { "Company ID": "CO-1", Name: "Vattenfall" };
  const r = extractCandidates({ system: "google-drive", title: "Kinetic Data License Agreement - Vattenfall - TERM - 28FEB18.docx", date: "2018-02-28" }, { companies: [co], people: [], sourceId: "SR-X" });
  assert.equal(r.knowledge.length, 1);
  assert.equal(r.knowledge[0].knowledgeType, "fact");
  assert.deepEqual(r.knowledge[0].sourceIds, ["SR-X"]);
  assert.match(r.knowledge[0].statement, /terms have not been reviewed/);
  assert.equal(r.events[0].precision, "exact");
  const noDate = extractCandidates({ system: "google-drive", title: "2019PO Vattenfall 4500613244.pdf", date: "2019-01-08" }, { companies: [co], people: [], sourceId: "SR-Y" });
  assert.equal(noDate.events[0].precision, "approximate", "storage dates are approximate");
  assert.equal(extractCandidates({ system: "google-drive", title: "License Agreement" }, { companies: [], people: [], sourceId: "SR-Z" }).knowledge.length, 0);
  assert.equal(classifyDocument("Random spreadsheet"), null);
  assert.equal(extractCandidates({ system: "gmail", sourceType: "label", title: "Companies/Staples RFP" }, { companies: [co], people: [], sourceId: "SR-L" }).knowledge.length, 0, "labels are folders, not documents");
});

test("ingestion record validation refuses whole documents and unknown systems", () => {
  assert.deepEqual(validateRecord({ system: "gmail", originalId: "1", title: "x" }), []);
  assert.ok(validateRecord({ system: "dropbox", originalId: "1", title: "x" }).length);
  assert.ok(validateRecord({ system: "gmail", title: "x" }).length);
  assert.ok(validateRecord({ system: "gmail", originalId: "1", title: "x", excerpt: "a".repeat(5000) }).length);
  assert.deepEqual(validateRecord({ system: "gmail", originalId: "1", deleted: true }), []);
});

test("shared government domains never identify one organization", () => {
  for (const d of ["army.mil", "us.army.mil", "ng.army.mil", "mail.mil"]) assert.ok(SHARED_DOMAIN.test(d), d);
  for (const d of ["armymil.com", "kineticdata.com", "frb.org"]) assert.equal(SHARED_DOMAIN.test(d), false, d);
});

test("structured search only uses indexed filters", () => {
  assert.equal(structuredQuery("knowledge", { companyId: "CO-1", status: "verified" }), 'values[Company ID] = "CO-1" AND values[Review Status] = "verified"');
  assert.equal(structuredQuery("company", { status: "Customer" }), "");
  assert.equal(structuredQuery("event", { companyId: 'x"y' }), 'values[Company ID] = "x\\"y"');
});

test("list values round-trip", () => {
  assert.deepEqual(parseList('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseList("a, b"), ["a", "b"]);
  assert.deepEqual(parseList(""), []);
});

test("sales lens: a principle needs two linked deals and evidence before it can be verified", () => {
  assert.match(salesVerifyError("principle", { "Deal IDs": "[]" }), /at least 2 linked deals/);
  assert.match(salesVerifyError("principle", { "Deal IDs": '["DL-1"]' }), /it has 1/);
  assert.equal(salesVerifyError("principle", { "Deal IDs": '["DL-1","DL-2"]' }), "");
  assert.equal(salesVerifyError("deal", {}), "", "only principles carry the two-deal rule");
  const noEvidence = reviewTransition(entry({ "Knowledge Type": "principle", "Supporting Source IDs": "[]" }), "approve", { reviewer: "john" });
  assert.equal(noEvidence.ok, false, "sales records need a supporting source like facts do");
  const v = newKnowledgeValues({ knowledgeType: "deal", title: "Deal: X", statement: "S", lens: "sales" }, { actor: "john" });
  assert.equal(v.Lens, "sales");
  assert.equal(v["Review Status"], "proposed");
});
