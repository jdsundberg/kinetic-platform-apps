/**
 * Location Scout MN — Custom API Handler
 *
 * Server-side aggregation for the dashboard, the location 360 view, the
 * shoot-day availability calendar and the booking-conflict audit.
 */

export const appId = "location-scout";
export const apiPrefix = "/api/location-scout";
export const kapp = "location-scout";

const num = (v) => parseFloat(v) || 0;

// ── Lifecycle state sets ─────────────────────────────────────────────────
// Whitelists, never blacklists: a status added later must fail loudly rather
// than silently falling into an "everything else" bucket.
const LOC_BOOKABLE   = ["Cleared", "Restricted"];
const LOC_ACTIVE     = ["Prospect", "Scouted", "Cleared", "Restricted"];
const HOLD_EXCLUSIVE = ["Confirmed"];                    // hard conflict if overlapping
const HOLD_CONTENDING = ["Soft Hold", "First Refusal"];  // may legitimately stack
const HOLD_OCCUPYING = [...HOLD_EXCLUSIVE, ...HOLD_CONTENDING];
const HOLD_TERMINAL  = ["Released", "Completed", "Cancelled"];
const REPORT_OPEN    = ["Draft", "Submitted", "Under Review"];
const REPORT_PENDING = ["Submitted", "Under Review"];    // waiting on a human
const PERMIT_INFLIGHT = ["Required", "Applied", "In Review"];
const PERMIT_OK      = ["Issued", "Not Required"];
const PROJ_ACTIVE    = ["Prepping", "Scouting", "Locked", "Shooting"];

// Free-text search targets + default sort per form. The client sends `text`
// and `f_<Field>` filters; everything is resolved server-side so the browser
// still only ever receives one 25-row page.
const SEARCHABLE = {
  "locations":       { sort: "Location Code", fields: ["Location Code", "Location Name", "City", "County", "Sub Type", "Features", "Description", "Region", "Category"] },
  "location-photos": { sort: "Photo Code",    fields: ["Photo Code", "Location Code", "Caption", "Shot Type", "Photographer", "Season", "Time Of Day"] },
  "contacts":        { sort: "Full Name",     fields: ["Contact Code", "Full Name", "Role", "Organization", "Email", "Phone", "Location Code", "City"] },
  "scout-reports":   { sort: "Report Code",   fields: ["Report Code", "Location Code", "Project Code", "Scout Name", "Summary", "Recommendation", "Risks"] },
  "permits":         { sort: "Permit Code",   fields: ["Permit Code", "Location Code", "Project Code", "Permit Type", "Jurisdiction", "Conditions"] },
  "holds":           { sort: "Start Date",    fields: ["Hold Code", "Location Code", "Project Code", "Hold Type", "Requested By", "Notes"] },
  "projects":        { sort: "Project Code",  fields: ["Project Code", "Project Title", "Client", "Production Company", "Director", "Producer", "Production Type"] },
};

const overlaps = (aStart, aEnd, bStart, bEnd) => !(aEnd < bStart || aStart > bEnd);

// 5-minute aggregation cache with in-flight dedup, so a dashboard refresh storm
// doesn't re-walk every form. `?fresh=1` bypasses it after a write.
const CACHE_MS = 5 * 60 * 1000;
const _cache = new Map();
const _inflight = new Map();
async function cached(key, fresh, fn) {
  if (fresh) { _cache.delete(key); _inflight.delete(key); }
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.val;
  if (_inflight.has(key)) return _inflight.get(key);
  const p = (async () => {
    try { const val = await fn(); _cache.set(key, { at: Date.now(), val }); return val; }
    finally { _inflight.delete(key); }
  })();
  _inflight.set(key, p);
  return p;
}

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, jsonResp, vf } = helpers;
  const KAPP = kapp;
  const url = new URL(req.url, "http://x");
  const fresh = url.searchParams.get("fresh") === "1";

  // collectByQuery takes kapp FIRST — always go through this shorthand.
  async function collect(formSlug, kql, maxPages = 40) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }
  const all = () => Promise.all([
    collect("locations"), collect("projects"), collect("contacts"),
    collect("scout-reports"), collect("holds"), collect("permits"), collect("location-photos"),
  ]);

  // ── GET /dashboard ─────────────────────────────────────────────────────
  if (pathname === `${apiPrefix}/dashboard` && req.method === "GET") {
    try {
      const data = await cached("dashboard", fresh, async () => {
        const [locations, projects, contacts, reports, holds, permits, photos] = await all();
        const today = new Date().toISOString().slice(0, 10);

        const byStatus = (rows, f = "Status") => rows.reduce((a, r) => (a[vf(r, f)] = (a[vf(r, f)] || 0) + 1, a), {});
        const photoCount = photos.reduce((a, p) => (a[vf(p, "Location Code")] = (a[vf(p, "Location Code")] || 0) + 1, a), {});

        const bookable = locations.filter(l => LOC_BOOKABLE.includes(vf(l, "Status")));
        const activeProjects = projects.filter(p => PROJ_ACTIVE.includes(vf(p, "Status")));

        // Work queues are predicates over lifecycle state, never over dates alone.
        const pendingReports = reports.filter(r => REPORT_PENDING.includes(vf(r, "Status")));
        const openPermits = permits.filter(p => PERMIT_INFLIGHT.includes(vf(p, "Status")));
        const liveHolds = holds.filter(h => HOLD_OCCUPYING.includes(vf(h, "Status")));
        const nameOf = Object.fromEntries(locations.map(l => [vf(l, "Location Code"), vf(l, "Location Name")]));
        const upcoming = liveHolds
          .filter(h => vf(h, "End Date") >= today)
          .sort((a, b) => vf(a, "Start Date").localeCompare(vf(b, "Start Date")))
          .slice(0, 12)
          .map(h => ({
            code: vf(h, "Hold Code"), location: vf(h, "Location Code"),
            locationName: nameOf[vf(h, "Location Code")] || "",
            project: vf(h, "Project Code"), status: vf(h, "Status"), type: vf(h, "Hold Type"),
            start: vf(h, "Start Date"), end: vf(h, "End Date"), crew: vf(h, "Crew Size"),
          }));

        // Permits expiring inside 60 days that are still live.
        const in60 = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
        const expiring = permits
          .filter(p => vf(p, "Status") === "Issued" && vf(p, "Expires On") && vf(p, "Expires On") <= in60)
          .sort((a, b) => vf(a, "Expires On").localeCompare(vf(b, "Expires On")))
          .map(p => ({ code: vf(p, "Permit Code"), type: vf(p, "Permit Type"), location: vf(p, "Location Code"), expires: vf(p, "Expires On"), jurisdiction: vf(p, "Jurisdiction") }));

        // Locations with no photo at all — a scouting gap worth surfacing.
        const missingPhotos = locations
          .filter(l => !photoCount[vf(l, "Location Code")] && LOC_ACTIVE.includes(vf(l, "Status")))
          .map(l => ({ code: vf(l, "Location Code"), name: vf(l, "Location Name"), city: vf(l, "City") }));

        const scored = reports.filter(r => num(vf(r, "Overall Score")) > 0);
        const avgScore = scored.length ? (scored.reduce((s, r) => s + num(vf(r, "Overall Score")), 0) / scored.length).toFixed(1) : "0";

        // Top locations by strength of recommendation
        const strong = reports.filter(r => vf(r, "Recommendation") === "Strong Fit" && vf(r, "Status") === "Approved");
        const topLocations = strong.slice(0, 8).map(r => {
          const loc = locations.find(l => vf(l, "Location Code") === vf(r, "Location Code")) || {};
          return {
            code: vf(r, "Location Code"), name: vf(loc, "Location Name"), city: vf(loc, "City"),
            region: vf(loc, "Region"), category: vf(loc, "Category"),
            score: vf(r, "Overall Score"), photos: photoCount[vf(r, "Location Code")] || 0,
          };
        });

        return {
          kpis: {
            locations: locations.length,
            bookable: bookable.length,
            prospects: locations.filter(l => vf(l, "Status") === "Prospect").length,
            photos: photos.length,
            contacts: contacts.filter(c => vf(c, "Status") === "Active").length,
            activeProjects: activeProjects.length,
            pendingReports: pendingReports.length,
            approvedReports: reports.filter(r => vf(r, "Status") === "Approved").length,
            openPermits: openPermits.length,
            issuedPermits: permits.filter(p => vf(p, "Status") === "Issued").length,
            confirmedHolds: holds.filter(h => vf(h, "Status") === "Confirmed").length,
            liveHolds: liveHolds.length,
            avgScore,
            regions: new Set(locations.map(l => vf(l, "Region"))).size,
          },
          statusDist: byStatus(locations),
          regionDist: byStatus(locations, "Region"),
          categoryDist: byStatus(locations, "Category"),
          reportDist: byStatus(reports),
          holdDist: byStatus(holds),
          permitDist: byStatus(permits),
          upcoming, expiring, missingPhotos, topLocations,
        };
      });
      jsonResp(res, 200, data);
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /location/{code} — the 360 view ────────────────────────────────
  const locMatch = pathname.match(new RegExp(`^${apiPrefix}/location/([^/]+)$`));
  if (locMatch && req.method === "GET") {
    try {
      const code = decodeURIComponent(locMatch[1]);
      const q = `values[Location Code]="${code.replace(/"/g, '')}"`;
      const [locs, photos, contacts, reports, holds, permits] = await Promise.all([
        collect("locations", q), collect("location-photos", q), collect("contacts", q),
        collect("scout-reports", q), collect("holds", q), collect("permits", q),
      ]);
      const loc = locs[0];
      if (!loc) { jsonResp(res, 404, { error: `Location ${code} not found` }); return true; }

      const strip = (rows, fields) => rows.map(r => {
        const o = { id: r.id };
        for (const f of fields) o[f] = vf(r, f);
        return o;
      });

      jsonResp(res, 200, {
        location: { id: loc.id, values: loc.values || {} },
        photos: photos.map(p => ({
          id: p.id,
          code: vf(p, "Photo Code"), caption: vf(p, "Caption"), shotType: vf(p, "Shot Type"),
          setting: vf(p, "Setting"), timeOfDay: vf(p, "Time Of Day"), season: vf(p, "Season"),
          photographer: vf(p, "Photographer"), capturedOn: vf(p, "Captured On"), lens: vf(p, "Lens Notes"),
          // Rebuild the attachment URL: the platform's own `link` is space-slug
          // prefixed and 404s when the space is reached by subdomain.
          file: (p.values?.Photo || []).map(f => ({
            name: f.name, size: f.size, contentType: f.contentType,
            url: `/app/api/v1/submissions/${p.id}/files/Photo/0/${encodeURIComponent(f.name)}`,
          }))[0] || null,
        })).sort((a, b) => (a.code || "").localeCompare(b.code || "")),
        contacts: strip(contacts, ["Contact Code", "Full Name", "Role", "Organization", "Email", "Phone", "Preferred Contact", "Best Time To Reach", "Status", "Notes"]),
        reports: strip(reports, ["Report Code", "Project Code", "Scout Name", "Visit Date", "Status", "Recommendation", "Overall Score", "Summary", "Risks", "Sun Notes", "Sound Notes", "Access Notes", "Power Notes", "Crew Fit Notes", "Weather Conditions", "Estimated Prep Days", "Reviewed By", "Reviewed On"])
          .sort((a, b) => (b["Visit Date"] || "").localeCompare(a["Visit Date"] || "")),
        holds: strip(holds, ["Hold Code", "Project Code", "Status", "Hold Type", "Start Date", "End Date", "Crew Size", "Day Rate Quoted", "Requested By", "Notes"])
          .sort((a, b) => (a["Start Date"] || "").localeCompare(b["Start Date"] || "")),
        permits: strip(permits, ["Permit Code", "Project Code", "Permit Type", "Jurisdiction", "Status", "Applied On", "Issued On", "Expires On", "Fee", "Insurance Certificate", "Conditions"]),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /invalidate — drop every cached aggregation after a write ──────
  if (pathname === `${apiPrefix}/invalidate` && req.method === "GET") {
    const n = _cache.size;
    _cache.clear(); _inflight.clear();
    jsonResp(res, 200, { cleared: n });
    return true;
  }

  // ── GET /search?form=&text=&f_<Field>=&page= ───────────────────────────
  // Paging happens SERVER-side: the browser never receives more than 25 rows,
  // but search still spans the whole form instead of just the loaded page.
  if (pathname === `${apiPrefix}/search` && req.method === "GET") {
    try {
      const form = url.searchParams.get("form") || "";
      if (!SEARCHABLE[form]) { jsonResp(res, 400, { error: `Unknown or unsearchable form: ${form}` }); return true; }
      const text = (url.searchParams.get("text") || "").trim().toLowerCase();
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const sortField = url.searchParams.get("sort") || SEARCHABLE[form].sort;
      const PAGE = 25;

      // Equality filters arrive as f_<Field Name>; they are applied in memory so
      // any combination works without needing an index for that exact combination.
      const filters = [];
      for (const [k, val] of url.searchParams.entries()) {
        if (k.startsWith("f_") && val) filters.push([k.slice(2), val]);
      }

      const rows = await cached(`form:${form}`, fresh, () => collect(form));
      let out = rows;
      for (const [field, val] of filters) out = out.filter(r => vf(r, field) === val);
      if (text) {
        const fields = SEARCHABLE[form].fields;
        out = out.filter(r => fields.some(f => String(vf(r, f) || "").toLowerCase().includes(text)));
      }
      out.sort((a, b) => String(vf(a, sortField) || "").localeCompare(String(vf(b, sortField) || "")));

      const total = out.length;
      const pages = Math.max(1, Math.ceil(total / PAGE));
      const slice = out.slice((page - 1) * PAGE, page * PAGE);

      jsonResp(res, 200, {
        total, page, pages, pageSize: PAGE,
        rows: slice.map(r => ({
          id: r.id,
          values: r.values || {},
          // Attachment URLs are rebuilt here; the platform's own `link` 404s on a subdomain.
          photoUrl: (r.values?.Photo || []).length
            ? `/app/api/v1/submissions/${r.id}/files/Photo/0/${encodeURIComponent(r.values.Photo[0].name)}`
            : null,
        })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /conflicts — double-booking audit ──────────────────────────────
  if (pathname === `${apiPrefix}/conflicts` && req.method === "GET") {
    try {
      const data = await cached("conflicts", fresh, async () => {
        const [holds, locations] = await Promise.all([collect("holds"), collect("locations")]);
        const nameOf = Object.fromEntries(locations.map(l => [vf(l, "Location Code"), vf(l, "Location Name")]));
        const live = holds.filter(h => HOLD_OCCUPYING.includes(vf(h, "Status")));
        const byLoc = {};
        for (const h of live) (byLoc[vf(h, "Location Code")] ||= []).push(h);

        const hard = [], soft = [];
        for (const [locCode, list] of Object.entries(byLoc)) {
          for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
              const a = list[i], b = list[j];
              if (!overlaps(vf(a, "Start Date"), vf(a, "End Date"), vf(b, "Start Date"), vf(b, "End Date"))) continue;
              const rec = {
                location: locCode, locationName: nameOf[locCode] || "",
                a: { code: vf(a, "Hold Code"), status: vf(a, "Status"), project: vf(a, "Project Code"), start: vf(a, "Start Date"), end: vf(a, "End Date") },
                b: { code: vf(b, "Hold Code"), status: vf(b, "Status"), project: vf(b, "Project Code"), start: vf(b, "Start Date"), end: vf(b, "End Date") },
              };
              // Two Confirmed holds on one location is a real double-booking.
              // A soft hold stacking behind another is normal industry practice.
              if (HOLD_EXCLUSIVE.includes(vf(a, "Status")) && HOLD_EXCLUSIVE.includes(vf(b, "Status"))) hard.push(rec);
              else soft.push(rec);
            }
          }
        }
        return { hard, soft, checked: live.length };
      });
      jsonResp(res, 200, data);
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /availability?code=&start=&end= — booking guard ────────────────
  if (pathname === `${apiPrefix}/availability` && req.method === "GET") {
    try {
      const code = url.searchParams.get("code") || "";
      const start = url.searchParams.get("start") || "";
      const end = url.searchParams.get("end") || start;
      if (!code || !start) { jsonResp(res, 400, { error: "code and start are required" }); return true; }
      const safe = code.replace(/"/g, "");
      const [locs, holds] = await Promise.all([
        collect("locations", `values[Location Code]="${safe}"`),
        collect("holds", `values[Location Code]="${safe}"`),
      ]);
      const loc = locs[0];
      if (!loc) { jsonResp(res, 404, { error: `Location ${code} not found` }); return true; }
      const clashes = holds
        .filter(h => HOLD_OCCUPYING.includes(vf(h, "Status")))
        .filter(h => overlaps(start, end, vf(h, "Start Date"), vf(h, "End Date")))
        .map(h => ({ code: vf(h, "Hold Code"), status: vf(h, "Status"), project: vf(h, "Project Code"), start: vf(h, "Start Date"), end: vf(h, "End Date") }));
      const blocking = clashes.filter(c => HOLD_EXCLUSIVE.includes(c.status));
      jsonResp(res, 200, {
        location: vf(loc, "Location Code"), name: vf(loc, "Location Name"),
        locationStatus: vf(loc, "Status"),
        bookable: LOC_BOOKABLE.includes(vf(loc, "Status")),
        available: blocking.length === 0 && LOC_BOOKABLE.includes(vf(loc, "Status")),
        blocking, contending: clashes.filter(c => !HOLD_EXCLUSIVE.includes(c.status)),
        window: { start, end },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /map — geo points for the map view ─────────────────────────────
  if (pathname === `${apiPrefix}/map` && req.method === "GET") {
    try {
      const data = await cached("map", fresh, async () => {
        const [locations, photos] = await Promise.all([collect("locations"), collect("location-photos")]);
        const photoCount = photos.reduce((a, p) => (a[vf(p, "Location Code")] = (a[vf(p, "Location Code")] || 0) + 1, a), {});
        return {
          points: locations
            .filter(l => vf(l, "Latitude") && vf(l, "Longitude"))
            .map(l => ({
              code: vf(l, "Location Code"), name: vf(l, "Location Name"),
              lat: num(vf(l, "Latitude")), lon: num(vf(l, "Longitude")),
              city: vf(l, "City"), region: vf(l, "Region"), category: vf(l, "Category"),
              status: vf(l, "Status"), setting: vf(l, "Setting"),
              dayRate: num(vf(l, "Day Rate")), photos: photoCount[vf(l, "Location Code")] || 0,
            })),
        };
      });
      jsonResp(res, 200, data);
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
