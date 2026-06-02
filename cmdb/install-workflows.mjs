#!/usr/bin/env node
/**
 * Install CMDB WebAPIs + Routines on ai-labs.kinopsdev.io
 *
 * 5 WebAPIs (kapp 'cmdb'):
 *   GET  /lookup?name=&fqdn=&ip=&ciNumber=&class=
 *   GET  /ci?class=&id=                        — CI + outgoing/incoming relationships
 *   GET  /impact?class=&id=                    — first-hop services impacted
 *   POST /upsert                               — body: { class, values }
 *   POST /relate                               — body: { sourceClass, sourceCiNumber, targetClass, targetCiNumber, type }
 *
 * 4 Global Routines:
 *   Cmdb Ci Lookup     inputs: Class, CI Number               outputs: Found, CI Json
 *   Cmdb Ci Upsert     inputs: Class, Values Json             outputs: Mode, CI Number
 *   Cmdb Relate        inputs: Source Class, Source CI Number, Target Class, Target CI Number, Type
 *                                                             outputs: Mode, Relationship Id
 *   Cmdb Impact Summary inputs: Class, CI Number              outputs: Affected Services
 *
 * Each WebAPI tree:
 *   start -> kinetic_core_api_connection_v1 -> system_tree_return_v1 (content_type=application/json)
 *
 * Each routine: same shape but final node is the routine return.
 *
 * Run:  node apps/cmdb/install-workflows.mjs [--server URL] [--user U] [--pass P]
 */
import https from "node:https";
import path from "node:path";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const args = process.argv.slice(2);
function arg(name, dflt) { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : dflt; }
const SERVER = arg("server", "https://ai-labs.kinopsdev.io");
const USER = arg("user", "john");
const PASS = arg("pass", "john7");
const KAPP = "cmdb";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

function req(method, p, body, base = "/app/api/v1") {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}${p}`, SERVER);
    const headers = { "Content-Type": "application/json", "Authorization": AUTH };
    const payload = body ? JSON.stringify(body) : null;
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
    const r = https.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
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
const taskReq = (m, p, b) => req(m, p, b, "/app/components/task/app/api/v2");
function ok(s) { return s >= 200 && s < 300; }
function tag(t) { return ({ ok: "\x1b[32m✔\x1b[0m", warn: "\x1b[33m⚠\x1b[0m", fail: "\x1b[31m✗\x1b[0m" })[t] || "·"; }
function log(step, msg, t = "") { console.log(`${tag(t)}  [${step.padEnd(10)}] ${msg}`); }

/* ─── Helpers to build common nodes ──────────────────────────────────── */
function startNode(toNode) {
  return {
    configured: true, defers: false, deferrable: false, visible: false,
    name: "Start", messages: [{ type: "Complete", value: "" }], id: "start",
    position: { x: 100, y: 50 }, version: 1, parameters: [], definitionId: "system_start_v1",
  };
}
function coreApiNode(id, name, method, path, body = "", x = 280, y = 200) {
  return {
    configured: true, defers: false, deferrable: false, visible: true,
    name, messages: [{ type: "Complete", value: "" }], id,
    position: { x, y }, version: 1,
    parameters: [
      { id: "method", value: method },
      { id: "path", value: path },
      { id: "body", value: body },
      { id: "extra_headers", value: "" },
      { id: "error_handling", value: "Error Message" },
    ],
    definitionId: "kinetic_core_api_connection_v1",
  };
}
function webApiReturnNode(id, contentExpr, x = 520, y = 200, code = "200") {
  return {
    configured: true, defers: false, deferrable: false, visible: true,
    name: "Return", messages: [{ type: "Complete", value: "" }], id,
    position: { x, y }, version: 1,
    parameters: [
      { id: "content", value: contentExpr },
      { id: "content_type", value: "application/json" },
      { id: "response_code", value: code },
      { id: "headers_json", value: "{}" },
    ],
    definitionId: "system_tree_return_v1",
  };
}
function routineReturnNode(id, outputs, x = 520, y = 200) {
  // outputs: [{ id: "Param Name", value: "<%= ... %>" }, ...]
  return {
    configured: true, defers: false, deferrable: false, visible: true,
    name: "Return", messages: [{ type: "Complete", value: "" }], id,
    position: { x, y }, version: 1,
    parameters: outputs,
    definitionId: "system_tree_return_v1",
  };
}
function connector(from, to, label = "", value = "") {
  return { from, to, type: "Complete", label, value };
}

/* ─── Build all five WebAPI trees ────────────────────────────────────── */
/**
 * Each tree:
 *   start → main core api call → return
 * For more complex shapes (e.g. /ci needs CI fetch + relationships fetch + assemble)
 * we chain multiple core api nodes and reference all results in the final ERB.
 */

const TREES = {};
const WEBAPIS = [];
const ROUTINES = [];

/* ─────────────────────────────────────────────────────────────────────
   WebAPI 1: GET /lookup
   Reads @request['Parameters']['name'|'fqdn'|'ip'|'ciNumber'|'class']
   Strategy: iterate CI classes (server-side via ERB), call core API with
   single KQL filter, return first match.

   For a single core-api-handler tree we can only call one path. We use
   the 'class' query param to pick the form to search; if absent, default
   to "servers". Multi-class fan-out is left to the impact endpoint.
   ───────────────────────────────────────────────────────────────────── */
TREES["lookup"] = {
  schemaVersion: "1.0", lastId: 3, name: "lookup", notes: "Find a CI by ciNumber, name, fqdn, or ip. Query param 'class' picks the form (default: servers).",
  nodes: [
    startNode(),
    coreApiNode("kinetic_core_api_connection_v1_2", "Search CI",
      "GET",
      `<%=
        require 'uri'
        params = {}
        begin
          require 'uri'; q=@request['Query'].to_s; URI.decode_www_form(q).each { |k,v| params[k.to_s] = v.to_s } unless q.empty?
        rescue
        end
        cls = (params['class'] || 'servers')
        cls = 'servers' if cls.to_s.empty?
        ci_num = (params['ciNumber'] || '').to_s
        fqdn = (params['fqdn'] || '').to_s
        ip = (params['ip'] || '').to_s
        name = (params['name'] || '').to_s
        kql = nil
        if !ci_num.empty?
          kql = 'values[CI Number] = "' + ci_num + '"'
        elsif !fqdn.empty?
          kql = 'values[FQDN] = "' + fqdn + '"'
        elsif !ip.empty?
          kql = 'values[IP Address] = "' + ip + '"'
        elsif !name.empty?
          kql = 'values[Name] = "' + name + '"'
        end
        '/app/api/v1/kapps/cmdb/forms/' + cls + '/submissions?include=values&limit=1' + (kql ? '&q=' + URI.encode_www_form_component(kql) : '')
      %>`),
    webApiReturnNode("system_tree_return_v1_3",
      `<%=
        require 'json'
        params = {}
        begin
          require 'uri'; q=@request['Query'].to_s; URI.decode_www_form(q).each { |k,v| params[k.to_s] = v.to_s } unless q.empty?
        rescue
        end
        cls = params['class'] || 'servers'
        body = @results['Search CI']['Response Body']
        parsed = body && !body.to_s.empty? ? JSON.parse(body) : {}
        subs = parsed['submissions'] || []
        if subs.empty?
          { error: 'Not found', class: cls, query: params }.to_json
        else
          s = subs.first
          v = s['values'] || {}
          { ci: { class: cls, ciNumber: v['CI Number'], name: v['Name'], submissionId: s['id'], values: v } }.to_json
        end
      %>`),
  ],
  connectors: [
    connector("start", "kinetic_core_api_connection_v1_2"),
    connector("kinetic_core_api_connection_v1_2", "system_tree_return_v1_3"),
  ],
};

/* ─────────────────────────────────────────────────────────────────────
   WebAPI 2: GET /ci?class=&id=
   Returns the CI + outgoing relationships in one fetch.
   ───────────────────────────────────────────────────────────────────── */
TREES["ci"] = {
  schemaVersion: "1.0", lastId: 4, name: "ci", notes: "Get a CI by class+CI Number, plus its outgoing relationships.",
  nodes: [
    startNode(),
    coreApiNode("kinetic_core_api_connection_v1_2", "Fetch CI", "GET",
      `<%=
        require 'uri'
        params = {}
        begin
          require 'uri'; q=@request['Query'].to_s; URI.decode_www_form(q).each { |k,v| params[k.to_s] = v.to_s } unless q.empty?
        rescue
        end
        cls = (params['class'] || '')
        id  = (params['id'] || '')
        '/app/api/v1/kapps/cmdb/forms/' + cls + '/submissions?include=values&limit=1&q=' + URI.encode_www_form_component('values[CI Number] = "' + id + '"')
      %>`, "", 280, 140),
    coreApiNode("kinetic_core_api_connection_v1_3", "Fetch Relationships", "GET",
      `<%=
        require 'uri'
        params = {}
        begin
          require 'uri'; q=@request['Query'].to_s; URI.decode_www_form(q).each { |k,v| params[k.to_s] = v.to_s } unless q.empty?
        rescue
        end
        id = (params['id'] || '')
        '/app/api/v1/kapps/cmdb/forms/relationships/submissions?include=values&limit=25&q=' + URI.encode_www_form_component('values[Source CI Number] = "' + id + '"')
      %>`, "", 280, 280),
    webApiReturnNode("system_tree_return_v1_4",
      `<%=
        require 'json'
        params = {}
        begin
          require 'uri'; q=@request['Query'].to_s; URI.decode_www_form(q).each { |k,v| params[k.to_s] = v.to_s } unless q.empty?
        rescue
        end
        cls = (params['class'] || '')
        id  = (params['id'] || '')
        ci_body = @results['Fetch CI']['Response Body']
        rel_body = @results['Fetch Relationships']['Response Body']
        ci = ci_body && !ci_body.to_s.empty? ? (JSON.parse(ci_body)['submissions'] || []).first : nil
        rels = rel_body && !rel_body.to_s.empty? ? (JSON.parse(rel_body)['submissions'] || []) : []
        if ci.nil?
          { error: 'Not found', class: cls, id: id }.to_json
        else
          outgoing = rels.select { |r| (r['values']||{})['Source Class'] == cls }.map { |r| { type: r['values']['Type'], targetClass: r['values']['Target Class'], targetCiNumber: r['values']['Target CI Number'], targetName: r['values']['Target Name'] } }
          { ci: { class: cls, ciNumber: id, submissionId: ci['id'], values: ci['values'] || {} }, outgoing: outgoing }.to_json
        end
      %>`, 520, 200),
  ],
  connectors: [
    connector("start", "kinetic_core_api_connection_v1_2"),
    connector("kinetic_core_api_connection_v1_2", "kinetic_core_api_connection_v1_3"),
    connector("kinetic_core_api_connection_v1_3", "system_tree_return_v1_4"),
  ],
};

/* ─────────────────────────────────────────────────────────────────────
   WebAPI 3: GET /impact?class=&id=
   First-hop impact: returns relationships *into* this CI, surfacing
   services that depend on it directly.
   ───────────────────────────────────────────────────────────────────── */
TREES["impact"] = {
  schemaVersion: "1.0", lastId: 3, name: "impact", notes: "First-hop impact analysis — incoming relationships and services depending on this CI.",
  nodes: [
    startNode(),
    coreApiNode("kinetic_core_api_connection_v1_2", "Fetch Incoming Rels", "GET",
      `<%=
        require 'uri'
        params = {}
        begin
          require 'uri'; q=@request['Query'].to_s; URI.decode_www_form(q).each { |k,v| params[k.to_s] = v.to_s } unless q.empty?
        rescue
        end
        id = (params['id'] || '')
        '/app/api/v1/kapps/cmdb/forms/relationships/submissions?include=values&limit=25&q=' + URI.encode_www_form_component('values[Target CI Number] = "' + id + '"')
      %>`),
    webApiReturnNode("system_tree_return_v1_3",
      `<%=
        require 'json'
        params = {}
        begin
          require 'uri'; q=@request['Query'].to_s; URI.decode_www_form(q).each { |k,v| params[k.to_s] = v.to_s } unless q.empty?
        rescue
        end
        cls = (params['class'] || '')
        id  = (params['id'] || '')
        body = @results['Fetch Incoming Rels']['Response Body']
        rels = body && !body.to_s.empty? ? (JSON.parse(body)['submissions'] || []) : []
        rels = rels.select { |r| (r['values']||{})['Target Class'] == cls }
        depending = rels.map { |r| { sourceClass: r['values']['Source Class'], sourceCiNumber: r['values']['Source CI Number'], sourceName: r['values']['Source Name'], type: r['values']['Type'] } }
        affected_svcs = depending.select { |d| d[:sourceClass] == 'services' }
        { rootClass: cls, rootCiNumber: id, firstHopCount: depending.length, depending: depending, affectedServices: affected_svcs }.to_json
      %>`),
  ],
  connectors: [
    connector("start", "kinetic_core_api_connection_v1_2"),
    connector("kinetic_core_api_connection_v1_2", "system_tree_return_v1_3"),
  ],
};

/* ─────────────────────────────────────────────────────────────────────
   WebAPI 4: POST /upsert
   Body: { class, values }   or query params
   Creates if no existing matching CI Number, else updates values.
   Two-step: look up existing → POST or PUT.
   ───────────────────────────────────────────────────────────────────── */
TREES["upsert"] = {
  schemaVersion: "1.0", lastId: 5, name: "upsert", notes: "Upsert a CI. Idempotent on CI Number. Body: { class, values }.",
  nodes: [
    startNode(),
    coreApiNode("kinetic_core_api_connection_v1_2", "Find Existing", "GET",
      `<%=
        require 'json'
        body = (@request['Body'] || @request['body']).to_s
        parsed = body.empty? ? {} : JSON.parse(body)
        cls = (parsed['class'] || params['class'] || '').to_s
        values = parsed['values'] || {}
        ci_number = (values['CI Number'] || params['ciNumber'] || '').to_s
        if ci_number.empty?
          '/app/api/v1/kapps/cmdb/forms/' + cls + '/submissions?include=values&limit=1&q=' + URI.encode_www_form_component('values[CI Number] = "__nope__"')
        else
          '/app/api/v1/kapps/cmdb/forms/' + cls + '/submissions?include=values&limit=1&q=' + URI.encode_www_form_component('values[CI Number] = "' + ci_number + '"')
        end
      %>`, "", 280, 140),
    coreApiNode("kinetic_core_api_connection_v1_3", "Create Or Update",
      `<%=
        require 'json'
        body = (@request['Body'] || @request['body']).to_s
        parsed = body.empty? ? {} : JSON.parse(body)
        existing = @results['Find Existing']['Response Body']
        subs = existing && !existing.to_s.empty? ? (JSON.parse(existing)['submissions'] || []) : []
        subs.empty? ? 'POST' : 'PUT'
      %>`,
      `<%=
        require 'json'
        body = (@request['Body'] || @request['body']).to_s
        parsed = body.empty? ? {} : JSON.parse(body)
        cls = (parsed['class'] || params['class'] || '').to_s
        existing = @results['Find Existing']['Response Body']
        subs = existing && !existing.to_s.empty? ? (JSON.parse(existing)['submissions'] || []) : []
        if subs.empty?
          '/app/api/v1/kapps/cmdb/forms/' + cls + '/submissions?completed=true'
        else
          '/app/api/v1/submissions/' + subs.first['id']
        end
      %>`, 280, 280),
    // The Create Or Update node body is the full submission payload — for POST it's {values:..., coreState:'Submitted'}, for PUT it's just {values:...}. ERB lets us branch:
    // We'll set body via the "body" parameter of the handler.
    webApiReturnNode("system_tree_return_v1_5",
      `<%=
        require 'json'
        cu = @results['Create Or Update']
        rc = cu['Response Code'].to_i
        rb = cu['Response Body'].to_s
        parsed = rb.empty? ? {} : JSON.parse(rb)
        body_in = (@request['Body'] || @request['body']).to_s
        body_parsed = body_in.empty? ? {} : JSON.parse(body_in)
        existing = @results['Find Existing']['Response Body']
        was_existing = existing && !existing.to_s.empty? && !(JSON.parse(existing)['submissions'] || []).empty?
        ci_num = (body_parsed['values'] && body_parsed['values']['CI Number']) || (parsed['submission'] && parsed['submission']['values'] && parsed['submission']['values']['CI Number'])
        { mode: (was_existing ? 'updated' : 'created'), httpStatus: rc, ciNumber: ci_num, submissionId: parsed['submission'] && parsed['submission']['id'] }.to_json
      %>`, 520, 240),
  ],
  connectors: [
    connector("start", "kinetic_core_api_connection_v1_2"),
    connector("kinetic_core_api_connection_v1_2", "kinetic_core_api_connection_v1_3"),
    connector("kinetic_core_api_connection_v1_3", "system_tree_return_v1_5"),
  ],
};
// Fix up the Create Or Update node — it needs the body to vary too
(function patchUpsert() {
  const node = TREES["upsert"].nodes.find(n => n.id === "kinetic_core_api_connection_v1_3");
  node.parameters.find(p => p.id === "body").value = `<%=
    require 'json'
    body = (@request['Body'] || @request['body']).to_s
    parsed = body.empty? ? {} : JSON.parse(body)
    values = parsed['values'] || {}
    existing = @results['Find Existing']['Response Body']
    subs = existing && !existing.to_s.empty? ? (JSON.parse(existing)['submissions'] || []) : []
    if subs.empty?
      { values: values, coreState: 'Submitted' }.to_json
    else
      { values: values }.to_json
    end
  %>`;
})();

/* ─────────────────────────────────────────────────────────────────────
   WebAPI 5: POST /relate
   Body: { sourceClass, sourceCiNumber, targetClass, targetCiNumber, type, description }
   Idempotent: look up existing match first.
   ───────────────────────────────────────────────────────────────────── */
/* relate — conditional connector skips Create Rel when dup exists.
   start → Check Existing → (no dup: Create Rel → Return) | (dup: Return directly) */
TREES["relate"] = {
  schemaVersion: "1.0", lastId: 4, name: "relate", notes: "Create a relationship between two CIs if it doesn't already exist.",
  nodes: [
    startNode(),
    coreApiNode("kinetic_core_api_connection_v1_2", "Check Existing", "GET",
      `<%=
        require 'json'
        body = (@request['Body'] || @request['body']).to_s
        parsed = body.empty? ? {} : JSON.parse(body)
        src = (parsed['sourceCiNumber'] || '').to_s
        type = (parsed['type'] || '').to_s
        '/app/api/v1/kapps/cmdb/forms/relationships/submissions?include=values&limit=25&q=' + URI.encode_www_form_component('values[Source CI Number] = "' + src + '" AND values[Type] = "' + type + '"')
      %>`, "", 280, 140),
    coreApiNode("kinetic_core_api_connection_v1_3", "Create Rel",
      "POST",
      "/app/api/v1/kapps/cmdb/forms/relationships/submissions?completed=true",
      `<%=
        require 'json'
        body = (@request['Body'] || @request['body']).to_s
        parsed = body.empty? ? {} : JSON.parse(body)
        { values: { 'Source Class' => parsed['sourceClass'], 'Source CI Number' => parsed['sourceCiNumber'], 'Source Name' => parsed['sourceName'] || '', 'Target Class' => parsed['targetClass'], 'Target CI Number' => parsed['targetCiNumber'], 'Target Name' => parsed['targetName'] || '', 'Type' => parsed['type'], 'Direction' => 'Forward', 'Status' => 'Active', 'Discovery Source' => parsed['source'] || 'WebAPI', 'Description' => parsed['description'] || '' }, coreState: 'Submitted' }.to_json
      %>`,
      280, 280),
    webApiReturnNode("system_tree_return_v1_4",
      `<%=
        require 'json'
        existing_body = @results['Check Existing']['Response Body']
        subs = existing_body && !existing_body.to_s.empty? ? (JSON.parse(existing_body)['submissions'] || []) : []
        body = (@request['Body'] || @request['body']).to_s
        parsed = body.empty? ? {} : JSON.parse(body)
        dup = subs.find { |s| (s['values']||{})['Source Class'] == parsed['sourceClass'] && (s['values']||{})['Target Class'] == parsed['targetClass'] && (s['values']||{})['Target CI Number'] == parsed['targetCiNumber'] }
        if dup
          { mode: 'exists', relationshipId: dup['values']['Relationship ID'], submissionId: dup['id'] }.to_json
        else
          cr = @results['Create Rel']
          rb = cr['Response Body'].to_s
          created = rb.empty? ? {} : JSON.parse(rb)
          { mode: 'created', submissionId: created['submission'] && created['submission']['id'] }.to_json
        end
      %>`, 520, 200),
  ],
  connectors: [
    connector("start", "kinetic_core_api_connection_v1_2"),
    // Two outbound from Check Existing. Connector `value` is RAW RUBY (not ERB).
    {
      from: "kinetic_core_api_connection_v1_2", to: "kinetic_core_api_connection_v1_3", type: "Complete", label: "No Dup",
      value: `(parsed=(begin; b=(@request['Body']||@request['body']).to_s; b.empty? ? {} : JSON.parse(b); rescue; {}; end)) && (eb=@results['Check Existing']['Response Body'].to_s) && (subs=eb.empty? ? [] : (JSON.parse(eb)['submissions']||[])) && subs.none? { |s| (s['values']||{})['Source Class'] == parsed['sourceClass'] && (s['values']||{})['Target Class'] == parsed['targetClass'] && (s['values']||{})['Target CI Number'] == parsed['targetCiNumber'] }`,
    },
    {
      from: "kinetic_core_api_connection_v1_2", to: "system_tree_return_v1_4", type: "Complete", label: "Dup",
      value: `(parsed=(begin; b=(@request['Body']||@request['body']).to_s; b.empty? ? {} : JSON.parse(b); rescue; {}; end)) && (eb=@results['Check Existing']['Response Body'].to_s) && (subs=eb.empty? ? [] : (JSON.parse(eb)['submissions']||[])) && subs.any? { |s| (s['values']||{})['Source Class'] == parsed['sourceClass'] && (s['values']||{})['Target Class'] == parsed['targetClass'] && (s['values']||{})['Target CI Number'] == parsed['targetCiNumber'] }`,
    },
    connector("kinetic_core_api_connection_v1_3", "system_tree_return_v1_4"),
  ],
};

/* ─── Routines (4) ───────────────────────────────────────────────────── */
// Routines share a similar shape but use input parameters (@inputs['Name']) instead of @request

ROUTINES.push({
  name: "Cmdb Ci Lookup",
  definitionId: "routine_cmdb_ci_lookup_v1",
  inputs: [
    { name: "Class", defaultValue: "servers", description: "CMDB form slug (e.g., servers, databases, applications, services)", required: true },
    { name: "CI Number", defaultValue: "", description: "CI Number to look up (e.g., SRV-0001)", required: true },
  ],
  outputs: [
    { name: "Found", description: "true if a CI was found, false otherwise" },
    { name: "Submission Id", description: "Kinetic submission ID of the CI" },
    { name: "Name", description: "Display name of the CI" },
    { name: "Values Json", description: "Full values JSON for the CI" },
  ],
  tree: {
    schemaVersion: "1.0", lastId: 3, name: "Cmdb Ci Lookup", notes: "",
    nodes: [
      startNode(),
      coreApiNode("kinetic_core_api_connection_v1_2", "Fetch CI", "GET",
        `<%= '/app/api/v1/kapps/cmdb/forms/' + @inputs['Class'].to_s + '/submissions?include=values&limit=1&q=' + URI.encode_www_form_component('values[CI Number] = "' + @inputs['CI Number'].to_s + '"') %>`),
      routineReturnNode("system_tree_return_v1_3", [
        { id: "Found", value: `<%= require 'json'; b=@results['Fetch CI']['Response Body'].to_s; (!b.empty? && !(JSON.parse(b)['submissions']||[]).empty?).to_s %>` },
        { id: "Submission Id", value: `<%= require 'json'; b=@results['Fetch CI']['Response Body'].to_s; b.empty? ? '' : ((JSON.parse(b)['submissions']||[]).first || {})['id'].to_s %>` },
        { id: "Name", value: `<%= require 'json'; b=@results['Fetch CI']['Response Body'].to_s; b.empty? ? '' : (((JSON.parse(b)['submissions']||[]).first || {})['values'] || {})['Name'].to_s %>` },
        { id: "Values Json", value: `<%= require 'json'; b=@results['Fetch CI']['Response Body'].to_s; b.empty? ? '{}' : (((JSON.parse(b)['submissions']||[]).first || {})['values'] || {}).to_json %>` },
      ]),
    ],
    connectors: [
      connector("start", "kinetic_core_api_connection_v1_2"),
      connector("kinetic_core_api_connection_v1_2", "system_tree_return_v1_3"),
    ],
  },
});

ROUTINES.push({
  name: "Cmdb Ci Upsert",
  definitionId: "routine_cmdb_ci_upsert_v1",
  inputs: [
    { name: "Class", defaultValue: "servers", description: "CMDB form slug", required: true },
    { name: "Values Json", defaultValue: "{}", description: "JSON object of values (must include CI Number for updates)", required: true },
  ],
  outputs: [
    { name: "Mode", description: "'created' or 'updated'" },
    { name: "CI Number", description: "CI Number of the upserted record" },
    { name: "Submission Id", description: "Submission ID" },
  ],
  tree: {
    schemaVersion: "1.0", lastId: 4, name: "Cmdb Ci Upsert", notes: "",
    nodes: [
      startNode(),
      coreApiNode("kinetic_core_api_connection_v1_2", "Find Existing", "GET",
        `<%=
          require 'json'
          vals = JSON.parse(@inputs['Values Json'].to_s)
          ci_number = (vals['CI Number'] || '').to_s
          if ci_number.empty?
            '/app/api/v1/kapps/cmdb/forms/' + @inputs['Class'].to_s + '/submissions?include=values&limit=1&q=' + URI.encode_www_form_component('values[CI Number] = "__nope__"')
          else
            '/app/api/v1/kapps/cmdb/forms/' + @inputs['Class'].to_s + '/submissions?include=values&limit=1&q=' + URI.encode_www_form_component('values[CI Number] = "' + ci_number + '"')
          end
        %>`, "", 280, 140),
      coreApiNode("kinetic_core_api_connection_v1_3", "Create Or Update",
        `<%= require 'json'; ex=@results['Find Existing']['Response Body'].to_s; (ex.empty? || (JSON.parse(ex)['submissions']||[]).empty?) ? 'POST' : 'PUT' %>`,
        `<%=
          require 'json'
          ex = @results['Find Existing']['Response Body'].to_s
          subs = ex.empty? ? [] : (JSON.parse(ex)['submissions'] || [])
          if subs.empty?
            '/app/api/v1/kapps/cmdb/forms/' + @inputs['Class'].to_s + '/submissions?completed=true'
          else
            '/app/api/v1/submissions/' + subs.first['id']
          end
        %>`,
        `<%=
          require 'json'
          vals = JSON.parse(@inputs['Values Json'].to_s)
          ex = @results['Find Existing']['Response Body'].to_s
          subs = ex.empty? ? [] : (JSON.parse(ex)['submissions'] || [])
          if subs.empty?
            { values: vals, coreState: 'Submitted' }.to_json
          else
            { values: vals }.to_json
          end
        %>`, 280, 280),
      routineReturnNode("system_tree_return_v1_4", [
        { id: "Mode", value: `<%= require 'json'; ex=@results['Find Existing']['Response Body'].to_s; (ex.empty? || (JSON.parse(ex)['submissions']||[]).empty?) ? 'created' : 'updated' %>` },
        { id: "CI Number", value: `<%= require 'json'; JSON.parse(@inputs['Values Json'].to_s)['CI Number'].to_s %>` },
        { id: "Submission Id", value: `<%= require 'json'; rb=@results['Create Or Update']['Response Body'].to_s; rb.empty? ? '' : (((JSON.parse(rb)['submission']||{})['id']) || '').to_s %>` },
      ]),
    ],
    connectors: [
      connector("start", "kinetic_core_api_connection_v1_2"),
      connector("kinetic_core_api_connection_v1_2", "kinetic_core_api_connection_v1_3"),
      connector("kinetic_core_api_connection_v1_3", "system_tree_return_v1_4"),
    ],
  },
});

ROUTINES.push({
  name: "Cmdb Relate",
  definitionId: "routine_cmdb_relate_v1",
  inputs: [
    { name: "Source Class", defaultValue: "", description: "Form slug of source CI", required: true },
    { name: "Source CI Number", defaultValue: "", description: "CI Number of source", required: true },
    { name: "Target Class", defaultValue: "", description: "Form slug of target CI", required: true },
    { name: "Target CI Number", defaultValue: "", description: "CI Number of target", required: true },
    { name: "Type", defaultValue: "depends-on", description: "Relationship type", required: true },
    { name: "Description", defaultValue: "", description: "Optional description", required: false },
  ],
  outputs: [
    { name: "Mode", description: "'created' or 'exists'" },
    { name: "Relationship Id", description: "Relationship ID" },
    { name: "Submission Id", description: "Kinetic submission ID" },
  ],
  tree: {
    schemaVersion: "1.0", lastId: 4, name: "Cmdb Relate", notes: "",
    nodes: [
      startNode(),
      coreApiNode("kinetic_core_api_connection_v1_2", "Check Existing", "GET",
        `<%= '/app/api/v1/kapps/cmdb/forms/relationships/submissions?include=values&limit=25&q=' + URI.encode_www_form_component('values[Source CI Number] = "' + @inputs['Source CI Number'].to_s + '" AND values[Type] = "' + @inputs['Type'].to_s + '"') %>`,
        "", 280, 140),
      coreApiNode("kinetic_core_api_connection_v1_3", "Create Rel", "POST",
        "/app/api/v1/kapps/cmdb/forms/relationships/submissions?completed=true",
        `<%=
          require 'json'
          { values: { 'Source Class' => @inputs['Source Class'].to_s, 'Source CI Number' => @inputs['Source CI Number'].to_s, 'Target Class' => @inputs['Target Class'].to_s, 'Target CI Number' => @inputs['Target CI Number'].to_s, 'Type' => @inputs['Type'].to_s, 'Direction' => 'Forward', 'Status' => 'Active', 'Discovery Source' => 'Routine', 'Description' => @inputs['Description'].to_s }, coreState: 'Submitted' }.to_json
        %>`, 280, 280),
      routineReturnNode("system_tree_return_v1_4", [
        { id: "Mode", value: `<%= require 'json'; ex=@results['Check Existing']['Response Body'].to_s; subs=ex.empty? ? [] : (JSON.parse(ex)['submissions'] || []); dup=subs.find { |s| (s['values']||{})['Source Class'] == @inputs['Source Class'].to_s && (s['values']||{})['Target Class'] == @inputs['Target Class'].to_s && (s['values']||{})['Target CI Number'] == @inputs['Target CI Number'].to_s }; dup ? 'exists' : 'created' %>` },
        { id: "Relationship Id", value: `<%= require 'json'; ex=@results['Check Existing']['Response Body'].to_s; subs=ex.empty? ? [] : (JSON.parse(ex)['submissions'] || []); dup=subs.find { |s| (s['values']||{})['Source Class'] == @inputs['Source Class'].to_s && (s['values']||{})['Target Class'] == @inputs['Target Class'].to_s && (s['values']||{})['Target CI Number'] == @inputs['Target CI Number'].to_s }; dup ? (dup['values']||{})['Relationship ID'].to_s : ((rb=@results['Create Rel']['Response Body'].to_s).empty? ? '' : (((JSON.parse(rb)['submission']||{})['values']||{})['Relationship ID']).to_s) %>` },
        { id: "Submission Id", value: `<%= require 'json'; ex=@results['Check Existing']['Response Body'].to_s; subs=ex.empty? ? [] : (JSON.parse(ex)['submissions'] || []); dup=subs.find { |s| (s['values']||{})['Source Class'] == @inputs['Source Class'].to_s && (s['values']||{})['Target Class'] == @inputs['Target Class'].to_s && (s['values']||{})['Target CI Number'] == @inputs['Target CI Number'].to_s }; dup ? dup['id'].to_s : ((rb=@results['Create Rel']['Response Body'].to_s).empty? ? '' : ((JSON.parse(rb)['submission']||{})['id']).to_s) %>` },
      ]),
    ],
    connectors: [
      connector("start", "kinetic_core_api_connection_v1_2"),
      {
        from: "kinetic_core_api_connection_v1_2", to: "kinetic_core_api_connection_v1_3", type: "Complete", label: "No Dup",
        value: `(ex=@results['Check Existing']['Response Body'].to_s) && (subs=ex.empty? ? [] : (JSON.parse(ex)['submissions']||[])) && subs.none? { |s| (s['values']||{})['Source Class'] == @inputs['Source Class'].to_s && (s['values']||{})['Target Class'] == @inputs['Target Class'].to_s && (s['values']||{})['Target CI Number'] == @inputs['Target CI Number'].to_s }`,
      },
      {
        from: "kinetic_core_api_connection_v1_2", to: "system_tree_return_v1_4", type: "Complete", label: "Dup",
        value: `(ex=@results['Check Existing']['Response Body'].to_s) && (subs=ex.empty? ? [] : (JSON.parse(ex)['submissions']||[])) && subs.any? { |s| (s['values']||{})['Source Class'] == @inputs['Source Class'].to_s && (s['values']||{})['Target Class'] == @inputs['Target Class'].to_s && (s['values']||{})['Target CI Number'] == @inputs['Target CI Number'].to_s }`,
      },
      connector("kinetic_core_api_connection_v1_3", "system_tree_return_v1_4"),
    ],
  },
});

ROUTINES.push({
  name: "Cmdb Impact Summary",
  definitionId: "routine_cmdb_impact_summary_v1",
  inputs: [
    { name: "Class", defaultValue: "", description: "CMDB form slug of the affected CI", required: true },
    { name: "CI Number", defaultValue: "", description: "CI Number of the affected CI", required: true },
  ],
  outputs: [
    { name: "First Hop Count", description: "How many CIs directly depend on this CI" },
    { name: "Affected Service Count", description: "How many services are first-hop dependents" },
    { name: "Affected Services Json", description: "JSON array of {ciNumber, name} entries" },
  ],
  tree: {
    schemaVersion: "1.0", lastId: 3, name: "Cmdb Impact Summary", notes: "",
    nodes: [
      startNode(),
      coreApiNode("kinetic_core_api_connection_v1_2", "Fetch Incoming Rels", "GET",
        `<%= '/app/api/v1/kapps/cmdb/forms/relationships/submissions?include=values&limit=25&q=' + URI.encode_www_form_component('values[Target CI Number] = "' + @inputs['CI Number'].to_s + '"') %>`),
      routineReturnNode("system_tree_return_v1_3", [
        { id: "First Hop Count", value: `<%= require 'json'; b=@results['Fetch Incoming Rels']['Response Body'].to_s; b.empty? ? '0' : (JSON.parse(b)['submissions']||[]).select { |r| (r['values']||{})['Target Class'] == @inputs['Class'].to_s }.length.to_s %>` },
        { id: "Affected Service Count", value: `<%= require 'json'; b=@results['Fetch Incoming Rels']['Response Body'].to_s; b.empty? ? '0' : (JSON.parse(b)['submissions']||[]).select { |r| (r['values']||{})['Source Class'] == 'services' && (r['values']||{})['Target Class'] == @inputs['Class'].to_s }.length.to_s %>` },
        { id: "Affected Services Json", value: `<%= require 'json'; b=@results['Fetch Incoming Rels']['Response Body'].to_s; (b.empty? ? [] : (JSON.parse(b)['submissions']||[]).select { |r| (r['values']||{})['Source Class'] == 'services' && (r['values']||{})['Target Class'] == @inputs['Class'].to_s }.map { |r| { ciNumber: (r['values']||{})['Source CI Number'], name: (r['values']||{})['Source Name'] } }).to_json %>` },
      ]),
    ],
    connectors: [
      connector("start", "kinetic_core_api_connection_v1_2"),
      connector("kinetic_core_api_connection_v1_2", "system_tree_return_v1_3"),
    ],
  },
});

/* ─── Installer ──────────────────────────────────────────────────────── */
async function ensureWebApi(slug, method) {
  // Check
  const ex = await req("GET", `/kapps/${KAPP}/webApis/${slug}`);
  if (ex.status === 200) { log("webapi", `${slug} (${method}) — exists`, "warn"); return false; }
  const r = await req("POST", `/kapps/${KAPP}/webApis`, { slug, method });
  if (ok(r.status)) { log("webapi", `Created ${slug} (${method})`, "ok"); return true; }
  log("webapi", `FAILED ${slug}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`, "fail");
  return false;
}

async function installWebApiTree(slug, treeJson) {
  const title = `Kinetic Request CE :: WebApis > ${KAPP} :: ${slug}`;
  const gex = await taskReq("GET", `/trees/${encodeURIComponent(title)}`);
  if (gex.status === 200) {
    // Already exists — PUT update
    const putBody = { sourceName: "Kinetic Request CE", sourceGroup: `WebApis > ${KAPP}`, name: slug, type: "Tree", status: "Active", treeJson, versionId: String(gex.data.versionId ?? gex.data.tree?.versionId ?? "0") };
    const u = await taskReq("PUT", `/trees/${encodeURIComponent(title)}`, putBody);
    if (ok(u.status)) { log("tree", `Updated WebAPI tree ${slug}`, "ok"); return; }
    log("tree", `FAILED update ${slug}: ${u.status} ${JSON.stringify(u.data).slice(0, 200)}`, "fail");
    return;
  }
  // POST create
  const body = { sourceName: "Kinetic Request CE", sourceGroup: `WebApis > ${KAPP}`, name: slug, type: "Tree", status: "Active", treeJson };
  const r = await taskReq("POST", `/trees`, body);
  if (ok(r.status)) { log("tree", `Created WebAPI tree ${slug}`, "ok"); return; }
  log("tree", `FAILED create ${slug}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`, "fail");
}

async function installRoutine(routine) {
  const title = `- :: - :: ${routine.name}`;
  const gex = await taskReq("GET", `/trees/${encodeURIComponent(title)}`);
  if (gex.status === 200) {
    // Update treeJson
    const u = await taskReq("PUT", `/trees/${encodeURIComponent(title)}`, {
      sourceName: "-", sourceGroup: "-", name: routine.name, type: "Global Routine", status: "Active",
      definitionId: routine.definitionId, treeJson: routine.tree,
      versionId: String(gex.data.versionId ?? gex.data.tree?.versionId ?? "0"),
    });
    if (ok(u.status)) { log("routine", `Updated ${routine.name}`, "ok"); return; }
    log("routine", `FAILED update ${routine.name}: ${u.status} ${JSON.stringify(u.data).slice(0, 200)}`, "fail");
    return;
  }
  // POST create — first registers the routine interface (inputs/outputs)
  const create = await taskReq("POST", `/trees`, {
    sourceName: "-", sourceGroup: "-", name: routine.name, definitionId: routine.definitionId,
    categories: [], inputs: routine.inputs, outputs: routine.outputs,
  });
  if (!ok(create.status)) { log("routine", `FAILED POST ${routine.name}: ${create.status} ${JSON.stringify(create.data).slice(0, 200)}`, "fail"); return; }
  log("routine", `Created interface ${routine.name}`, "ok");

  // Then PUT treeJson
  const u = await taskReq("PUT", `/trees/${encodeURIComponent(title)}`, {
    sourceName: "-", sourceGroup: "-", name: routine.name, type: "Global Routine", status: "Active",
    definitionId: routine.definitionId, treeJson: routine.tree, versionId: "0",
  });
  if (ok(u.status)) { log("routine", `Uploaded tree ${routine.name}`, "ok"); return; }
  log("routine", `FAILED PUT ${routine.name}: ${u.status} ${JSON.stringify(u.data).slice(0, 200)}`, "fail");
}

async function main() {
  console.log(`\n  CMDB Workflows Installer → ${SERVER}\n`);

  // 1. WebAPIs (definitions + trees)
  const webapis = [
    { slug: "lookup", method: "GET" },
    { slug: "ci", method: "GET" },
    { slug: "impact", method: "GET" },
    { slug: "upsert", method: "POST" },
    { slug: "relate", method: "POST" },
  ];
  for (const w of webapis) {
    await ensureWebApi(w.slug, w.method);
    const tree = TREES[w.slug];
    if (tree) await installWebApiTree(w.slug, tree);
  }

  // 2. Routines
  for (const r of ROUTINES) await installRoutine(r);

  console.log(`\n  Done.\n`);
  console.log(`  Try:`);
  console.log(`    curl -u ${USER}:${PASS} '${SERVER}/app/kapps/${KAPP}/webApis/lookup?timeout=10&ciNumber=SRV-0001&class=servers'`);
  console.log(`    curl -u ${USER}:${PASS} '${SERVER}/app/kapps/${KAPP}/webApis/impact?timeout=10&class=databases&id=DB-0001'\n`);
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
