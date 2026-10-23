/**
 * gen-trees.mjs — Telco NOC Kinetic workflows, generated from ONE node model into
 *   <file>.xml   → validate-workflow.mjs (mandatory rule gate)
 *   trees.json   → deploy-trees.mjs (Task API treeJson PUT — the reliable persistence path)
 *
 * 1. WebAPI  ingest-event (kapp telco-noc, POST)  — Ruby normalization, idempotency, dedup, clear handling
 * 2. incidents        / Submission Created  — Ack timer: wait N min, escalate if still New
 * 3. incidents        / Submission Updated  — Closure guard: Closed without verified recovery → revert
 * 4. work-orders      / Submission Updated  — Field completion → incident timeline + verification Pending
 * 5. notifications    / Submission Updated  — Approved → deliver (simulated channel) → Sent + timeline + audit
 *
 * All writes go through kinetic_core_api_connection_v1 (service account; server-root-relative paths).
 * Retry safety: every create uses a deterministic business ID; the unique [Tenant ID, <ID>] index turns
 * a replayed create into a harmless 400 instead of a duplicate.
 * Usage: node workflows/gen-trees.mjs [--ack-minutes=10]
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const CAT = JSON.parse(fs.readFileSync(path.join(DIR, "../engine/catalog.json"), "utf-8"));
const ACK_MIN = Number((process.argv.find((a) => a.startsWith("--ack-minutes=")) || "=3").split("=")[1]);
// callers allowed to ingest for ANY tenant (platform admins / replay service account); everyone else must be int.<tenantId>
const ADMIN_CALLERS = (process.argv.find((a) => a.startsWith("--admin-callers=")) || "=john").split("=")[1].split(",");
const CORE = "kinetic_core_api_connection_v1";
const K = "telco-noc";
const escX = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escA = (s) => escX(s).replace(/"/g, "&quot;");
const api = (method, p, body) => ({ error_handling: "Error Message", method, path: p, body: body || "", extra_headers: "" });
const node = (defId, id, name, x, y, params = {}, deps = [], o = {}) => ({ defId, id, name, x, y, params, deps, defers: !!o.defers });

// ─────────────────────── Ruby: normalization (shared by every node of the ingest tree) ───────────────────────
// Only the slices of the catalog Ruby needs, inlined as a literal so the tree is self-contained.
const catRb = JSON.stringify({ late: CAT.lateThresholdSeconds, skew: CAT.futureSkewToleranceSeconds, rank: CAT.severityRank, sev: CAT.severityMap, cmap: CAT.conditionMap,
  cond: Object.fromEntries(Object.entries(CAT.conditions).map(([k, v]) => [k, { x: v.x733, sa: v.sa, t: v.text }])) });
if (/[{}]/.test(catRb.replace(/[^{}]/g, "")) && catRb.split("{").length !== catRb.split("}").length) throw new Error("unbalanced catalog braces");
const R = (name) => `((@results['${name}']['Response Body']) rescue nil)`;
export const NORM = [
  "(lambda { require 'json'; require 'time'; require 'digest'; require 'uri'",
  `c = JSON.parse(%q{${catRb}})`,
  "raw = (@request['Body'] || '').to_s; b = (JSON.parse(raw) rescue nil); errs = []",
  "if !b.is_a?(Hash) then errs << 'body is not a JSON object'; b = {} end",
  "%w(schemaVersion tenantId source sourceEventId eventTime resourceRef condition).each { |k| errs << ('missing ' + k) if b[k].to_s.strip.empty? }",
  "tenant = b['tenantId'].to_s.strip; src = b['source'].to_s.strip; sid = b['sourceEventId'].to_s.strip",
  "errs << 'tenantId malformed' if !tenant.empty? && tenant !~ /\\A[a-z0-9-]{3,32}\\z/",
  "errs << ('unsupported schemaVersion ' + b['schemaVersion'].to_s) if !b['schemaVersion'].to_s.empty? && !['1.0','1.1'].include?(b['schemaVersion'].to_s)",
  "now = Time.now.utc; et = nil; notes = []",
  "if !b['eventTime'].to_s.empty? then begin; et = Time.iso8601(b['eventTime'].to_s).utc; rescue; errs << 'eventTime not ISO-8601 with zone'; end end",
  "skew = false; late = false",
  "if et && (et - now) > c['skew'] then skew = true; notes << ('eventTime ' + et.iso8601 + ' is in the future; clamped to receivedAt'); et = now end",
  "late = !!(et && (now - et) > c['late']); notes << ('late by ' + (now - et).round.to_s + 's') if late",
  "vs = b['vendorSeverity'].to_s; sm = c['sev'][src]; sev = sm ? sm[vs] : nil",
  "if sev.nil? then sev = 'Indeterminate'; notes << ('unmapped severity ' + vs.inspect + ' from ' + src) end",
  "st = (b['state'].to_s.downcase == 'clear' || sev == 'Cleared') ? 'clear' : 'raise'",
  "cr = b['condition'].to_s; ct = (c['cmap'][src] || {})[cr] || (c['cond'].key?(cr) ? cr : 'UNKNOWN'); notes << ('unmapped condition ' + cr.inspect) if ct == 'UNKNOWN'; ci = c['cond'][ct]",
  "ref = b['resourceRef'].to_s.strip; par = ref.split(/[:|\\/]/, 2)[0].to_s; rel = b['relatedResourceRef'].to_s.strip; relp = rel.split(/[:|\\/]/, 2)[0].to_s",
  "qs = lambda { |s| s.to_s.gsub(/[\"\\\\]/, '') }",
  "idem = sid.empty? ? ('invalid|' + Digest::SHA1.hexdigest(raw)[0,20]) : [tenant, src, sid].join('|'); rawid = 'RAW-' + Digest::SHA1.hexdigest(tenant + '|' + idem)[0,16]",
  `maps = ((JSON.parse(${R("Resolve Resource")})['submissions'] || []) rescue [])`,
  "pk = lambda { |r| return nil if r.to_s.empty?; maps.find { |s| v = s['values']; v['External ID'].to_s == r && ['*', src].include?(v['Source System'].to_s) && v['Valid To'].to_s.empty? } }",
  "m = pk.call(ref); match = m ? (m['values']['Match Kind'].to_s == 'Alias' ? 'Alias' : 'Exact') : nil",
  "if m.nil? && par != ref then m = pk.call(par); if m then match = 'Alias'; notes << ('resource ' + ref.inspect + ' matched at parent ' + par.inspect) end end",
  "rid = m ? m['values']['Internal ID'].to_s : ''; match ||= 'Unmatched'; notes << ('resource ' + ref.inspect + ' not in identifier map') if rid.empty? && !ref.empty?",
  "rm = pk.call(rel) || (relp != rel ? pk.call(relp) : nil); relid = rm ? rm['values']['Internal ID'].to_s : ''",
  "fp = [tenant, (rid.empty? ? 'ref:' + ref : rid), ct].join('|')",
  `dup = (((JSON.parse(${R("Find Duplicate")})['submissions'] || []).length > 0) rescue false)`,
  `act = (((JSON.parse(${R("Find Active Alarm")})['submissions'] || []).first) rescue nil); av = act ? act['values'] : {}`,
  "first = (Time.iso8601(av['First Occurred At'].to_s).utc rescue nil)",
  "aid = act ? av['Alarm ID'].to_s : ('ALM-' + Digest::SHA1.hexdigest(fp + '|' + (et ? et.iso8601 : ''))[0,16])",
  `caller = ((@requested_by || {})['username'].to_s rescue ''); callerOk = ${JSON.stringify(ADMIN_CALLERS)}.include?(caller) || caller == ('int.' + tenant)`,
  "kind = if tenant.empty? || tenant !~ /\\A[a-z0-9-]{3,32}\\z/ then 'unscoped' elsif !callerOk then 'forbidden' elsif !errs.empty? then 'invalid' elsif dup then 'duplicate' elsif st == 'raise' then (act ? 'repeat' : 'new') else ((act && (first.nil? || et >= first)) ? 'clear' : 'orphan-clear') end",
  "notes << 'clear precedes active instance (out-of-order); recorded, not applied' if kind == 'orphan-clear' && act",
  "recv = now.iso8601; eti = (et || now).iso8601",
  "{ 'kind' => kind, 'errs' => errs, 'tenant' => tenant, 'src' => src, 'sid' => sid, 'idem' => idem, 'rawid' => rawid, 'et' => eti, 'recv' => recv, 'late' => late, 'skew' => skew, " +
  "'sev' => sev, 'vs' => vs, 'st' => st, 'ct' => ct, 'ci' => ci, 'ref' => ref, 'par' => par, 'rel' => rel, 'relp' => relp, 'rid' => rid, 'relid' => relid, 'match' => match, 'fp' => fp, " +
  "'aid' => aid, 'act' => act, 'av' => av, 'notes' => notes, 'raw' => raw[0, 6000], 'batch' => b['replayBatch'].to_s, 'text' => b['text'].to_s, 'q' => qs, 'caller' => caller, " +
  "'enc' => lambda { |s| URI.encode_www_form_component(s).gsub('+', '%20') } } }).call",
].join("; ");
const E = (ruby) => `<% n = ${NORM} %><%= ${ruby} %>`; // ERB for parameters
const C = (ruby) => `(lambda { n = ${NORM}; ${ruby} }).call`; // raw Ruby for connector values
const SUBS = (form) => `/app/api/v1/kapps/${K}/forms/${form}/submissions`;

const rawBody = (state) => E(`{ 'coreState' => 'Submitted', 'values' => { 'Tenant ID' => n['tenant'], 'Raw ID' => n['rawid'], 'Idempotency Key' => n['idem'], 'Source System' => (n['src'].empty? ? 'unknown' : n['src']),
  'Source Event ID' => (n['sid'].empty? ? 'none' : n['sid']), 'Schema Version' => '1.0', 'Event Time' => n['et'], 'Received At' => n['recv'], 'Processing State' => ${state},
  'Reject Reason' => n['errs'].join('; '), 'Fingerprint' => n['fp'], 'Alarm ID' => (n['kind'] == 'invalid' ? '' : n['aid']), 'Late' => (n['late'] ? 'Yes' : 'No'), 'Clock Skew' => (n['skew'] ? 'Yes' : 'No'),
  'Payload' => n['raw'], 'Replay Batch' => n['batch'] } }.to_json`.replace(/\n\s*/g, " "));
const rawId = `<%= require 'json'; (JSON.parse(@results['Record Raw']['Response Body'])['submission']['id'] rescue '') %>`;
const newAlarm = E(`{ 'coreState' => 'Submitted', 'values' => { 'Tenant ID' => n['tenant'], 'Alarm ID' => n['aid'], 'Fingerprint' => n['fp'], 'Resource ID' => n['rid'], 'Resource Ref' => n['ref'],
  'Resource Match' => n['match'], 'Alarm Type' => n['ct'], 'Probable Cause' => n['ci']['x'], 'Specific Problem' => (n['text'].empty? ? n['ci']['t'] : n['text']), 'Severity' => n['sev'], 'Vendor Severity' => n['vs'],
  'Service Affecting' => (n['ci']['sa'] ? 'Yes' : 'No'), 'State' => 'Active', 'First Occurred At' => n['et'], 'Last Occurred At' => n['et'], 'Occurrence Count' => '1', 'Source Systems' => n['src'],
  'Related Resource Ref' => n['rel'], 'Related Resource ID' => n['relid'], 'Correlation Role' => 'Uncorrelated', 'Last Raw ID' => n['rawid'], 'Normalization Notes' => n['notes'].join('; '), 'Replay Batch' => n['batch'] } }.to_json`.replace(/\n\s*/g, " "));
const repeatAlarm = E(`{ 'values' => { 'Last Occurred At' => [n['av']['Last Occurred At'].to_s, n['et']].max, 'Occurrence Count' => (n['av']['Occurrence Count'].to_i + 1).to_s, 'Severity' => n['sev'], 'Vendor Severity' => n['vs'],
  'Source Systems' => (n['av']['Source Systems'].to_s.split(',') | [n['src']]).join(','), 'Last Raw ID' => n['rawid'],
  'Normalization Notes' => ([n['av']['Normalization Notes'].to_s] + n['notes']).reject(&:empty?).join('; ')[0, 1500] } }.to_json`.replace(/\n\s*/g, " "));
const clearAlarm = E(`{ 'values' => { 'State' => 'Cleared', 'Cleared At' => n['et'], 'Last Raw ID' => n['rawid'], 'Source Systems' => (n['av']['Source Systems'].to_s.split(',') | [n['src']]).join(',') } }.to_json`);
const rawDone = (note) => E(`{ 'values' => { 'Processing State' => 'Normalized', 'Alarm ID' => ${note === "orphan" ? "''" : "n['aid']"}, 'Reject Reason' => ${note === "orphan" ? "n['notes'].join('; ')" : "''"} } }.to_json`);
const ret = (code, content) => ({ content: E(content), content_type: "application/json", response_code: code, headers_json: "{}" });
const resp = (status) => `{ 'status' => '${status}', 'kind' => n['kind'], 'rawId' => n['rawid'], 'alarmId' => n['aid'], 'fingerprint' => n['fp'], 'resourceId' => n['rid'], 'resourceMatch' => n['match'], 'severity' => n['sev'], 'late' => n['late'], 'clockSkew' => n['skew'], 'errors' => n['errs'], 'notes' => n['notes'] }.to_json`;
const RC = (node) => `@results['${node}']['Response Code'].to_s`;

const kqlPath = (form, kql, limit) => `${SUBS(form)}?limit=${limit}&include=values&q=<% n = ${NORM} %><%= n['enc'].call(${kql}) %>`;
const INGEST = {
  kind: "webapi", slug: "ingest-event", name: "ingest-event", file: "webapi-ingest-event", lastID: 19,
  nodes: [
    node("system_start_v1", "start", "Start", 60, 40, {}, [{ to: `${CORE}_1`, label: "look up idempotency key" }]),
    node(CORE, `${CORE}_1`, "Find Duplicate", 60, 150, api("GET", kqlPath("raw-alarms", `'values[Tenant ID]="' + n['q'].call(n['tenant']) + '" AND values[Idempotency Key]="' + n['q'].call(n['idem']) + '"'`, 1)), [{ to: `${CORE}_2`, label: "resolve resource identifiers" }]),
    node(CORE, `${CORE}_2`, "Resolve Resource", 60, 260, api("GET", kqlPath("identifiers", `'values[Tenant ID]="' + n['q'].call(n['tenant']) + '" AND values[External ID] IN (' + [n['ref'], n['par'], n['rel'], n['relp']].reject(&:empty?).uniq.map { |x| '"' + n['q'].call(x) + '"' }.join(',') + ')'`, 25)), [{ to: `${CORE}_3`, label: "find active alarm instance" }]),
    node(CORE, `${CORE}_3`, "Find Active Alarm", 60, 370, api("GET", kqlPath("alarms", `'values[Tenant ID]="' + n['q'].call(n['tenant']) + '" AND values[Fingerprint]="' + n['q'].call(n['fp']) + '" AND values[State]="Active"'`, 5)), [
      { to: "system_tree_return_v1_4", label: "Unscoped (no tenant)?", value: C("n['kind'] == 'unscoped'") },
      { to: "system_tree_return_v1_17", label: "Caller not allowed for this tenant?", value: C("n['kind'] == 'forbidden'") },
      { to: `${CORE}_5`, label: "Invalid?", value: C("n['kind'] == 'invalid'") },
      { to: "system_tree_return_v1_7", label: "Duplicate?", value: C("n['kind'] == 'duplicate'") },
      { to: `${CORE}_8`, label: "Accept?", value: C("['new','repeat','clear','orphan-clear'].include?(n['kind'])") }]),
    node("system_tree_return_v1", "system_tree_return_v1_4", "Return Unscoped", 420, 40, ret("400", `{ 'status' => 'rejected', 'errors' => (n['errs'] + ['tenantId missing or malformed']).uniq }.to_json`)),
    node(CORE, `${CORE}_5`, "Record Rejected", 420, 150, api("POST", SUBS("raw-alarms"), rawBody("'Rejected'")), [{ to: "system_tree_return_v1_6", label: "dead-lettered" }]),
    node("system_tree_return_v1", "system_tree_return_v1_6", "Return Invalid", 660, 150, ret("422", resp("rejected"))),
    node("system_tree_return_v1", "system_tree_return_v1_7", "Return Duplicate", 420, 260, ret("200", resp("duplicate"))),
    node(CORE, `${CORE}_8`, "Record Raw", 420, 370, api("POST", SUBS("raw-alarms"), rawBody("'Accepted'")), [
      { to: "system_tree_return_v1_9", label: "Idempotency race (unique index)?", value: `${RC("Record Raw")} != '200'` },
      { to: `${CORE}_10`, label: "New alarm?", value: `${RC("Record Raw")} == '200' && ${C("n['kind'] == 'new'")}` },
      { to: `${CORE}_11`, label: "Repeat?", value: `${RC("Record Raw")} == '200' && ${C("n['kind'] == 'repeat'")}` },
      { to: `${CORE}_12`, label: "Clear?", value: `${RC("Record Raw")} == '200' && ${C("n['kind'] == 'clear'")}` },
      { to: `${CORE}_14`, label: "Orphan clear?", value: `${RC("Record Raw")} == '200' && ${C("n['kind'] == 'orphan-clear'")}` }]),
    node("system_tree_return_v1", "system_tree_return_v1_9", "Return Race Duplicate", 660, 260, ret("200", resp("duplicate"))),
    node(CORE, `${CORE}_10`, "Create Alarm", 660, 370, api("POST", SUBS("alarms"), newAlarm), [{ to: `${CORE}_13`, label: "mark raw normalized" }]),
    node(CORE, `${CORE}_11`, "Update Alarm Repeat", 660, 480, api("PUT", `/app/api/v1/submissions/<%= (@results['Find Active Alarm']['Response Body'] =~ /"id":"([0-9a-f-]{36})"/ ? $1 : 'missing') %>`, repeatAlarm), [{ to: `${CORE}_13`, label: "mark raw normalized" }]),
    node(CORE, `${CORE}_12`, "Clear Alarm", 660, 590, api("PUT", `/app/api/v1/submissions/<%= (@results['Find Active Alarm']['Response Body'] =~ /"id":"([0-9a-f-]{36})"/ ? $1 : 'missing') %>`, clearAlarm), [{ to: `${CORE}_13`, label: "mark raw normalized" }]),
    node(CORE, `${CORE}_13`, "Mark Raw Normalized", 900, 480, api("PUT", `/app/api/v1/submissions/${rawId}`, rawDone()), [{ to: "system_tree_return_v1_15", label: "done" }]),
    node(CORE, `${CORE}_14`, "Mark Raw Orphan", 660, 700, api("PUT", `/app/api/v1/submissions/${rawId}`, rawDone("orphan")), [{ to: "system_tree_return_v1_16", label: "done" }]),
    node("system_tree_return_v1", "system_tree_return_v1_15", "Return Accepted", 1140, 480, ret("202", resp("accepted"))),
    node("system_tree_return_v1", "system_tree_return_v1_16", "Return Orphan Clear", 900, 700, ret("202", resp("accepted"))),
    node("system_tree_return_v1", "system_tree_return_v1_17", "Return Forbidden", 420, -70, ret("403", `{ 'status' => 'rejected', 'errors' => ['caller ' + n['caller'] + ' may not ingest for tenant ' + n['tenant']] }.to_json`)),
  ],
};
// lastID must equal the max suffix used
INGEST.lastID = 17;

// ─────────────────────── Event trees (form workflows) ───────────────────────
const V = (f) => `@values['${f}']`;
const now = "<%= Time.now.utc.iso8601 %>";
const jb = (obj) => `<%= require 'json'; require 'time'; ${obj}.to_json %>`;
const updBody = (id, type, summary, details = "{}", actor = "Workflow") => jb(`{ 'coreState' => 'Submitted', 'values' => { 'Tenant ID' => @values['Tenant ID'], 'Update ID' => ${id}, 'Incident ID' => @values['Incident ID'],
  'Update Type' => '${type}', 'At' => Time.now.utc.iso8601, 'Author' => 'workflow', 'Actor Type' => '${actor}', 'Summary' => ${summary}, 'Details' => ${details}, 'Visibility' => 'Internal', 'Replay Batch' => @values['Replay Batch'].to_s } }`.replace(/\n\s*/g, " "));
const auditBody = (id, action, entityType, entityId, after, reason) => jb(`{ 'coreState' => 'Submitted', 'values' => { 'Tenant ID' => @values['Tenant ID'], 'Audit ID' => ${id}, 'At' => Time.now.utc.iso8601, 'Actor' => 'workflow:' + @run['Id'].to_s,
  'Actor Type' => 'Workflow', 'Action' => '${action}', 'Entity Type' => '${entityType}', 'Entity ID' => ${entityId}, 'After' => ${after}, 'Reason' => ${reason}, 'Request ID' => 'run-' + @run['Id'].to_s, 'Replay Batch' => @values['Replay Batch'].to_s } }`.replace(/\n\s*/g, " "));
const findInc = `/app/api/v1/kapps/${K}/forms/incidents/submissions?limit=1&include=values&q=<%= require 'uri'; URI.encode_www_form_component('values[Tenant ID]="' + @values['Tenant ID'].to_s + '" AND values[Incident ID]="' + @values['Incident ID'].to_s + '"').gsub('+','%20') %>`;
const incSubId = (nodeName) => `<%= (@results['${nodeName}']['Response Body'] =~ /"id":"([0-9a-f-]{36})"/ ? $1 : 'missing') %>`;
const incVal = (nodeName, field) => `(lambda { require 'json'; ((JSON.parse(@results['${nodeName}']['Response Body'])['submissions'] || [])[0] || {'values'=>{}})['values']['${field}'].to_s }).call`;

const ACK = { kind: "event", form: "incidents", event: "Submission Created", name: "Ack Timer Escalation", file: "tree-incident-ack-timer", lastID: 5,
  nodes: [
    node("system_start_v1", "start", "Start", 60, 40, {}, [{ to: "system_wait_v1_1", label: "New incident?", value: `${V("State")} == 'New'` }]),
    node("system_wait_v1", "system_wait_v1_1", `Wait ${ACK_MIN} min for acknowledgement`, 60, 150, { "Time to wait": String(ACK_MIN), "Time unit": "Minute" }, [{ to: `${CORE}_2`, label: "on wake, re-read incident" }], { defers: true }),
    node(CORE, `${CORE}_2`, "Get Incident", 60, 260, api("GET", `/app/api/v1/submissions/<%= @submission['Id'] %>?include=values`), [
      { to: `${CORE}_3`, label: "Still New (unacknowledged)?", value: `(lambda { require 'json'; JSON.parse(@results['Get Incident']['Response Body'])['submission']['values']['State'] == 'New' }).call` }]),
    node(CORE, `${CORE}_3`, "Escalate", 60, 370, api("PUT", "/app/api/v1/submissions/<%= @submission['Id'] %>", jb(`{ 'values' => { 'Escalation Level' => '1' } }`)), [{ to: `${CORE}_4`, label: "then log timeline" }]),
    node(CORE, `${CORE}_4`, "Log Escalation", 60, 480, api("POST", SUBS("incident-updates"), updBody(`'UPD-' + @values['Incident ID'] + '-ACK-ESC'`, "Escalation", `'Not acknowledged within ${ACK_MIN} min — escalated to level 1 (on-call secondary + duty manager).'`, `{ 'timerMinutes' => ${ACK_MIN}, 'run' => @run['Id'] }.to_json`)), [{ to: `${CORE}_5`, label: "then audit" }]),
    node(CORE, `${CORE}_5`, "Audit Escalation", 60, 590, api("POST", SUBS("audit"), auditBody(`'AUD-' + @values['Incident ID'] + '-ACK-ESC'`, "incident.escalate.timer", "Incident", "@values['Incident ID']", `{ 'Escalation Level' => '1' }.to_json`, `'ack timer expired'`))),
  ] };

const GUARD = { kind: "event", form: "incidents", event: "Submission Updated", name: "Closure Guard", file: "tree-incident-closure-guard", lastID: 3,
  nodes: [
    node("system_start_v1", "start", "Start", 60, 40, {}, [{ to: `${CORE}_1`, label: "Closed without verified recovery?", value: `${V("State")} == 'Closed' && ${V("Verification State")} != 'Passed'` }]),
    node(CORE, `${CORE}_1`, "Revert To Resolved", 60, 150, api("PUT", "/app/api/v1/submissions/<%= @submission['Id'] %>", jb(`{ 'values' => { 'State' => 'Resolved', 'Closed At' => '' } }`)), [{ to: `${CORE}_2`, label: "then log timeline" }]),
    node(CORE, `${CORE}_2`, "Log Closure Blocked", 60, 260, api("POST", SUBS("incident-updates"), updBody(`'UPD-' + @values['Incident ID'] + '-CLOSEBLK-' + @run['Id'].to_s`, "Closure Blocked", `'Closure blocked by platform guard: customer service recovery not verified (Verification State = ' + @values['Verification State'].to_s + ').'`)), [{ to: `${CORE}_3`, label: "then audit" }]),
    node(CORE, `${CORE}_3`, "Audit Closure Blocked", 60, 370, api("POST", SUBS("audit"), auditBody(`'AUD-' + @values['Incident ID'] + '-CLOSEBLK-' + @run['Id'].to_s`, "incident.close.blocked", "Incident", "@values['Incident ID']", `{ 'State' => 'Resolved' }.to_json`, `'Verification State ' + @values['Verification State'].to_s`))),
  ] };

const FIELD = { kind: "event", form: "work-orders", event: "Submission Updated", name: "Field Completion", file: "tree-wo-field-completion", lastID: 4,
  nodes: [
    node("system_start_v1", "start", "Start", 60, 40, {}, [{ to: `${CORE}_1`, label: "Work complete on an incident WO?", value: `${V("State")} == 'Work Complete' && !${V("Incident ID")}.to_s.empty?` }]),
    node(CORE, `${CORE}_1`, "Find Incident", 60, 150, api("GET", findInc), [{ to: `${CORE}_2`, label: "Verification not yet started/passed?", value: `!['Pending','Passed'].include?(${incVal("Find Incident", "Verification State")})` },
      { to: `${CORE}_3`, label: "Already pending/passed — timeline only", value: `['Pending','Passed'].include?(${incVal("Find Incident", "Verification State")})` }]),
    node(CORE, `${CORE}_2`, "Set Verification Pending", 60, 260, api("PUT", `/app/api/v1/submissions/${incSubId("Find Incident")}`, jb(`{ 'values' => { 'Verification State' => 'Pending', 'Mitigated At' => (${incVal("Find Incident", "Mitigated At")}.empty? ? Time.now.utc.iso8601 : ${incVal("Find Incident", "Mitigated At")}) } }`)), [{ to: `${CORE}_3`, label: "then log timeline" }]),
    node(CORE, `${CORE}_3`, "Log Field Completion", 300, 260, api("POST", SUBS("incident-updates"), updBody(`'UPD-' + @values['Work Order ID'] + '-COMPLETE'`, "Field",
      `'Work order ' + @values['Work Order ID'] + ' complete by ' + @values['Assigned Tech'].to_s + '. Findings: ' + @values['Findings'].to_s[0,400] + ' — customer service recovery verification is now pending.'`,
      `{ 'workOrder' => @values['Work Order ID'], 'completedAt' => @values['Completed At'], 'evidence' => @values['Evidence'] }.to_json`)), [{ to: `${CORE}_4`, label: "then audit" }]),
    node(CORE, `${CORE}_4`, "Audit Field Completion", 300, 370, api("POST", SUBS("audit"), auditBody(`'AUD-' + @values['Work Order ID'] + '-COMPLETE'`, "workorder.complete", "Work Order", "@values['Work Order ID']", `{ 'State' => 'Work Complete' }.to_json`, `'field completion'`))),
  ] };

const DELIVER = { kind: "event", form: "notifications", event: "Submission Updated", name: "Deliver Approved Notification", file: "tree-notification-deliver", lastID: 5,
  nodes: [
    node("system_start_v1", "start", "Start", 60, 40, {}, [{ to: `${CORE}_1`, label: "Approved and approver recorded?", value: `${V("Status")} == 'Approved' && !${V("Approved By")}.to_s.empty?` }]),
    node(CORE, `${CORE}_1`, "Mark Sent (simulated channel)", 60, 150, api("PUT", "/app/api/v1/submissions/<%= @submission['Id'] %>", jb(`{ 'values' => { 'Status' => 'Sent', 'Sent At' => Time.now.utc.iso8601,
      'Delivery Results' => { 'channel' => @values['Channel'], 'simulated' => true, 'reason' => 'notify-gw integration not configured in pilot', 'recipients' => @values['Audience Size'].to_i, 'delivered' => @values['Audience Size'].to_i, 'failed' => 0 }.to_json } }`.replace(/\n\s*/g, " "))), [{ to: `${CORE}_2`, label: "then find incident" }]),
    node(CORE, `${CORE}_2`, "Find Incident", 60, 260, api("GET", findInc), [{ to: `${CORE}_3`, label: "then set comms state" }]),
    node(CORE, `${CORE}_3`, "Set Comms Sent", 60, 370, api("PUT", `/app/api/v1/submissions/${incSubId("Find Incident")}`, jb(`{ 'values' => { 'Comms State' => 'Sent', 'Next Update Due At' => (Time.now.utc + (@values['Sequence'] == 'Resolution' ? 0 : 3600)).iso8601 } }`)), [{ to: `${CORE}_4`, label: "then log timeline" }]),
    node(CORE, `${CORE}_4`, "Log Comms Sent", 60, 480, api("POST", SUBS("incident-updates"), updBody(`'UPD-' + @values['Notification ID'] + '-SENT'`, "Comms",
      `@values['Sequence'].to_s + ' customer notification ' + @values['Notification ID'] + ' sent via ' + @values['Channel'].to_s + ' to ' + @values['Audience Size'].to_s + ' recipients (approved by ' + @values['Approved By'].to_s + ').'`, `{ 'notification' => @values['Notification ID'] }.to_json`)), [{ to: `${CORE}_5`, label: "then audit" }]),
    node(CORE, `${CORE}_5`, "Audit Comms Sent", 60, 590, api("POST", SUBS("audit"), auditBody(`'AUD-' + @values['Notification ID'] + '-SENT'`, "notification.sent", "Notification", "@values['Notification ID']", `{ 'Status' => 'Sent' }.to_json`, `'approved by ' + @values['Approved By'].to_s`))),
  ] };

// ─────────────────────── emitters ───────────────────────
function toXml(t) {
  const task = (n) => `    <task definition_id="${n.defId}" id="${n.id}" name="${escA(n.name)}" x="${n.x}" y="${n.y}">
      <version>1</version><configured>true</configured><defers>${n.defers}</defers><deferrable>${n.defers}</deferrable><visible>false</visible>
      <parameters>${Object.entries(n.params).map(([k, v]) => `<parameter id="${escA(k)}">${escX(v)}</parameter>`).join("")}</parameters>
      <messages>${n.defers ? '<message type="Create"></message><message type="Update"></message>' : ""}<message type="Complete"></message></messages>
      <dependents>${n.deps.map((d) => `<task label="${escA(d.label || "")}" type="${d.type || "Complete"}" value="${escA(d.value || "")}">${d.to}</task>`).join("")}</dependents>
    </task>`;
  return `<tree schema_version="1.0">\n  <sourceName>Kinetic Request CE</sourceName>\n  <sourceGroup>${t.kind === "webapi" ? `WebApis &gt; ${K}` : "GUID"}</sourceGroup>\n  <type>Tree</type>\n  <status>Active</status>
  <taskTree builder_version="" schema_version="1.0" version="1">\n    <name>${escX(t.name)}</name><author></author><notes></notes>\n    <lastID>${t.lastID}</lastID>\n    <request>\n${t.nodes.map(task).join("\n")}\n    </request>\n  </taskTree>\n</tree>\n`;
}
function toJson(t) {
  const connectors = [];
  const nodes = t.nodes.map((n) => {
    n.deps.forEach((d) => connectors.push({ from: n.id, to: d.to, label: d.label || "", value: d.value || "", type: d.type || "Complete" }));
    return { configured: true, defers: n.defers, deferrable: n.defers, visible: false, name: n.name, messages: [],
      dependents: { task: n.deps.map((d) => ({ type: d.type || "Complete", content: d.to, value: d.value || "", label: d.label || "" })) },
      id: n.id, position: { x: n.x, y: n.y }, version: 1,
      parameters: Object.entries(n.params).map(([id, value]) => ({ dependsOnId: "", dependsOnValue: "", description: "", id, label: id, menu: "", value, required: false })), definitionId: n.defId };
  });
  return { builderVersion: "", schemaVersion: "1.0", version: "1", processOwnerEmail: "", lastId: t.lastID, name: t.name, notes: "", connectors, nodes };
}
const TREES = [INGEST, ACK, GUARD, FIELD, DELIVER];
for (const t of TREES) { const max = Math.max(...t.nodes.filter((n) => n.id !== "start").map((n) => Number(n.id.split("_").pop()))); if (max !== t.lastID) throw new Error(`${t.name}: lastID ${t.lastID} != max ${max}`); }
const payload = TREES.map((t) => { fs.writeFileSync(path.join(DIR, t.file + ".xml"), toXml(t)); return { kind: t.kind, slug: t.slug, form: t.form, event: t.event, name: t.name, file: t.file, treeJson: toJson(t) }; });
fs.writeFileSync(path.join(DIR, "trees.json"), JSON.stringify(payload, null, 1));
if (import.meta.url === `file://${process.argv[1]}`) console.log(`generated ${TREES.length} trees (ack timer ${ACK_MIN} min):`, TREES.map((t) => `${t.file} (${t.nodes.length} nodes)`).join(", "));
