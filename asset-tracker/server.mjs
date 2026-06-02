/**
 * Asset Tracker — Custom API Handler
 *
 * Atomic transfer endpoint: writes a Transfer submission AND
 * patches the asset's Current Location + Status in a single call.
 * This is the "workflow" that keeps Assets in sync with Transfers.
 */

export const appId = "asset-tracker";
export const apiPrefix = "/api/asset-tracker";
export const kapp = "asset-tracker";

const SUPPLY = "Supply";

function nowDate() { return new Date().toISOString().slice(0, 10); }
function pad5(n) { return String(n).padStart(5, "0"); }

// Decide the asset's new Status given the destination and reason.
function deriveStatus(toLocation, reason) {
  if (reason === "Decommission") return "Decommissioned";
  if (toLocation === SUPPLY)     return "In Supply";
  return "Active";
}

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // ── GET /api/asset-tracker/dashboard ──────────────────────────────────────
  if (pathname === "/api/asset-tracker/dashboard" && req.method === "GET") {
    try {
      const [assets, locations, transfers] = await Promise.all([
        collect("assets", null, 8),
        collect("locations", null, 8),
        collect("transfers", null, 8),
      ]);

      const byStatus = {};
      const byLocation = {};
      const byType = {};
      for (const a of assets) {
        const st = vf(a, "Status") || "Unknown";
        byStatus[st] = (byStatus[st] || 0) + 1;
        const loc = vf(a, "Current Location") || "(none)";
        byLocation[loc] = (byLocation[loc] || 0) + 1;
        const tp = vf(a, "Asset Type") || "Unknown";
        byType[tp] = (byType[tp] || 0) + 1;
      }

      const topLocations = Object.entries(byLocation)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ name, count }));

      const recentTransfers = transfers
        .slice()
        .sort((a, b) => (vf(b, "Transfer Date") || "").localeCompare(vf(a, "Transfer Date") || ""))
        .slice(0, 10)
        .map(t => ({
          id: t.id,
          transferId: vf(t, "Transfer ID"),
          assetTag: vf(t, "Asset Tag"),
          from: vf(t, "From Location"),
          to: vf(t, "To Location"),
          date: vf(t, "Transfer Date"),
          reason: vf(t, "Reason"),
          status: vf(t, "Status"),
          by: vf(t, "Transferred By"),
        }));

      jsonResp(res, 200, {
        kpis: {
          totalAssets: assets.length,
          totalLocations: locations.length,
          totalTransfers: transfers.length,
          inSupply: byStatus["In Supply"] || 0,
          decommissioned: byStatus["Decommissioned"] || 0,
          active: byStatus["Active"] || 0,
          inTransit: byStatus["In Transit"] || 0,
        },
        byStatus, byType, topLocations, recentTransfers,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── POST /api/asset-tracker/transfer ──────────────────────────────────────
  // Body: { assetTag, toLocation, reason, transferredBy, newAssignedPerson?, notes? }
  // Creates a Transfer record AND patches the asset in one call.
  if (pathname === "/api/asset-tracker/transfer" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const { assetTag, toLocation, reason, transferredBy } = body;
      if (!assetTag || !toLocation || !reason) {
        jsonResp(res, 400, { error: "assetTag, toLocation, and reason are required" });
        return true;
      }

      // Find the asset
      const assets = await collect("assets", `values[Asset Tag] = "${assetTag}"`, 1);
      if (assets.length === 0) {
        jsonResp(res, 404, { error: `Asset not found: ${assetTag}` });
        return true;
      }
      const asset = assets[0];
      const fromLocation = vf(asset, "Current Location") || "";
      const serial = vf(asset, "Serial Number") || "";

      // Verify destination exists (skip for Supply — always exists by convention)
      if (toLocation !== SUPPLY) {
        const dest = await collect("locations", `values[Location Name] = "${toLocation}"`, 1);
        if (dest.length === 0) {
          jsonResp(res, 400, { error: `Destination location not found: ${toLocation}` });
          return true;
        }
      }

      // Compute next Transfer ID. Count is cheap enough here.
      const existing = await collect("transfers", null, 12);
      const nextNum = existing.length + 1;
      const transferId = `TR-${pad5(nextNum)}`;

      // 1. Create the Transfer record
      const newStatus = deriveStatus(toLocation, reason);
      const newAssignedPerson = (toLocation === SUPPLY) ? "" : (body.newAssignedPerson || vf(asset, "Assigned Person") || "");

      const trResp = await kineticRequest("POST", `/kapps/${KAPP}/forms/transfers/submissions`, {
        values: {
          "Transfer ID": transferId,
          "Asset Tag": assetTag,
          "Asset Serial": serial,
          "From Location": fromLocation,
          "To Location": toLocation,
          "Transfer Date": nowDate(),
          "Reason": reason,
          "Status": "Completed",
          "Transferred By": transferredBy || "system",
          "New Assigned Person": newAssignedPerson,
          "Notes": body.notes || "",
        },
        coreState: "Submitted",
      }, auth);

      if (trResp.status >= 300) {
        jsonResp(res, 500, { error: "Failed to create transfer record", detail: trResp.data });
        return true;
      }

      // 2. Patch the Asset
      const assetUpdate = {
        "Current Location": toLocation,
        "Status": newStatus,
        "Assigned Person": newAssignedPerson,
      };
      const upResp = await kineticRequest("PUT", `/submissions/${asset.id}`, { values: assetUpdate }, auth);
      if (upResp.status >= 300) {
        // Transfer record was written but asset failed to update — report partial
        jsonResp(res, 207, {
          warning: "Transfer recorded but asset update failed",
          transferId,
          assetUpdateError: upResp.data,
        });
        return true;
      }

      jsonResp(res, 200, {
        success: true,
        transferId,
        asset: {
          tag: assetTag,
          previousLocation: fromLocation,
          currentLocation: toLocation,
          status: newStatus,
          assignedPerson: newAssignedPerson,
        },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/asset-tracker/asset/:tag/history ─────────────────────────────
  const histMatch = pathname.match(/^\/api\/asset-tracker\/asset\/([^/]+)\/history$/);
  if (histMatch && req.method === "GET") {
    const at = decodeURIComponent(histMatch[1]);
    try {
      const [assetArr, trArr] = await Promise.all([
        collect("assets", `values[Asset Tag] = "${at}"`, 1),
        collect("transfers", `values[Asset Tag] = "${at}"`, 4),
      ]);
      if (assetArr.length === 0) { jsonResp(res, 404, { error: "Asset not found" }); return true; }
      const asset = assetArr[0];
      const sorted = trArr.slice().sort((a, b) => (vf(b, "Transfer Date") || "").localeCompare(vf(a, "Transfer Date") || ""));
      jsonResp(res, 200, {
        asset: { id: asset.id, ...asset.values },
        transfers: sorted.map(t => ({ id: t.id, ...t.values })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
