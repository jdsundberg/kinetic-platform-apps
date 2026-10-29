// Kinetic Core data access for Corporate Brain. Every call runs with the CALLER's credentials,
// so Kinetic security policies (private kapp, restricted sources, reviewer-only edits) always apply.
// The Kinetic Platform is the only persistent store — there is no other database.
import { FORM_BY_SLUG, KAPP } from "../model.mjs";
import { newId } from "./core.mjs";

export const PRICING_TEAMS = ["Corporate Brain::Sales", "Corporate Brain::Legal", "Corporate Brain::Executive"];

export const kq = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

export class KineticError extends Error {
  constructor(status, data, what) {
    super(`${what} failed (${status}): ${typeof data === "string" ? data.slice(0, 200) : (data?.error || JSON.stringify(data)).slice(0, 300)}`);
    this.status = status; this.data = data;
  }
}

export function createStore(kineticRequest, auth, { kapp = KAPP.slug } = {}) {
  const base = (form) => `/kapps/${kapp}/forms/${form}/submissions`;
  const flat = (s) => (s ? { _id: s.id, _createdAt: s.createdAt, _createdBy: s.createdBy, _updatedAt: s.updatedAt, _updatedBy: s.updatedBy, ...s.values } : null);

  async function req(method, path, body, what) {
    const r = await kineticRequest(method, path, body, auth);
    if (r.status >= 300) throw new KineticError(r.status, r.data, what || `${method} ${path}`);
    return r.data;
  }

  // Per-form clause ANDed (first) into every list query. Kinetic refuses a whole query when 10+ matching
  // rows fail the form's Submission Access policy, so callers who cannot see every row must narrow the
  // query to the rows the policy allows (e.g. members → non-restricted sources). Lookups by ID are exempt.
  const scopes = {};
  const setScope = (form, clause) => { scopes[form] = clause; };
  const scoped = (form, q) => (scopes[form] ? (q ? `${scopes[form]} AND ${q}` : scopes[form]) : q);

  // One page (≤25) — the only shape the browser ever receives.
  async function page(form, { q = "", orderBy = "", direction = "", pageToken = "", limit = 25, unscoped = false } = {}) {
    if (!unscoped) q = scoped(form, q);
    let p = `${base(form)}?include=values,details&limit=${Math.min(limit, 25)}`;
    if (q) p += `&q=${encodeURIComponent(q)}`;
    if (orderBy) p += `&orderBy=${encodeURIComponent(orderBy)}`;
    if (direction) p += `&direction=${direction}`;
    if (pageToken) p += `&pageToken=${encodeURIComponent(pageToken)}`;
    const d = await req("GET", p, null, `query ${form}`);
    return { items: (d.submissions || []).map(flat), nextPageToken: d.nextPageToken || null };
  }

  // Server-side bounded walk (25 per request, pageToken) for aggregation. maxPages bounds the cost.
  async function collect(form, q = "", { maxPages = 8, orderBy = "", direction = "" } = {}) {
    const out = []; let token = "";
    for (let i = 0; i < maxPages; i++) {
      const r = await page(form, { q, orderBy, direction, pageToken: token });
      out.push(...r.items);
      if (!r.nextPageToken) return { items: out, truncated: false };
      token = r.nextPageToken;
    }
    return { items: out, truncated: true };
  }

  async function byId(form, id) {
    const def = FORM_BY_SLUG[form];
    if (!id) return null;
    const r = await page(form, { q: `values[${def.idField}] = ${kq(id)}`, limit: 1, unscoped: true });
    return r.items[0] || null;
  }
  async function bySubmissionId(subId) {
    const d = await kineticRequest("GET", `/submissions/${encodeURIComponent(subId)}?include=values,details,form`, null, auth);
    if (d.status === 404) return null;
    if (d.status >= 300) throw new KineticError(d.status, d.data, "get submission");
    return { ...flat(d.data.submission), _form: d.data.submission.form?.slug };
  }
  async function create(form, values) {
    const def = FORM_BY_SLUG[form];
    if (def && !values[def.idField]) values = { [def.idField]: newId(form), ...values };
    // Non-admins may not set coreState (403); ?completed=true submits the single page instead.
    const d = await req("POST", `${base(form)}?completed=true`, { values }, `create ${form}`);
    return flat({ ...d.submission, values: { ...values, ...(d.submission?.values || {}) } });
  }
  async function update(subId, values) {
    const d = await req("PUT", `/submissions/${encodeURIComponent(subId)}?include=values,details`, { values }, "update submission");
    return flat(d.submission);
  }
  async function count(form, q = "", cap = 1000) {
    // Counts by walking ids only (bounded); returns {n, capped}.
    let n = 0, token = "";
    for (let i = 0; i < Math.ceil(cap / 25); i++) {
      let p = `${base(form)}?limit=25`;
      const sq = scoped(form, q);
      if (sq) p += `&q=${encodeURIComponent(sq)}`;
      if (token) p += `&pageToken=${encodeURIComponent(token)}`;
      const d = await req("GET", p, null, `count ${form}`);
      n += (d.submissions || []).length;
      if (!d.nextPageToken) return { n, capped: false };
      token = d.nextPageToken;
    }
    return { n, capped: true };
  }
  async function me() {
    const d = await req("GET", `/me?include=memberships`, null, "me");
    const teams = (d.memberships || []).map(m => m.team?.name).filter(Boolean);
    const admin = !!d.spaceAdmin || teams.includes("Corporate Brain::Admins");
    const reviewer = admin || teams.includes("Corporate Brain::Reviewers");
    return {
      username: d.username, displayName: d.displayName || d.username, email: d.email, spaceAdmin: !!d.spaceAdmin, teams,
      roles: {
        admin, reviewer,
        // mirrors the CB Member policy exactly; the sales audience teams (Sales, Marketing, Legal, Executive) don't grant membership on their own
        member: reviewer || teams.includes("Corporate Brain::Members"),
        // mirrors CB Wally Question: historians (and admins) see every question asked of Wally
        historian: admin || (teams.includes("Corporate Brain::Historians") && (reviewer || teams.includes("Corporate Brain::Members"))),
        // mirrors CB Deal Pricing: deal-level prices are for reviewers and the Sales, Legal and Executive teams (John, 2026-10-27)
        pricing: reviewer || PRICING_TEAMS.some(t => teams.includes(t)),
      },
    };
  }
  return { page, collect, byId, bySubmissionId, create, update, count, me, flat, setScope, raw: req };
}
