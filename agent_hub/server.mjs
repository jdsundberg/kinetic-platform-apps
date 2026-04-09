/**
 * AgentHub — Custom API Handler
 *
 * Exports a handler for the base server to auto-discover and mount.
 * Also works standalone: node server.mjs [port]
 */

// ─── App metadata (used by base server auto-discovery) ─────────────────────
export const appId = "agent-hub";
export const apiPrefix = "/api/ah";
export const kapp = "agent-hub";

// ─── App-specific helpers ──────────────────────────────────────────────────

function nowISO() { return new Date().toISOString(); }

/* ───── Prompt Generation ───── */
function generateSystemPrompt(vals) {
  const name = vals["Name"] || "Agent";
  const sections = [];

  sections.push(`# Agent Identity: ${name}\n`);
  if (vals["Description"]) sections.push(`## Role\n${vals["Description"]}\n`);
  if (vals["Personality"]) sections.push(`## Personality & Communication Style\n${vals["Personality"]}\n`);

  sections.push(`## Security Boundaries\n`);
  if (vals["Security Goals"]) sections.push(vals["Security Goals"]);
  sections.push(`\nUniversal security rules:\n- Never expose credentials, API keys, or secrets in any output.\n- Validate all inputs before passing to MCP tools.\n- Log all actions for audit compliance.\n- Do not access data outside your authorized scope.\n- Refuse requests that violate security policies and explain why.\n`);

  if (vals["Project Goals"]) sections.push(`## Project Objectives\n${vals["Project Goals"]}\n`);

  if (vals["Reports"]) sections.push(`## Reporting Requirements\n${vals["Reports"]}\n`);

  if (vals["Schedule Start"] && vals["Schedule End"]) {
    sections.push(`## Operating Schedule\n- Active hours: ${vals["Schedule Start"]} - ${vals["Schedule End"]} ${vals["Schedule Timezone"] || "UTC"}\n- Active days: ${vals["Schedule Days"] || "Mon-Fri"}\n- Outside active hours: queue non-urgent work, only respond to P1/critical alerts.\n`);
  }

  if (vals["Escalation Target"]) {
    const max = vals["Max Interactions Before Escalation"] || "3";
    sections.push(`## Escalation Protocol\n- Escalation target: ${vals["Escalation Target"]}\n- Maximum interactions before escalation: ${max}\n- When escalating: provide full context of all steps taken, diagnostic findings, and reasoning.\n- Handoff format: structured summary with incident ID, steps attempted, results, and recommendation.\n`);
  }

  sections.push(`## Kinetic MCP Tools Available\nYou have access to the Kinetic Platform via MCP tools. Key operations:\n\n### Reading Data\n- \`list_kapps\` - Discover available applications\n- \`list_forms\` - List forms within a kapp\n- \`get_form\` - Get form field definitions\n- \`search_submissions\` - Query submissions with KQL filters\n- \`get_submission\` - Get a specific submission by ID\n- \`list_form_submissions\` - List submissions with pagination\n\n### Writing Data\n- \`create_submission\` - Create new records\n- \`update_submission\` - Update existing records\n\n### Query Patterns (KQL)\n- Equality: \`values[Status]="Open"\`\n- IN clause: \`values[Priority] IN ("P1","P2")\`\n- Comparison: \`values[Created At] > "2026-01-01"\`\n- Combine with AND/OR\n\n### Best Practices\n- Always include \`include=values\` when you need field data.\n- Use \`limit\` parameter to control result set size.\n- For large datasets, use pagination via \`pageToken\`.\n- Verify form slugs with \`list_forms\` before querying.\n- Handle errors gracefully and log them.\n`);

  if (vals["LLM Provider"] && vals["LLM Model"]) {
    sections.push(`## Model Configuration\n- Provider: ${vals["LLM Provider"]}\n- Model: ${vals["LLM Model"]}\n- Be aware of your token limits and manage usage efficiently.\n- Prefer concise responses when possible to conserve tokens.\n`);
  }

  return sections.join("\n");
}

/* ───── Request approval transitions ───── */
const REQUEST_TRANSITIONS = {
  "Submitted":    ["Under Review", "Rejected"],
  "Under Review":  ["Approved", "Rejected", "Needs Info"],
  "Needs Info":    ["Under Review"],
  "Approved":      ["Deployed"],
  "Deployed":      ["Active"],
};

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // GET /api/ah/dashboard
  if (pathname === "/api/ah/dashboard" && req.method === "GET") {
    try {
      const [agents, runs, requests] = await Promise.all([
        collect("agent", null, 4),
        collect("agent-run", null, 4),
        collect("agent-request", null, 4),
      ]);

      let aiAgents = 0, humanAgents = 0, activeAgents = 0;
      let tokensToday = 0, tokensThisMonth = 0;
      const agentSummary = [];

      for (const a of agents) {
        const type = vf(a, "Type");
        const status = vf(a, "Status");
        if (type === "AI Agent") aiAgents++;
        if (type === "Human Agent") humanAgents++;
        if (status === "Active") activeAgents++;
        tokensToday += parseInt(vf(a, "Tokens Used Today")) || 0;
        tokensThisMonth += parseInt(vf(a, "Tokens Used This Month")) || 0;
        agentSummary.push({
          id: a.id, agentId: vf(a, "Agent ID"), name: vf(a, "Name"),
          type, status, photo: vf(a, "Photo URL"),
          tokensToday: parseInt(vf(a, "Tokens Used Today")) || 0,
          tokensThisMonth: parseInt(vf(a, "Tokens Used This Month")) || 0,
          tokenMaxDaily: parseInt(vf(a, "Token Max Daily")) || 0,
          model: vf(a, "LLM Model"), provider: vf(a, "LLM Provider"),
          schedule: vf(a, "Schedule Start") ? `${vf(a, "Schedule Start")}-${vf(a, "Schedule End")} ${vf(a, "Schedule Timezone")}` : "24/7",
        });
      }

      const today = new Date().toISOString().slice(0, 10);
      let escalationsToday = 0, errorsToday = 0;
      const recentRuns = runs
        .sort((a, b) => (vf(b, "Started At") || "").localeCompare(vf(a, "Started At") || ""))
        .slice(0, 10)
        .map(r => {
          const outcome = vf(r, "Final Outcome");
          const startedAt = vf(r, "Started At") || "";
          if (startedAt.startsWith(today)) {
            if (outcome === "Escalated") escalationsToday++;
            if (outcome === "Error") errorsToday++;
          }
          return {
            id: r.id, runId: vf(r, "Run ID"), agentName: vf(r, "Agent Name"),
            trigger: vf(r, "Trigger"), outcome, startedAt,
            duration: vf(r, "Duration Seconds"), tokens: vf(r, "Total Tokens"),
            steps: vf(r, "Steps Count"), escalatedTo: vf(r, "Escalated To"),
            summary: vf(r, "Summary"),
          };
        });

      // Request stats
      const requestsByStatus = {};
      for (const r of requests) {
        const st = vf(r, "Status") || "Unknown";
        requestsByStatus[st] = (requestsByStatus[st] || 0) + 1;
      }

      jsonResp(res, 200, {
        kpis: { activeAgents, aiAgents, humanAgents, tokensToday, tokensThisMonth, escalationsToday, errorsToday, totalRuns: runs.length },
        agentSummary, recentRuns,
        requestStats: { total: requests.length, byStatus: requestsByStatus },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/ah/agents/:id/generate-prompt
  const genMatch = pathname.match(/^\/api\/ah\/agents\/([^/]+)\/generate-prompt$/);
  if (genMatch && req.method === "POST") {
    try {
      const submissionId = genMatch[1];
      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};

      if (vals["Type"] === "Human Agent") {
        jsonResp(res, 400, { error: "Cannot generate prompts for human agents" });
        return true;
      }

      const prompt = generateSystemPrompt(vals);
      const ts = nowISO();

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, {
        "Generated Prompt": prompt,
        "Last Prompt Generated": ts,
      }, auth);

      jsonResp(res, 200, { prompt, generatedAt: ts, charCount: prompt.length });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/ah/agents/:id/runs
  const agentRunsMatch = pathname.match(/^\/api\/ah\/agents\/([^/]+)\/runs$/);
  if (agentRunsMatch && req.method === "GET") {
    try {
      const submissionId = agentRunsMatch[1];
      const agent = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const agentName = agent.data?.submission?.values?.["Name"] || "";

      const allRuns = await collect("agent-run", null, 4);
      const runs = allRuns.filter(r => vf(r, "Agent Name") === agentName);
      const result = runs
        .sort((a, b) => (vf(b, "Started At") || "").localeCompare(vf(a, "Started At") || ""))
        .map(r => ({
          id: r.id, runId: vf(r, "Run ID"), trigger: vf(r, "Trigger"),
          outcome: vf(r, "Final Outcome"), startedAt: vf(r, "Started At"),
          endedAt: vf(r, "Ended At"), duration: vf(r, "Duration Seconds"),
          tokens: vf(r, "Total Tokens"), steps: vf(r, "Steps Count"),
          escalatedTo: vf(r, "Escalated To"), summary: vf(r, "Summary"),
        }));

      jsonResp(res, 200, { agentName, runs: result });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/ah/runs/:id/steps
  const stepsMatch = pathname.match(/^\/api\/ah\/runs\/([^/]+)\/steps$/);
  if (stepsMatch && req.method === "GET") {
    try {
      const submissionId = stepsMatch[1];
      const run = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const runId = run.data?.submission?.values?.["Run ID"] || "";

      const allSteps = await collect("agent-run-step", null, 4);
      const steps = allSteps.filter(s => vf(s, "Run ID") === runId);
      const result = steps
        .sort((a, b) => (parseInt(vf(a, "Step Number")) || 0) - (parseInt(vf(b, "Step Number")) || 0))
        .map(s => ({
          id: s.id, stepId: vf(s, "Step ID"), runId: vf(s, "Run ID"),
          agentName: vf(s, "Agent Name"), stepNumber: parseInt(vf(s, "Step Number")) || 0,
          timestamp: vf(s, "Timestamp"), actionType: vf(s, "Action Type"),
          functionCalled: vf(s, "Function Called"),
          functionParameters: vf(s, "Function Parameters"),
          functionResultSummary: vf(s, "Function Result Summary"),
          reasoning: vf(s, "Reasoning"), tokensUsed: vf(s, "Tokens Used"),
          durationMs: vf(s, "Duration Ms"), status: vf(s, "Status"),
          errorDetail: vf(s, "Error Detail"),
        }));

      jsonResp(res, 200, { runId, steps: result });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/ah/requests
  if (pathname === "/api/ah/requests" && req.method === "GET") {
    try {
      const requests = await collect("agent-request", null, 4);
      const result = requests
        .sort((a, b) => (vf(b, "Submitted At") || "").localeCompare(vf(a, "Submitted At") || ""))
        .map(r => ({
          id: r.id, requestId: vf(r, "Request ID"),
          requester: vf(r, "Requester"), requesterName: vf(r, "Requester Display Name"),
          agentName: vf(r, "Agent Name"), agentType: vf(r, "Agent Type"),
          justification: vf(r, "Justification"), goals: vf(r, "Goals"),
          budget: vf(r, "Budget"), organization: vf(r, "Organization"),
          dateNeeded: vf(r, "Date Needed"), duration: vf(r, "Duration"),
          status: vf(r, "Status"), submittedAt: vf(r, "Submitted At"),
          reviewedBy: vf(r, "Reviewed By"), reviewedAt: vf(r, "Reviewed At"),
          reviewNotes: vf(r, "Review Notes"),
          approvedBy: vf(r, "Approved By"), approvedAt: vf(r, "Approved At"),
          deployedAt: vf(r, "Deployed At"),
        }));
      jsonResp(res, 200, { requests: result });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/ah/requests/:id/transition
  const reqTransMatch = pathname.match(/^\/api\/ah\/requests\/([^/]+)\/transition$/);
  if (reqTransMatch && req.method === "POST") {
    try {
      const submissionId = reqTransMatch[1];
      const body = JSON.parse(await readBody(req));
      const { newStatus, notes, user, displayName } = body;

      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};
      const currentStatus = vals["Status"];

      const allowed = REQUEST_TRANSITIONS[currentStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${currentStatus}" to "${newStatus}"` });
        return true;
      }

      const updates = { Status: newStatus };

      if (newStatus === "Under Review") {
        updates["Reviewed By"] = user || "";
        updates["Reviewed At"] = nowISO();
      }
      if (newStatus === "Approved") {
        updates["Approved By"] = user || "";
        updates["Approved At"] = nowISO();
      }
      if (newStatus === "Deployed") {
        updates["Deployed At"] = nowISO();
      }
      if (notes) {
        updates["Review Notes"] = (vals["Review Notes"] ? vals["Review Notes"] + "\n\n" : "") +
          `[${nowISO()}] ${user || "System"}: ${notes}`;
      }
      if (newStatus === "Rejected" && notes) {
        updates["Review Notes"] = (vals["Review Notes"] ? vals["Review Notes"] + "\n\n" : "") +
          `[${nowISO()}] REJECTED by ${user || "System"}: ${notes}`;
      }

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, updates, auth);

      jsonResp(res, 200, { success: true, previousStatus: currentStatus, newStatus });
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

  const PORT = process.env.PORT || 3019;
  const KINETIC = process.env.KINETIC_URL || "https://first.kinetics.com";
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

  server.listen(PORT, () => console.log(`\n  AgentHub: http://localhost:${PORT}\n`));
}
