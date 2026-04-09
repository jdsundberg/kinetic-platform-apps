/**
 * Innovation Intake — Custom API Handler
 */

export const appId = "innovation";
export const apiPrefix = "/api/innovation";
export const kapp = "innovation";

// ─── App-specific helpers ──────────────────────────────────────────────────

function nowISO() { return new Date().toISOString(); }
const VALID_TRANSITIONS = {
  "Submitted": ["Under Review"],
  "Under Review": ["Needs Clarification", "Approved", "Rejected", "Merged", "Redirected"],
  "Needs Clarification": ["Under Review"],
  "Approved": ["Ready for AI Build"],
};

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }


  // GET /api/innovation/stats
  if (pathname === "/api/innovation/stats" && req.method === "GET") {
    try {
      const [proposals, reviews] = await Promise.all([
        collect("proposals", null, 8),
        collect("reviews", null, 4),
      ]);

      const byStatus = {};
      const byCategory = {};
      let totalInnovation = 0, totalOverlap = 0, totalAlign = 0, scoredCount = 0;
      let decidedCount = 0, totalDaysToDecision = 0;

      for (const p of proposals) {
        const st = vf(p, "Status") || "Unknown";
        byStatus[st] = (byStatus[st] || 0) + 1;
        const cat = vf(p, "Category") || "Uncategorized";
        byCategory[cat] = (byCategory[cat] || 0) + 1;

        const inn = parseInt(vf(p, "Innovation Score"));
        const ovr = parseInt(vf(p, "Overlap Risk Score"));
        const ali = parseInt(vf(p, "Strategic Alignment Score"));
        if (inn) { totalInnovation += inn; totalOverlap += (ovr || 0); totalAlign += (ali || 0); scoredCount++; }

        const subAt = vf(p, "Submitted At");
        const decAt = vf(p, "Decided At");
        if (subAt && decAt) {
          totalDaysToDecision += (new Date(decAt).getTime() - new Date(subAt).getTime()) / 86400000;
          decidedCount++;
        }
      }

      const recentDecisions = proposals
        .filter(p => vf(p, "Decision"))
        .sort((a, b) => (vf(b, "Decided At") || "").localeCompare(vf(a, "Decided At") || ""))
        .slice(0, 10)
        .map(p => ({
          id: p.id,
          proposalId: vf(p, "Proposal ID"),
          appName: vf(p, "App Name"),
          decision: vf(p, "Decision"),
          decidedAt: vf(p, "Decided At"),
          category: vf(p, "Category"),
        }));

      jsonResp(res, 200, {
        total: proposals.length,
        byStatus,
        byCategory,
        avgScores: scoredCount > 0 ? {
          innovation: (totalInnovation / scoredCount).toFixed(1),
          overlapRisk: (totalOverlap / scoredCount).toFixed(1),
          alignment: (totalAlign / scoredCount).toFixed(1),
        } : null,
        avgDaysToDecision: decidedCount > 0 ? (totalDaysToDecision / decidedCount).toFixed(1) : null,
        totalReviews: reviews.length,
        recentDecisions,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/innovation/proposals/:id/transition
  const transMatch = pathname.match(/^\/api\/innovation\/proposals\/([^/]+)\/transition$/);
  if (transMatch && req.method === "POST") {
    try {
      const submissionId = transMatch[1];
      const body = JSON.parse(await readBody(req));
      const { newStatus, notes, user, displayName } = body;

      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};
      const currentStatus = vals["Status"];

      const allowed = VALID_TRANSITIONS[currentStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${currentStatus}" to "${newStatus}"` });
        return true;
      }

      const updates = { Status: newStatus };
      if (newStatus === "Under Review" && currentStatus === "Submitted") {
        updates["Reviewed At"] = nowISO();
        if (user) updates["Assigned Reviewer"] = user;
      }
      if (["Approved", "Rejected", "Merged", "Redirected"].includes(newStatus)) {
        updates["Decided At"] = nowISO();
      }
      if (newStatus === "Approved") {
        updates["Approved At"] = nowISO();
        updates["Approved By"] = user || "";
        updates["Approved Prompt"] = vals["Custom AI Prompt"] || "";
      }

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, updates, auth);

      await kineticRequest("POST", `/kapps/${KAPP}/forms/comments/submissions`, {
        values: {
          "Proposal ID": vals["Proposal ID"] || "",
          Author: user || "",
          "Author Display Name": displayName || user || "",
          Type: "Status Change",
          Content: notes || `Status changed from ${currentStatus} to ${newStatus}`,
          Timestamp: nowISO(),
          "Previous Value": currentStatus,
          "New Value": newStatus,
          "Field Changed": "Status",
        }
      }, auth);

      jsonResp(res, 200, { success: true, previousStatus: currentStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/innovation/proposals/:id/decide
  const decideMatch = pathname.match(/^\/api\/innovation\/proposals\/([^/]+)\/decide$/);
  if (decideMatch && req.method === "POST") {
    try {
      const submissionId = decideMatch[1];
      const body = JSON.parse(await readBody(req));
      const { decision, reason, mergeTarget, redirectTarget, user, displayName,
              innovationScore, overlapRiskScore, alignmentScore, complexity } = body;

      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};

      const statusMap = { Approved: "Approved", Rejected: "Rejected", Merged: "Merged", Redirected: "Redirected" };
      const newStatus = statusMap[decision];
      if (!newStatus) { jsonResp(res, 400, { error: "Invalid decision" }); return true; }

      const updates = {
        Decision: decision,
        "Decision Reason": reason || "",
        Status: newStatus,
        "Decided At": nowISO(),
      };
      if (innovationScore) updates["Innovation Score"] = String(innovationScore);
      if (overlapRiskScore) updates["Overlap Risk Score"] = String(overlapRiskScore);
      if (alignmentScore) updates["Strategic Alignment Score"] = String(alignmentScore);
      if (complexity) updates["Complexity"] = complexity;
      if (mergeTarget) updates["Merge Target"] = mergeTarget;
      if (redirectTarget) updates["Redirect Target"] = redirectTarget;

      if (decision === "Approved") {
        updates["Approved At"] = nowISO();
        updates["Approved By"] = user || "";
        updates["Approved Prompt"] = vals["Custom AI Prompt"] || "";

        // Mark current prompt version as approved
        const promptVersions = await collect("prompt-versions",
          `values[Proposal ID]="${vals["Proposal ID"]}"`, auth, 2);
        const latestVersion = promptVersions
          .sort((a, b) => parseInt(vf(b, "Version") || "0") - parseInt(vf(a, "Version") || "0"))[0];
        if (latestVersion) {
          await kineticRequest("PUT", `/submissions/${latestVersion.id}/values`,
            { "Is Approved": "true" }, auth);
        }
      }

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, updates, auth);

      await kineticRequest("POST", `/kapps/${KAPP}/forms/comments/submissions`, {
        values: {
          "Proposal ID": vals["Proposal ID"] || "",
          Author: user || "",
          "Author Display Name": displayName || user || "",
          Type: "Audit",
          Content: `Decision: ${decision}. ${reason || ""}`.trim(),
          Timestamp: nowISO(),
          "Previous Value": vals["Status"] || "",
          "New Value": newStatus,
          "Field Changed": "Decision",
        }
      }, auth);

      jsonResp(res, 200, { success: true, decision, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/innovation/proposals/:id/newapp-md
  const mdMatch = pathname.match(/^\/api\/innovation\/proposals\/([^/]+)\/newapp-md$/);
  if (mdMatch && req.method === "GET") {
    try {
      const submissionId = mdMatch[1];
      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};
      const pid = vals["Proposal ID"] || "UNKNOWN";

      const [reviews, comments] = await Promise.all([
        collect("reviews", `values[Proposal ID]="${pid}"`, 2),
        collect("comments", `values[Proposal ID]="${pid}"`, 4),
      ]);

      const prompt = vals["Approved Prompt"] || vals["Custom AI Prompt"] || "(no prompt)";
      const review = reviews[0];

      let md = `# ${vals["App Name"] || "Untitled"}\n\n`;
      md += `**Proposal ID:** ${pid}\n`;
      md += `**Category:** ${vals["Category"] || "N/A"}\n`;
      md += `**Status:** ${vals["Status"] || "N/A"}\n`;
      md += `**Submitted:** ${vals["Submitted At"] || "N/A"}\n`;
      md += `**Approved:** ${vals["Approved At"] || "N/A"}\n`;
      md += `**Approved By:** ${vals["Approved By"] || "N/A"}\n\n`;

      md += `## Business Justification\n\n${vals["Business Justification"] || "N/A"}\n\n`;
      md += `## Goals & Outcomes\n\n${vals["Goals Outcomes"] || "N/A"}\n\n`;
      md += `## Target Users\n\n${vals["Target Users"] || "N/A"}\n\n`;
      md += `## Expected Business Impact\n\n${vals["Expected Business Impact"] || "N/A"}\n\n`;

      if (vals["Known Alternatives"]) {
        md += `## Known Alternatives\n\n${vals["Known Alternatives"]}\n\n`;
      }

      md += `## Review Summary\n\n`;
      if (review) {
        md += `| Metric | Score |\n|---|---|\n`;
        md += `| Innovation | ${vf(review, "Innovation Score")}/10 |\n`;
        md += `| Overlap Risk | ${vf(review, "Overlap Risk Score")}/10 |\n`;
        md += `| Strategic Alignment | ${vf(review, "Strategic Alignment Score")}/10 |\n`;
        md += `| Complexity | ${vf(review, "Complexity Assessment") || vals["Complexity"] || "N/A"} |\n`;
        md += `| Cost Estimate | ${vf(review, "Cost Estimate") || "N/A"} |\n`;
        md += `| Risk Assessment | ${vf(review, "Risk Assessment") || "N/A"} |\n\n`;
        if (vf(review, "Overlap Analysis")) md += `**Overlap Analysis:** ${vf(review, "Overlap Analysis")}\n\n`;
        if (vf(review, "Similar Apps Found")) md += `**Similar Apps:** ${vf(review, "Similar Apps Found")}\n\n`;
        if (vf(review, "Recommendation Notes")) md += `**Reviewer Notes:** ${vf(review, "Recommendation Notes")}\n\n`;
      } else {
        md += `No formal review on file.\n\n`;
      }

      if (vals["Decision Reason"]) {
        md += `## Decision\n\n**${vals["Decision"] || "N/A"}:** ${vals["Decision Reason"]}\n\n`;
      }

      md += `## Approved AI Prompt\n\n\`\`\`\n${prompt}\n\`\`\`\n`;

      res.writeHead(200, {
        "Content-Type": "text/markdown",
        "Content-Disposition": `attachment; filename="${pid}-newapp.md"`,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
      });
      res.end(md);
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}

// ─── Standalone mode ───────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const http = await import("node:http");
  const https = await import("node:https");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const PORT = process.env.PORT || 3099;
  const KINETIC = process.env.KINETIC_URL || "https://localhost";
  const __dir = path.dirname(new URL(import.meta.url).pathname);

  function kineticRequest(method, apiPath, body, authHeader) {
    return new Promise((resolve, reject) => {
      const url = new URL(`/app/api/v1${apiPath}`, KINETIC);
      const headers = { "Content-Type": "application/json" };
      if (authHeader) headers["Authorization"] = authHeader;
      const payload = body ? JSON.stringify(body) : null;
      if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
      const r = https.request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
          catch { resolve({ status: res.statusCode, data: text }); }
        });
      });
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  function jsonResp(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
    res.end(JSON.stringify(data));
  }

  function readBody(req) {
    return new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c).toString())); });
  }

  async function collectByQuery(kappSlug, formSlug, kql, authHeader, maxPages = 8) {
    const all = []; let lastCreatedAt = null;
    for (let i = 0; i < maxPages; i++) {
      let url = `/kapps/${kappSlug}/forms/${formSlug}/submissions?include=values,details&limit=25`;
      let q = kql || "";
      if (lastCreatedAt) q = (q ? "(" + q + ") AND " : "") + `createdAt < "${lastCreatedAt}"`;
      if (q) url += `&q=${encodeURIComponent(q)}`;
      const r = await kineticRequest("GET", url, null, authHeader);
      const subs = r.data?.submissions || [];
      all.push(...subs);
      if (subs.length > 0) lastCreatedAt = subs[subs.length - 1].createdAt;
      if (!r.data?.nextPageToken || subs.length < 25) break;
    }
    return all;
  }

  const helpers = {
    kineticRequest, jsonResp, readBody, collectByQuery,
    vf: (s, f) => s.values?.[f] || "",
  };

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }); res.end(); return; }
    if (pathname.startsWith(apiPrefix)) {
      const handled = await handleAPI(req, res, pathname, req.headers.authorization, helpers);
      if (handled) return;
    }
    if (pathname.startsWith("/app/")) {
      const url = new URL(req.url, KINETIC);
      const headers = { ...req.headers, host: url.host }; delete headers.origin; delete headers.referer;
      const body = await readBody(req);
      const pr = https.request(url, { method: req.method, headers }, (pres) => {
        res.writeHead(pres.statusCode, { ...pres.headers, "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
        pres.pipe(res);
      });
      pr.on("error", e => { res.writeHead(502); res.end(e.message); });
      if (body.length) pr.write(body);
      pr.end(); return;
    }
    let fp = pathname === "/" ? "/index.html" : pathname;
    fp = path.join(__dir, fp);
    try { const c = fs.readFileSync(fp); res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(fp)] || "application/octet-stream" }); res.end(c); }
    catch { res.writeHead(404); res.end("Not found"); }
  });

  server.listen(PORT, () => console.log(`\n  Innovation Intake: http://localhost:${PORT}\n`));
}
