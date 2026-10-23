// Domain services over the Kinetic store: entity resolution, relationships, review, audit, dossiers.
import { kq } from "./store.mjs";
import { newId, nameKey, parseList, listValue, reviewTransition, newKnowledgeValues, sortableDate, linkContradiction } from "./core.mjs";
import { ENTITY_FORMS } from "../model.mjs";

// People and relationships keep a provenance sample, not every source they appear in: a busy person (e.g. the
// mailbox owner) would otherwise be rewritten by every ingested email — a write hot spot under parallel loads.
// The full link lives on each source's Person IDs / Company IDs.
const PROVENANCE_SAMPLE = 25;
const withProvenance = (current, add) => {
  const have = parseList(current);
  if (have.length >= PROVENANCE_SAMPLE) return null;
  const merged = listValue([...have, ...add].filter((x, i, a) => a.indexOf(x) === i).slice(0, PROVENANCE_SAMPLE));
  return merged === listValue(have) ? null : merged;
};

export function createServices(store, actor) {
  // actor: { username, type: "user" | "agent" | "connector", label }
  const who = actor.label || actor.username;

  async function audit(action, entityType, entityId, extra = {}) {
    try {
      await store.create("audit-log", {
        "Action": action, "Entity Type": entityType, "Entity ID": entityId, "Actor": who, "Actor Type": actor.type,
        "From Status": extra.from || "", "To Status": extra.to || "", "Comment": extra.comment || "",
        "Details": extra.details ? JSON.stringify(extra.details).slice(0, 4000) : "", "Occurred At": new Date().toISOString(),
      });
    } catch (e) { console.error("[corporate-brain] audit write failed:", e.message); }
  }

  // ── entity resolution (never by display name alone: Name Key / email / domain, and ambiguity is reported) ──
  async function findCompanies(name) {
    const key = nameKey(name);
    if (!key) return [];
    const r = await store.page("companies", { q: `values[Name Key] = ${kq(key)}` });
    return r.items.filter(c => c["Record Status"] !== "merged");
  }
  // Domain → companies, built once per services instance (one request / one ingest batch); Domain may list several.
  let domainIndex = null;
  const domainsOf = (c) => String(c.Domain || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  async function companiesByDomain(domain) {
    if (!domainIndex) {
      domainIndex = new Map();
      const all = await store.collect("companies", `values[Record Status] = "active"`, { maxPages: 40 });
      for (const c of all.items) for (const d of domainsOf(c)) domainIndex.set(d, [...(domainIndex.get(d) || []), c]);
    }
    return domainIndex.get(domain.toLowerCase()) || [];
  }
  async function resolveCompany({ name, domain, create = false, sourceIds = [] }) {
    let matches = name ? await findCompanies(name) : [];
    if (!matches.length && domain) matches = await companiesByDomain(domain);
    if (matches.length === 1) return { company: matches[0], created: false };
    if (matches.length > 1) return { company: matches[0], created: false, ambiguous: matches.map(m => m["Company ID"]) };
    if (!create || !name) return { company: null, created: false };
    const company = await store.create("companies", {
      "Name": name, "Name Key": nameKey(name), "Domain": domain || "", "Customer Status": "Unknown",
      "Customer Status Basis": "Not established by any source yet", "Record Status": "active",
      "Source IDs": listValue(sourceIds), "Created Via": actor.type,
    });
    await audit("create", "company", company["Company ID"], { details: { name, domain, sourceIds } });
    if (domainIndex) for (const d of domainsOf(company)) domainIndex.set(d, [...(domainIndex.get(d) || []), company]);
    return { company, created: true };
  }
  async function resolvePerson({ name, email, companyId, title, create = false, sourceIds = [] }) {
    let p = null;
    if (email) p = (await store.page("people", { q: `values[Email] = ${kq(email.toLowerCase())}` })).items[0] || null;
    if (!p && name) {
      const q = companyId ? `values[Primary Company ID] = ${kq(companyId)} AND values[Name Key] = ${kq(nameKey(name))}` : `values[Record Status] = "active" AND values[Name Key] = ${kq(nameKey(name))}`;
      const r = (await store.page("people", { q })).items;
      if (r.length === 1) p = r[0];
    }
    if (p) {
      const merged = withProvenance(p["Source IDs"], sourceIds);
      if (merged) await store.update(p._id, { "Source IDs": merged });
      return { person: p, created: false };
    }
    if (!create || !(name || email)) return { person: null, created: false };
    const person = await store.create("people", {
      "Full Name": name || email, "Name Key": nameKey(name || email), "Email": (email || "").toLowerCase(), "Primary Company ID": companyId || "",
      "Title": title || "", "Kinetic Relationship": "", "Record Status": "active", "Source IDs": listValue(sourceIds), "Created Via": actor.type,
    });
    await audit("create", "person", person["Person ID"], { details: { name, email, companyId, sourceIds } });
    if (companyId) await link("person", person["Person ID"], "company", companyId, "associated-with", { sourceIds });
    return { person, created: true };
  }

  // Idempotent typed link between two stable IDs.
  async function link(fromType, fromId, toType, toId, relType, { role = "", start = "", end = "", precision = "", sourceIds = [], notes = "" } = {}) {
    const ex = (await store.page("relationships", { q: `values[From ID] = ${kq(fromId)} AND values[Relationship Type] = ${kq(relType)}` })).items.find(r => r["To ID"] === toId);
    if (ex) {
      const merged = withProvenance(ex["Source IDs"], sourceIds);
      if (merged) await store.update(ex._id, { "Source IDs": merged });
      return ex;
    }
    return store.create("relationships", {
      "From Type": fromType, "From ID": fromId, "To Type": toType, "To ID": toId, "Relationship Type": relType, "Role": role,
      "Start Date": start, "End Date": end, "Date Precision": precision, "Notes": notes, "Record Status": "active",
      "Source IDs": listValue(sourceIds), "Created Via": actor.type,
    });
  }
  async function linksOf(id) {
    const [a, b] = await Promise.all([
      store.collect("relationships", `values[From ID] = ${kq(id)}`, { maxPages: 4 }),
      store.collect("relationships", `values[To ID] = ${kq(id)}`, { maxPages: 4 }),
    ]);
    return [...a.items, ...b.items].filter(r => r["Record Status"] !== "deleted");
  }

  // ── knowledge & review ──
  async function proposeKnowledge(input) {
    const values = newKnowledgeValues(input, { actor: who, actorType: actor.type });
    // every cited source must exist and be visible to the caller
    for (const sid of parseList(values["Supporting Source IDs"])) {
      if (!(await store.byId("sources", sid))) throw Object.assign(new Error(`Supporting source ${sid} not found or not visible`), { status: 400 });
    }
    const rec = await store.create("knowledge-entries", values);
    for (const otherId of parseList(values["Contradicts"])) {
      const other = await store.byId("knowledge-entries", otherId);
      if (!other) continue;
      const l = linkContradiction(values, other);
      // Members cannot edit reviewed entries (Kinetic policy). The new entry still records the
      // contradiction and the Contradiction Review workflow routes it; a reviewer sees both sides.
      try { await store.update(other._id, { "Contradicts": l.b }); }
      catch (e) { await audit("contradiction-backlink-pending", "knowledge", otherId, { comment: `Contradicted by ${values["Knowledge ID"]}; back-link needs a reviewer (${e.status || e.message})` }); }
    }
    await audit("propose", "knowledge", rec["Knowledge ID"], { to: "proposed", details: { type: values["Knowledge Type"], sources: parseList(values["Supporting Source IDs"]), method: values["Extraction Method"] } });
    return rec;
  }
  async function review(knowledgeId, action, { comment = "", supersededBy = "" } = {}) {
    const k = await store.byId("knowledge-entries", knowledgeId);
    if (!k) throw Object.assign(new Error("Knowledge entry not found"), { status: 404 });
    const t = reviewTransition(k, action, { reviewer: who, actorType: actor.type, comment, supersededBy });
    if (!t.ok) throw Object.assign(new Error(t.error), { status: 400 });
    const updated = await store.update(k._id, t.values);
    await audit(`review:${action}`, "knowledge", knowledgeId, { from: t.from, to: t.to, comment });
    // keep event/decision verification in step with the knowledge that backs them
    const ev = (await store.collect("historical-events", `values[Knowledge ID] = ${kq(knowledgeId)}`, { maxPages: 2 })).items;
    for (const e of ev) await store.update(e._id, { "Verification Status": t.to });
    return { entry: updated, from: t.from, to: t.to };
  }

  async function knowledgeDetail(knowledgeId) {
    const k = await store.byId("knowledge-entries", knowledgeId);
    if (!k) return null;
    const sources = await Promise.all(parseList(k["Supporting Source IDs"]).map(id => store.byId("sources", id).catch(() => null)));
    const contradicts = await Promise.all(parseList(k["Contradicts"]).map(id => store.byId("knowledge-entries", id).catch(() => null)));
    const auditTrail = (await store.collect("audit-log", `values[Entity ID] = ${kq(knowledgeId)}`, { maxPages: 2 })).items;
    return {
      entry: k, sources: sources.map((s, i) => s || { "Source ID": parseList(k["Supporting Source IDs"])[i], _missing: true }),
      contradicts: contradicts.filter(Boolean), supersededBy: k["Superseded By"] ? await store.byId("knowledge-entries", k["Superseded By"]) : null,
      audit: auditTrail.sort((a, b) => String(a["Occurred At"]).localeCompare(b["Occurred At"])),
    };
  }

  // ── dossiers ──
  async function companyDossier(companyId) {
    const company = await store.byId("companies", companyId);
    if (!company) return null;
    const q = `values[Company ID] = ${kq(companyId)}`;
    const [people, events, projects, comms, knowledge, sources, decisions, links] = await Promise.all([
      store.collect("people", `values[Primary Company ID] = ${kq(companyId)}`, { maxPages: 4 }),
      store.collect("historical-events", q, { maxPages: 8 }),
      store.collect("projects", q, { maxPages: 4 }),
      store.collect("communications", q, { maxPages: 4 }),
      store.collect("knowledge-entries", q, { maxPages: 8 }),
      store.collect("sources", q, { maxPages: 8 }),
      store.collect("decisions", q, { maxPages: 4 }),
      linksOf(companyId),
    ]);
    // people linked by relationship but with a different primary company
    const linkedPeopleIds = links.filter(l => l["From Type"] === "person" || l["To Type"] === "person").map(l => (l["From Type"] === "person" ? l["From ID"] : l["To ID"]));
    const extraPeople = [];
    for (const pid of [...new Set(linkedPeopleIds)].filter(id => !people.items.some(p => p["Person ID"] === id)).slice(0, 25)) {
      const p = await store.byId("people", pid); if (p) extraPeople.push(p);
    }
    const productIds = links.filter(l => l["To Type"] === "product" || l["From Type"] === "product").map(l => (l["To Type"] === "product" ? l["To ID"] : l["From ID"]));
    const products = [];
    for (const pid of [...new Set(productIds)].slice(0, 25)) { const p = await store.byId("products", pid); if (p) products.push(p); }
    const kn = knowledge.items.filter(k => k["Record Status"] !== "deleted");
    return {
      company, people: [...people.items, ...extraPeople], projects: projects.items, products, decisions: decisions.items,
      timeline: events.items.filter(e => e["Record Status"] !== "deleted").sort((a, b) => sortableDate(a["Event Date"]).localeCompare(sortableDate(b["Event Date"]))),
      communications: comms.items.sort((a, b) => String(b["Communication Date"]).localeCompare(a["Communication Date"])),
      knowledge: kn, sources: sources.items, relationships: links,
      truncated: [people, events, projects, comms, knowledge, sources, decisions].some(x => x.truncated),
    };
  }
  async function personProfile(personId) {
    const person = await store.byId("people", personId);
    if (!person) return null;
    const links = await linksOf(personId);
    const companyIds = [...new Set([person["Primary Company ID"], ...links.filter(l => l["To Type"] === "company").map(l => l["To ID"])].filter(Boolean))];
    const companies = (await Promise.all(companyIds.map(id => store.byId("companies", id)))).filter(Boolean);
    const scanComms = await store.collect("communications", person["Primary Company ID"] ? `values[Company ID] = ${kq(person["Primary Company ID"])}` : "", { maxPages: 8 });
    const comms = scanComms.items.filter(c => parseList(c["Person IDs"]).includes(personId));
    const scanEvents = await store.collect("historical-events", person["Primary Company ID"] ? `values[Company ID] = ${kq(person["Primary Company ID"])}` : "", { maxPages: 8 });
    const events = scanEvents.items.filter(e => parseList(e["Person IDs"]).includes(personId));
    const knowledge = (await store.collect("knowledge-entries", `values[Subject ID] = ${kq(personId)}`, { maxPages: 4 })).items;
    const sources = (await Promise.all(parseList(person["Source IDs"]).slice(0, 25).map(id => store.byId("sources", id)))).filter(Boolean);
    const projectIds = links.filter(l => l["To Type"] === "project").map(l => l["To ID"]);
    const projects = (await Promise.all([...new Set(projectIds)].map(id => store.byId("projects", id)))).filter(Boolean);
    return { person, companies, roles: links.filter(l => l["To Type"] === "company"), communications: comms, events, knowledge, sources, projects, relationships: links };
  }
  async function sourceDetail(sourceId) {
    const source = await store.byId("sources", sourceId);
    if (!source) return null;
    // knowledge citing this source: scan by company where possible (bounded)
    const scope = source["Company ID"] ? `values[Company ID] = ${kq(source["Company ID"])}` : "";
    const kn = (await store.collect("knowledge-entries", scope, { maxPages: 8 })).items.filter(k => parseList(k["Supporting Source IDs"]).includes(sourceId));
    const companies = (await Promise.all(parseList(source["Company IDs"]).map(id => store.byId("companies", id)))).filter(Boolean);
    const people = (await Promise.all(parseList(source["Person IDs"]).slice(0, 25).map(id => store.byId("people", id)))).filter(Boolean);
    return { source, knowledge: kn, companies, people };
  }

  async function timeline({ companyId, productId, projectId, eventType, from, to, pageToken } = {}) {
    const parts = [`values[Record Status] = "active"`];
    let orderBy = "values[Record Status],values[Event Date]";
    if (companyId) { parts[0] = `values[Company ID] = ${kq(companyId)}`; orderBy = "values[Company ID],values[Event Date]"; }
    else if (projectId) { parts[0] = `values[Project ID] = ${kq(projectId)}`; orderBy = "values[Project ID],values[Event Date]"; }
    else if (productId) { parts[0] = `values[Product ID] = ${kq(productId)}`; orderBy = "values[Product ID],values[Event Date]"; }
    else if (eventType) { parts[0] = `values[Event Type] = ${kq(eventType)}`; orderBy = "values[Event Type],values[Event Date]"; }
    const field = "values[Event Date]";
    if (from && to) parts.push(`${field} BETWEEN (${kq(from)}, ${kq(to + "~")})`);
    else if (from) parts.push(`${field} >= ${kq(from)}`);
    else if (to) parts.push(`${field} <= ${kq(to + "~")}`);
    const r = await store.page("historical-events", { q: parts.join(" AND "), orderBy, direction: "ASC", pageToken });
    let items = r.items;
    if (eventType && (companyId || projectId || productId)) items = items.filter(e => e["Event Type"] === eventType);
    return { items, nextPageToken: r.nextPageToken };
  }

  async function entityTitle(type, id) {
    const form = ENTITY_FORMS[type]; if (!form || !id) return "";
    const r = await store.byId(form, id).catch(() => null);
    return r ? (r.Name || r["Full Name"] || r.Title || r.Subject || id) : "";
  }

  return { audit, findCompanies, resolveCompany, resolvePerson, link, linksOf, proposeKnowledge, review, knowledgeDetail, companyDossier, personProfile, sourceDetail, timeline, entityTitle };
}
