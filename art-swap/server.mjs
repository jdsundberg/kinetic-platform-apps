/**
 * Art Swap — Custom API Handler
 *
 * Dashboard aggregation (collection value, swap pipeline, insurance alerts)
 * and the swap-lifecycle action endpoint:
 *   Proposed → Approved → In Transit (creates shipments) → Completed (swaps ownership)
 */

export const appId = "art-swap";
export const apiPrefix = "/api/art-swap";
export const kapp = "art-swap";

const EXPIRING_DAYS = 90;

function money(n) { const f = parseFloat(n); return isNaN(f) ? 0 : f; }
function nowDate() { return new Date().toISOString().slice(0, 10); }
function plusDays(d) { const t = new Date(); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); }

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // ── GET /api/art-swap/dashboard ────────────────────────────────────────────
  if (pathname === "/api/art-swap/dashboard" && req.method === "GET") {
    try {
      const [artworks, companies, swaps, shipments] = await Promise.all([
        collect("artworks", null, 8),
        collect("companies", null, 8),
        collect("swaps", null, 8),
        collect("shipments", null, 8),
      ]);

      let totalValue = 0, paintings = 0, sculptures = 0;
      const valueByCompany = {};
      const expiring = [], underinsured = [];
      const horizon = plusDays(EXPIRING_DAYS), today = nowDate();

      for (const a of artworks) {
        const val = money(vf(a, "Appraised Value"));
        totalValue += val;
        const t = vf(a, "Type");
        if (t === "Painting") paintings++; else if (t === "Sculpture") sculptures++;
        const owner = vf(a, "Owner Company") || "(none)";
        valueByCompany[owner] = (valueByCompany[owner] || 0) + val;

        const exp = vf(a, "Insurance Expires");
        if (exp && exp <= horizon) {
          expiring.push({
            id: a.id, title: vf(a, "Title"), owner,
            insurer: vf(a, "Insurer"), policy: vf(a, "Policy Number"),
            expires: exp, expired: exp < today,
          });
        }
        const insured = money(vf(a, "Insured Value"));
        if (val > 0 && insured > 0 && insured < val) {
          underinsured.push({
            id: a.id, title: vf(a, "Title"), owner,
            insurer: vf(a, "Insurer"), policy: vf(a, "Policy Number"),
            appraised: val, insured, gap: val - insured,
          });
        }
      }
      expiring.sort((a, b) => (a.expires || "").localeCompare(b.expires || ""));
      underinsured.sort((a, b) => b.gap - a.gap);

      const pipeline = {};
      for (const s of swaps) {
        const st = vf(s, "Status") || "Unknown";
        pipeline[st] = (pipeline[st] || 0) + 1;
      }

      const inTransit = shipments
        .filter(s => ["In Transit", "Scheduled"].includes(vf(s, "Status")))
        .map(s => ({
          id: s.id, number: vf(s, "Shipment Number"), swap: vf(s, "Swap Number"),
          artwork: vf(s, "Artwork Title"), from: vf(s, "From Company"), to: vf(s, "To Company"),
          carrier: vf(s, "Carrier"), tracking: vf(s, "Tracking Number"),
          declared: money(vf(s, "Declared Value")), eta: vf(s, "Expected Delivery"),
          status: vf(s, "Status"),
        }))
        .sort((a, b) => (a.eta || "").localeCompare(b.eta || ""));

      const topCompanies = Object.entries(valueByCompany)
        .sort((a, b) => b[1] - a[1])
        .map(([name, value]) => ({ name, value: Math.round(value), count: artworks.filter(a => vf(a, "Owner Company") === name).length }));

      jsonResp(res, 200, {
        kpis: {
          artworks: artworks.length,
          paintings, sculptures,
          totalValue: Math.round(totalValue),
          companies: companies.filter(c => vf(c, "Status") === "Active").length,
          activeSwaps: swaps.filter(s => ["Proposed", "Approved", "In Transit"].includes(vf(s, "Status"))).length,
          shipmentsMoving: inTransit.length,
          expiringPolicies: expiring.length,
          underinsured: underinsured.length,
        },
        pipeline, topCompanies, expiring, underinsured, inTransit,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/art-swap/gallery ──────────────────────────────────────────────
  // Grid + 12-month location timeline. Projects future locations from active
  // swaps: In Transit → shipment ETA month; Approved → +1 month; Proposed → +2.
  if (pathname === "/api/art-swap/gallery" && req.method === "GET") {
    try {
      const [artworks, swaps, shipments, companies] = await Promise.all([
        collect("artworks", null, 8),
        collect("swaps", null, 8),
        collect("shipments", null, 8),
        collect("companies", null, 8),
      ]);

      const cityOf = name => {
        const c = companies.find(c => vf(c, "Company Name") === name);
        return c ? vf(c, "City") : "";
      };

      // Next 12 months starting with the current month
      const months = [];
      const now = new Date();
      for (let i = 0; i < 12; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        months.push({
          key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
          label: d.toLocaleString("en-US", { month: "short" }) + " ’" + String(d.getFullYear()).slice(2),
        });
      }
      const monthIndex = (dateStr, fallback) => {
        if (!dateStr) return fallback;
        const key = String(dateStr).slice(0, 7);
        const idx = months.findIndex(m => m.key === key);
        return idx === -1 ? (key < months[0].key ? 0 : fallback) : idx;
      };

      // Project moves from active swaps
      const moves = {}; // title -> { atMonth, toCompany, via }
      for (const sw of swaps) {
        const status = vf(sw, "Status");
        if (!["Proposed", "Approved", "In Transit"].includes(status)) continue;
        const legs = [
          { title: vf(sw, "From Artwork"), to: vf(sw, "To Company") },
          { title: vf(sw, "To Artwork"), to: vf(sw, "From Company") },
        ].filter(l => l.title);
        for (const leg of legs) {
          let at;
          if (status === "In Transit") {
            const ship = shipments.find(s => vf(s, "Artwork Title") === leg.title && ["In Transit", "Scheduled"].includes(vf(s, "Status")));
            at = monthIndex(ship ? vf(ship, "Expected Delivery") : null, 0);
          } else if (status === "Approved") at = 1;
          else at = 2; // Proposed
          moves[leg.title] = { atMonth: at, toCompany: leg.to, via: `${vf(sw, "Swap Number")} (${status})` };
        }
      }

      const rows = artworks.map(a => {
        const title = vf(a, "Title");
        const owner = vf(a, "Owner Company");
        const mv = moves[title];
        const segments = months.map((m, i) => {
          const company = mv && i >= mv.atMonth ? mv.toCompany : owner;
          return { company, city: cityOf(company), move: !!(mv && i === mv.atMonth) };
        });
        return {
          id: a.id, title, artist: vf(a, "Artist"), type: vf(a, "Type"),
          year: vf(a, "Year"), value: parseFloat(vf(a, "Appraised Value")) || 0,
          owner, status: vf(a, "Status"), medium: vf(a, "Medium"),
          moving: !!mv, via: mv ? mv.via : null, segments,
        };
      });
      rows.sort((a, b) => (b.moving - a.moving) || a.title.localeCompare(b.title));

      jsonResp(res, 200, {
        months, rows,
        companies: companies.map(c => ({ name: vf(c, "Company Name"), city: vf(c, "City") })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── POST /api/art-swap/advance-swap ────────────────────────────────────────
  // Body: { swapNumber, action: "approve" | "ship" | "complete" | "cancel" }
  if (pathname === "/api/art-swap/advance-swap" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const { swapNumber, action } = body;
      if (!swapNumber || !action) { jsonResp(res, 400, { error: "swapNumber and action are required" }); return true; }

      const kqlNum = String(swapNumber).replace(/"/g, '\\"');
      const swapArr = await collect("swaps", `values[Swap Number] = "${kqlNum}"`, 1);
      if (!swapArr.length) { jsonResp(res, 404, { error: `Swap not found: ${swapNumber}` }); return true; }
      const swap = swapArr[0];
      const status = vf(swap, "Status");
      const fromCo = vf(swap, "From Company"), toCo = vf(swap, "To Company");

      // Artwork lookup by exact title (titles are the cross-form key)
      async function artworkByTitle(title) {
        if (!title) return null;
        const arr = await collect("artworks", `values[Title] = "${String(title).replace(/"/g, '\\"')}"`, 1);
        return arr[0] || null;
      }
      const fromArt = await artworkByTitle(vf(swap, "From Artwork"));
      const toArt = await artworkByTitle(vf(swap, "To Artwork"));
      const legs = [fromArt && { art: fromArt, from: fromCo, to: toCo }, toArt && { art: toArt, from: toCo, to: fromCo }].filter(Boolean);

      async function setArtStatus(art, st, extra = {}) {
        if (!art) return;
        await kineticRequest("PUT", `/submissions/${art.id}`, { values: { Status: st, ...extra } }, auth);
      }
      async function setSwap(values) {
        await kineticRequest("PUT", `/submissions/${swap.id}`, { values }, auth);
      }

      const VALID = { approve: ["Proposed"], ship: ["Approved"], complete: ["In Transit"], cancel: ["Proposed", "Approved"] };
      if (!VALID[action]) { jsonResp(res, 400, { error: `Unknown action: ${action}` }); return true; }
      if (!VALID[action].includes(status)) {
        jsonResp(res, 409, { error: `Cannot ${action} a swap in status "${status}" (requires ${VALID[action].join(" or ")})` });
        return true;
      }

      if (action === "approve") {
        await setSwap({ Status: "Approved" });
        for (const leg of legs) await setArtStatus(leg.art, "Swap Pending");
        jsonResp(res, 200, { success: true, swap: swapNumber, status: "Approved" });
        return true;
      }

      if (action === "cancel") {
        await setSwap({ Status: "Cancelled" });
        for (const leg of legs) await setArtStatus(leg.art, "Available");
        jsonResp(res, 200, { success: true, swap: swapNumber, status: "Cancelled" });
        return true;
      }

      if (action === "ship") {
        // Next shipment numbers
        const existing = await collect("shipments", null, 12);
        let maxNum = 2000;
        for (const s of existing) {
          const m = String(vf(s, "Shipment Number")).match(/SH-(\d+)/);
          if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
        }
        const created = [];
        for (const leg of legs) {
          maxNum++;
          const shipNo = `SH-${maxNum}`;
          const declared = vf(leg.art, "Insured Value") || vf(leg.art, "Appraised Value") || "";
          const r = await kineticRequest("POST", `/kapps/${KAPP}/forms/shipments/submissions`, {
            values: {
              "Shipment Number": shipNo,
              "Swap Number": swapNumber,
              "Artwork Title": vf(leg.art, "Title"),
              "From Company": leg.from,
              "To Company": leg.to,
              "Carrier": body.carrier || "Atelier North Fine Art Logistics",
              "Tracking Number": "",
              "Declared Value": declared,
              "Ship Date": nowDate(),
              "Expected Delivery": plusDays(4),
              "Delivered Date": "",
              "Condition Notes": "",
              "Status": "In Transit",
            },
            coreState: "Submitted",
          }, auth);
          if (r.status < 300) created.push(shipNo);
          await setArtStatus(leg.art, "In Transit", { Location: `In transit — ${body.carrier || "Atelier North Fine Art Logistics"}` });
        }
        await setSwap({ Status: "In Transit" });
        jsonResp(res, 200, { success: true, swap: swapNumber, status: "In Transit", shipments: created });
        return true;
      }

      if (action === "complete") {
        // Mark this swap's open shipments Delivered
        const ships = await collect("shipments", `values[Swap Number] = "${kqlNum}"`, 2);
        for (const s of ships) {
          if (["Scheduled", "In Transit"].includes(vf(s, "Status"))) {
            await kineticRequest("PUT", `/submissions/${s.id}`, { values: { Status: "Delivered", "Delivered Date": nowDate() } }, auth);
          }
        }
        // Swap ownership; new home = recipient company
        const companiesAll = await collect("companies", null, 4);
        const cityOf = name => {
          const c = companiesAll.find(c => vf(c, "Company Name") === name);
          return c ? vf(c, "City") : "";
        };
        for (const leg of legs) {
          await kineticRequest("PUT", `/submissions/${leg.art.id}`, {
            values: {
              "Owner Company": leg.to,
              "Status": "Available",
              "Location": cityOf(leg.to) ? `${cityOf(leg.to)} HQ` : "",
            },
          }, auth);
        }
        await setSwap({ Status: "Completed", "Completed Date": nowDate() });
        jsonResp(res, 200, { success: true, swap: swapNumber, status: "Completed", ownershipTransferred: legs.map(l => ({ artwork: vf(l.art, "Title"), newOwner: l.to })) });
        return true;
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
