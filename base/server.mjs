import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const requestStore = new AsyncLocalStorage();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PORT = process.env.PORT || 3011;
const KINETIC = process.env.KINETIC_URL || "https://first.kinetics.com";
let proxyTarget = KINETIC; // mutable — updated via /api/base/target
const __dir = path.dirname(new URL(import.meta.url).pathname);
const APPS_DIR = path.resolve(__dir, "..");

/* ───── App Auto-Discovery ───── */
// Dynamically load all apps from the apps/ directory.
// Apps with server.mjs that export handleAPI + apiPrefix get custom API routes.
// All apps with index.html get static file serving at /{slug}/.

const APP_REGISTRY = {};
const APP_HANDLERS = []; // [{prefix, handler, appId}]

async function discoverApps() {
  // Reset so this can be re-run (e.g. via /api/base/rescan) without duplicating handlers
  for (const k of Object.keys(APP_REGISTRY)) delete APP_REGISTRY[k];
  APP_HANDLERS.length = 0;

  const appsDir = path.resolve(__dir, "..");
  const dirs = fs.readdirSync(appsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "base" && d.name !== "home" && d.name !== "node_modules")
    .map(d => d.name);

  for (const dir of dirs) {
    const appDir = path.join(appsDir, dir);

    // Read app.json for metadata
    let appDef = null;
    const appJsonPath = path.join(appDir, "app.json");
    if (fs.existsSync(appJsonPath)) {
      try { appDef = JSON.parse(fs.readFileSync(appJsonPath, "utf-8")); } catch {}
    }

    const slug = appDef?.slug || dir.replace(/_/g, "-");
    const name = appDef?.name || dir;
    const hasForms = appDef?.forms?.length > 0;
    const kappSlug = hasForms ? (appDef?.slug || slug) : null;

    // Directory creation time (birthtime) as the app's "date created".
    // Fall back to mtime when birthtime is unavailable (0 on some filesystems).
    let created = '';
    try {
      const st = fs.statSync(appDir);
      created = (st.birthtimeMs ? st.birthtime : st.mtime).toISOString();
    } catch {}

    // Register in APP_REGISTRY
    APP_REGISTRY[slug] = {
      dir, name, kapp: kappSlug,
      description: appDef?.description || '',
      category: appDef?.category || '',
      tags: appDef?.tags || (appDef?.category ? [appDef.category] : []),
      icon: appDef?.icon || '',
      color: appDef?.color || '',
      bg: appDef?.bg || '',
      created,
    };

    // Try to import server.mjs for custom API handler
    const serverPath = path.join(appDir, "server.mjs");
    if (fs.existsSync(serverPath)) {
      try {
        const mod = await import("file://" + serverPath);
        if (mod.handleAPI && mod.apiPrefix) {
          APP_HANDLERS.push({
            prefix: mod.apiPrefix,
            handler: mod.handleAPI,
            appId: mod.appId || slug,
          });
        }
      } catch (e) {
        console.error(`  WARN: failed to import ${dir}/server.mjs: ${e.message}`);
      }
    }
  }
}

await discoverApps();

// Legacy static registry for any apps not yet auto-discovered
const LEGACY_REGISTRY = {
  "itil":             { dir: "itil",             name: "ITSM Console",      kapp: "incident" },
  "crm":              { dir: "crm",              name: "CRM Console",       kapp: "crm" },
  "knowledge":        { dir: "knowledge",        name: "Knowledge Portal",  kapp: "knowledge" },
  "atlas":            { dir: "atlas",             name: "Data Atlas",        kapp: "atlas" },
  "sec-ops":          { dir: "sec_ops",           name: "Security Ops",      kapp: "sec-ops" },
  "asset-management": { dir: "asset-management",  name: "Asset Management",  kapp: "asset-management" },
  "case":             { dir: "case",              name: "Case Management",   kapp: "case" },
  "innovation":       { dir: "innovation",          name: "Innovation Intake", kapp: "innovation" },
  "school-for-good":  { dir: "school-for-good",    name: "SchoolForGood",     kapp: "school-for-good" },
  "mining-ops":       { dir: "mining_management",   name: "Mining Ops",        kapp: "mining-ops" },
  "og-compliance":    { dir: "og_compliance",       name: "OG Compliance",     kapp: "og-compliance" },
  "agent-hub":        { dir: "agent_hub",              name: "AgentHub",          kapp: "agent-hub" },
  "atlas-lake":       { dir: "atlas_lake",              name: "AtlasLake",         kapp: "atlas-lake" },
  "credentials":      { dir: "credentials",              name: "Credentials Mgr",   kapp: "credentials" },
  "compliance-reg":   { dir: "compliance_reg",            name: "Compliance & Reg",  kapp: "compliance-reg" },
  "vendor-cred":      { dir: "vendor_cred",               name: "Vendor Credentialing", kapp: "vendor-cred" },
  "patient-safety":   { dir: "patient_safety",             name: "Patient Safety",        kapp: "patient-safety" },
  "clinical-equipment": { dir: "clinical_equipment",       name: "Clinical Equipment",    kapp: "clinical-equipment" },
  "contract-lifecycle": { dir: "contract_lifecycle",       name: "Contract Lifecycle",    kapp: "contract-lifecycle" },
  "supply-chain":      { dir: "supply_chain",              name: "Supply Chain",          kapp: "supply-chain" },
  "third-party-risk":  { dir: "third_party_risk",          name: "Third-Party Risk",      kapp: "third-party-risk" },
  "clinical-research": { dir: "clinical_research",         name: "Clinical Research",     kapp: "clinical-research" },
  "data-governance":   { dir: "data_governance",           name: "Data Governance",       kapp: "data-governance" },
  "workforce-optimization": { dir: "workforce_optimization", name: "Workforce Optimization", kapp: "workforce-optimization" },
  "physician-performance":  { dir: "physician_performance",  name: "Physician Performance",  kapp: "physician-performance" },
  "grants-funding":    { dir: "grants_funding",            name: "Grants & Funding",      kapp: "grants-funding" },
  "capital-assets":    { dir: "capital_assets",            name: "Capital Assets",        kapp: "capital-assets" },
  "dod-forms":         { dir: "dod_forms",                 name: "DoD Forms",             kapp: "dod-forms" },
  "hotel-mgmt":        { dir: "hotel_management",           name: "Hotel Management",      kapp: "hotel-mgmt" },
  "hotel-guru":        { dir: "hotel_guru",                 name: "HotelGuru",             kapp: "hotel-guru" },
  "school-mgmt":       { dir: "school_mgmt",                name: "School Management",     kapp: "school-mgmt" },
  "kinetic-air":       { dir: "kinetic_air",                name: "Kinetic Air",           kapp: "kinetic-air" },
  "address-std":       { dir: "address_std",                name: "Address Standardizer",  kapp: "address-std" },
  "restaurant":        { dir: "restaurant",                 name: "Restaurant Man",        kapp: "restaurant" },
  "sis":               { dir: "sis",                        name: "Student Info System",   kapp: "sis" },
  "lms":               { dir: "lms",                        name: "Learning Management",   kapp: "lms" },
  "attendance":        { dir: "attendance",                 name: "Attendance & Behavior", kapp: "attendance" },
  "communication":     { dir: "communication",              name: "Parent Communication",  kapp: "communication" },
  "scheduling":        { dir: "scheduling",                 name: "Scheduling & Courses",  kapp: "scheduling" },
  "golf-shop":         { dir: "golf_shop",                  name: "Golf Shop",             kapp: "golf-shop" },
  "bookstore":         { dir: "bookstore",                  name: "Bookstore",             kapp: "bookstore" },
  "ai-training":       { dir: "ai_training",                name: "AI Training",           kapp: null },
  "api-manager":       { dir: "api-manager",                name: "API Manager",           kapp: "api-manager" },
  "racecar-manager":   { dir: "racecar_manager",             name: "Racecar Manager",       kapp: "racecar-manager" },
  "sandwich-shop":     { dir: "sandwich_shop",               name: "Sandwich & Soup Shop",  kapp: "sandwich-shop" },
  "music-store":       { dir: "music_store",                 name: "Music Store",           kapp: "music-store" },
  "surf-shop":         { dir: "surf_shop",                   name: "Surf Shop",             kapp: "surf-shop" },
  "camp-registry":     { dir: "camp_registry",               name: "Camp Registry",         kapp: "camp-registry" },
};

/* ───── Shared helpers ───── */
function resolveTarget(req) {
  const h = req && req.headers && req.headers["x-kinetic-server"];
  return (h && h.startsWith("http")) ? h.replace(/\/+$/, "") : proxyTarget;
}

function kineticRequest(method, apiPath, body, authHeader) {
  return new Promise((resolve, reject) => {
    const storeReq = requestStore.getStore();
    const target = storeReq ? resolveTarget(storeReq) : proxyTarget;
    const url = new URL(`/app/api/v1${apiPath}`, target);
    const headers = { "Content-Type": "application/json" };
    if (authHeader) headers["Authorization"] = authHeader;
    const payload = body ? JSON.stringify(body) : null;
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    const httpReq = https.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    httpReq.on("error", reject);
    if (payload) httpReq.write(payload);
    httpReq.end();
  });
}

function taskRequest(method, apiPath, authHeader) {
  return new Promise((resolve, reject) => {
    const storeReq = requestStore.getStore();
    const target = storeReq ? resolveTarget(storeReq) : proxyTarget;
    const url = new URL(`/app/components/task/app/api/v2${apiPath}`, target);
    const headers = { "Content-Type": "application/json" };
    if (authHeader) headers["Authorization"] = authHeader;
    const httpReq = https.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    httpReq.on("error", reject);
    httpReq.end();
  });
}

function collectByQuery(kapp, formSlug, kql, auth, maxPages = 8) {
  const all = [];
  const seen = new Set();
  let lastCreatedAt = null;
  return (async () => {
    for (let i = 0; i < maxPages; i++) {
      let url = `/kapps/${kapp}/forms/${formSlug}/submissions?include=values,details&limit=25`;
      let q = kql || '';
      // <= (not <) so records sharing the boundary createdAt aren't skipped; seen-set dedupes the overlap.
      if (lastCreatedAt) q = (q ? '(' + q + ') AND ' : '') + 'createdAt <= "' + lastCreatedAt + '"';
      if (q) url += `&q=${encodeURIComponent(q)}`;
      const r = await kineticRequest("GET", url, null, auth);
      const subs = r.data?.submissions || [];
      let added = 0;
      for (const s of subs) { if (!seen.has(s.id)) { seen.add(s.id); all.push(s); added++; } }
      if (subs.length > 0) lastCreatedAt = subs[subs.length - 1].createdAt;
      if (added === 0 && i > 0) break; // entire page was overlap — timestamp plateau, stop
      if (!r.data?.nextPageToken || subs.length < 25) break;
    }
    return all;
  })();
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function jsonResp(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
  });
  res.end(JSON.stringify(data));
}

/* ───── Enterprise SSO (OAuth2 authorization_code + PKCE) ─────
 * Lets an operator sign in to any Kinetic server through that server's own
 * interactive login (local, SAML, OIDC) without typing a password into the
 * launcher. Flow: discover OAuth2 metadata -> dynamically register a confidential
 * client whose redirect_uri points back here -> PKCE authorize in a popup ->
 * exchange the code for a token SERVER-SIDE (secret + verifier never reach the
 * browser). Apps then run on the resulting Bearer token (the injected wrapper
 * rewrites their Basic header to Bearer transparently). */

function outboundRequest(method, urlStr, { headers = {}, json = null, form = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "http:" ? http : https;
    const h = { ...headers };
    let payload = null;
    if (form) { payload = new URLSearchParams(form).toString(); h["Content-Type"] = "application/x-www-form-urlencoded"; }
    else if (json != null) { payload = JSON.stringify(json); h["Content-Type"] = "application/json"; }
    if (payload) h["Content-Length"] = Buffer.byteLength(payload);
    const rq = mod.request(u, { method, headers: h }, (rs) => {
      const chunks = [];
      rs.on("data", (c) => chunks.push(c));
      rs.on("end", () => { const text = Buffer.concat(chunks).toString(); let data = null; try { data = JSON.parse(text); } catch {} resolve({ status: rs.statusCode, data, text }); });
    });
    rq.on("error", reject);
    if (payload) rq.write(payload);
    rq.end();
  });
}

const ssoClients = new Map();  // server -> { clientId, clientSecret, redirectUri, tokenEndpoint }
const ssoPending = new Map();  // state  -> { server, tokenEndpoint, clientId, clientSecret, verifier, redirectUri, createdAt }
const ssoResults = new Map();  // state  -> { access_token, ..., server, createdAt }
function ssoGc() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of ssoPending) if (v.createdAt < cutoff) ssoPending.delete(k);
  for (const [k, v] of ssoResults) if (v.createdAt < cutoff) ssoResults.delete(k);
}

async function ssoRegisterClient(server, redirectUri) {
  const disc = await outboundRequest("GET", server + "/.well-known/oauth-authorization-server");
  if (disc.status !== 200 || !disc.data || !disc.data.authorization_endpoint) {
    throw new Error("OAuth discovery failed (HTTP " + disc.status + "). Is this a Kinetic server with OAuth enabled?");
  }
  const meta = disc.data;
  const cached = ssoClients.get(server);
  if (cached && cached.redirectUri === redirectUri) {
    return { meta, clientId: cached.clientId, clientSecret: cached.clientSecret };
  }
  if (!meta.registration_endpoint) throw new Error("Server does not advertise a dynamic registration_endpoint.");
  const scope = (meta.scopes_supported || []).includes("full") ? "full" : ((meta.scopes_supported || [])[0] || "read");
  // Always request refresh_token so sessions outlive the short access-token TTL.
  const reg = await outboundRequest("POST", meta.registration_endpoint, { json: {
    client_name: "Kinetic App Launcher",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
    scope,
  }});
  if (reg.status >= 400 || !reg.data || !reg.data.client_id) {
    throw new Error("Client registration failed (HTTP " + reg.status + "): " + ((reg.data && (reg.data.error_description || reg.data.error)) || reg.text || "").slice(0, 200));
  }
  ssoClients.set(server, { clientId: reg.data.client_id, clientSecret: reg.data.client_secret, redirectUri, tokenEndpoint: meta.token_endpoint });
  return { meta, clientId: reg.data.client_id, clientSecret: reg.data.client_secret };
}


/* ───── Shared helpers object for auto-discovered app handlers ───── */
const appHelpers = {
  kineticRequest,
  collectByQuery,
  jsonResp,
  readBody,
  vf: (s, f) => s.values?.[f] || "",
};

/* ───── APP_ABOUT (auto-generated from app.json) ───── */
const APP_ABOUT = {};
function buildAppAbout() {
  for (const k of Object.keys(APP_ABOUT)) delete APP_ABOUT[k];
  for (const [slug, reg] of Object.entries(APP_REGISTRY)) {
    const appJsonPath = path.join(__dir, "..", reg.dir, "app.json");
    if (fs.existsSync(appJsonPath)) {
      try {
        const def = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
        APP_ABOUT[slug] = {
          title: def.name || slug,
          overview: def.description || "",
          kapp: def.slug || slug,
          tabs: [],
          entities: (def.forms || []).map(f => ({
            name: f.name,
            color: "#5F6368",
            fields: (f.fields || []).slice(0, 6).map(fi => fi.name),
          })),
          rels: [],
        };
      } catch {}
    }
  }
}
buildAppAbout();

/* ───── Script injection for auto-login ───── */
function injectScripts(html, appSlug) {
  const about = APP_ABOUT[appSlug];
  const aboutJSON = about ? JSON.stringify(about).replace(/<\//g, "<\\/") : "null";
  const appKapp = APP_REGISTRY[appSlug]?.kapp || null;
  const appKappJSON = appKapp ? JSON.stringify(appKapp) : "null";

  // Head script: populate sessionStorage + hide login screen immediately (no flash)
  // Also monkey-patches fetch to add X-Kinetic-Server header for multi-server tab isolation
  const headScript = `<style>#login-screen{display:none!important}#app{display:block!important}</style>
<script>
(function(){
  var s = sessionStorage.getItem('base_session');
  if (!s) { s = localStorage.getItem('base_session'); if (s) sessionStorage.setItem('base_session', s); }
  if (!s) { window.location.replace('/'); return; }
  try {
    var sess = JSON.parse(s);
    var server = sess.server || sess.url || '';
    sess.server = server;
    sess.url = '';
    // SSO/token sessions carry no password. Apps build "Authorization: Basic <base64>"
    // from sess.auth; synthesize a placeholder from the token so that keeps working,
    // and the wrapper below rewrites the resulting Basic header to Bearer before it
    // leaves the browser. Without this, token sessions fail every authenticated call.
    if (sess.token) {
      var _u = sess.user || sess.username || 'sso';
      if (!sess.auth) { try { sess.auth = btoa(_u + ':' + sess.token); } catch(e) {} }
      if (!sess.pass) { sess.pass = sess.token; }
    }
    var k = JSON.stringify(sess);
    sessionStorage.setItem('kinetic_session', k);
    sessionStorage.setItem('atlas_session', k);
    if (server) {
      var _tok = { access: sess.token || '', refresh: sess.refreshToken || '' };
      var _origFetch = window.fetch;
      var _refreshing = null;

      // Add X-Kinetic-Server (all sessions) and, for token sessions, a Bearer header.
      // Absolute same-origin URLs (apps often build \`\${API}/app/...\`) are normalized
      // to their path so they match the /app/ and /api/ prefixes too.
      var applyAuth = function(init) {
        init = init || {};
        if (!init.headers) init.headers = {};
        var setHdr = function(name, val) {
          if (init.headers instanceof Headers) init.headers.set(name, val);
          else if (typeof init.headers === 'object' && !Array.isArray(init.headers)) init.headers[name] = val;
        };
        var hasHdr = function(name) {
          if (init.headers instanceof Headers) return init.headers.has(name);
          if (typeof init.headers === 'object' && !Array.isArray(init.headers)) { for (var k in init.headers) if (k.toLowerCase() === name.toLowerCase()) return true; }
          return false;
        };
        var getHdr = function(name) {
          if (init.headers instanceof Headers) return init.headers.get(name);
          if (typeof init.headers === 'object' && !Array.isArray(init.headers)) { for (var k in init.headers) if (k.toLowerCase() === name.toLowerCase()) return init.headers[k]; }
          return '';
        };
        if (!hasHdr('X-Kinetic-Server')) setHdr('X-Kinetic-Server', server);
        if (_tok.access) {
          var cur = getHdr('Authorization') || '';
          if (!cur || cur.indexOf('Basic ') === 0 || cur.indexOf('Bearer ') === 0) setHdr('Authorization', 'Bearer ' + _tok.access);
        }
        return init;
      };

      var persistToken = function() {
        try {
          ['base_session','kinetic_session','atlas_session'].forEach(function(key){
            var raw = sessionStorage.getItem(key);
            if (!raw) return;
            var o = JSON.parse(raw);
            o.token = _tok.access; o.refreshToken = _tok.refresh;
            if (o.pass) o.pass = _tok.access;
            if (o.auth) { try { o.auth = btoa((o.user||o.username||'sso')+':'+_tok.access); } catch(e){} }
            sessionStorage.setItem(key, JSON.stringify(o));
          });
          var braw = localStorage.getItem('base_session');
          if (braw) { var bo = JSON.parse(braw); bo.token=_tok.access; bo.refreshToken=_tok.refresh; localStorage.setItem('base_session', JSON.stringify(bo)); }
        } catch(e) {}
      };

      var doRefresh = function() {
        if (!_tok.refresh) return Promise.resolve(false);
        if (_refreshing) return _refreshing;
        _refreshing = _origFetch('/api/base/oauth/refresh', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ server: server, refresh_token: _tok.refresh }) })
          .then(function(r){ return r.ok ? r.json() : null; })
          .then(function(d){ _refreshing = null; if (!d || !d.access_token) return false; _tok.access = d.access_token; if (d.refresh_token) _tok.refresh = d.refresh_token; persistToken(); return true; })
          .catch(function(){ _refreshing = null; return false; });
        return _refreshing;
      };

      // Proactive refresh ~45s before expiry (first's refresh tokens are short-lived,
      // so a purely reactive on-401 refresh arrives too late). Reschedule on success.
      var _refreshTimer = null;
      var scheduleRefresh = function() {
        if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
        if (!_tok.access || !_tok.refresh) return;
        var exp = 0;
        try { exp = JSON.parse(atob(_tok.access.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).exp; } catch(e) {}
        if (!exp) return;
        var ms = (exp - Math.floor(Date.now()/1000) - 45) * 1000;
        if (ms < 3000) ms = 3000;
        _refreshTimer = setTimeout(function(){ doRefresh().then(function(ok){ if (ok) scheduleRefresh(); }); }, ms);
      };
      scheduleRefresh();

      window.fetch = function(input, init) {
        var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        var _path = url;
        if (/^https?:\\/\\//i.test(_path)) { try { _path = new URL(_path).pathname; } catch(e) {} }
        if (_path.indexOf('/app/') !== 0 && _path.indexOf('/api/') !== 0) return _origFetch.apply(this, arguments);
        var self = this;
        init = applyAuth(init);
        if (!_tok.access || !_tok.refresh || _path.indexOf('/api/base/oauth/') === 0) return _origFetch.call(self, input, init);
        return _origFetch.call(self, input, init).then(function(resp){
          if (resp.status !== 401) return resp;
          return doRefresh().then(function(ok){ if (!ok) return resp; init = applyAuth(init); return _origFetch.call(self, input, init); });
        });
      };
    }
  } catch(e) { window.location.replace('/'); }
})();
</script>
<script>
// Check if the kapp exists — if not, show install prompt for admins
(function(){
  var _kappSlug = ${appKappJSON};
  if (!_kappSlug) return;
  var sess;
  try { sess = JSON.parse(sessionStorage.getItem('base_session')); } catch(e){ return; }
  if (!sess || (!sess.auth && !sess.token)) return;
  // Token/SSO sessions have no password — authenticate with the Bearer token.
  var authHeader = sess.token ? ('Bearer ' + sess.token) : ('Basic ' + sess.auth);

  // Check kapp existence
  fetch('/app/api/v1/kapps/' + _kappSlug, { headers: { Authorization: authHeader } })
    .then(function(r) {
      if (r.ok) return; // kapp exists, let the app load normally

      // Kapp doesn't exist — check if user is admin
      return fetch('/app/api/v1/me', { headers: { Authorization: authHeader } })
        .then(function(r2){ return r2.json(); })
        .then(function(me){
          // Hide the app content and show install prompt
          document.querySelectorAll('#app, #login-screen, .console, main, .dashboard').forEach(function(el){ el.style.display = 'none'; });

          var overlay = document.createElement('div');
          overlay.id = 'kapp-install-overlay';
          overlay.style.cssText = 'position:fixed;inset:0;background:#F1F3F4;z-index:300;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';

          var appName = ${aboutJSON} ? ${aboutJSON}.title : _kappSlug;
          var formCount = ${aboutJSON} && ${aboutJSON}.entities ? ${aboutJSON}.entities.length : '?';

          if (me.spaceAdmin) {
            overlay.innerHTML = '<div style="background:white;border-radius:16px;padding:40px;max-width:480px;width:100%;box-shadow:0 4px 12px rgba(0,0,0,.15);text-align:center">'
              + '<div style="width:56px;height:56px;border-radius:12px;background:#FFF3E0;display:flex;align-items:center;justify-content:center;margin:0 auto 20px"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#F36C24" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>'
              + '<h2 style="font-size:20px;color:#242F4D;margin-bottom:8px">' + appName + '</h2>'
              + '<p style="color:#5F6368;font-size:14px;margin-bottom:4px">This app has not been installed yet.</p>'
              + '<p style="color:#5F6368;font-size:13px;margin-bottom:24px">Kapp: <code style="background:#F8F9FA;padding:2px 6px;border-radius:4px;font-size:12px">' + _kappSlug + '</code> &middot; ' + formCount + ' forms</p>'
              + '<div style="display:flex;gap:12px;justify-content:center">'
              + '<button id="kapp-install-btn" data-seed="false" style="background:#242F4D;color:white;border:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s;font-family:inherit">Install App</button>'
              + '<button id="kapp-install-seed-btn" data-seed="true" style="background:#F36C24;color:white;border:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s;font-family:inherit">Install App + Seed Data</button>'
              + '</div>'
              + '<div id="kapp-install-log" style="margin-top:20px;background:#1a1a2e;border-radius:8px;padding:14px 16px;font-family:SF Mono,Monaco,Consolas,monospace;font-size:12px;color:#ccc;max-height:220px;overflow-y:auto;display:none;text-align:left;line-height:1.7;white-space:pre-wrap"></div>'
              + '<div style="margin-top:20px"><a href="/" style="color:#5F6368;font-size:13px;text-decoration:none">&larr; Back to Launcher</a></div>'
              + '</div>';
          } else {
            overlay.innerHTML = '<div style="background:white;border-radius:16px;padding:40px;max-width:420px;width:100%;box-shadow:0 4px 12px rgba(0,0,0,.15);text-align:center">'
              + '<h2 style="font-size:20px;color:#242F4D;margin-bottom:8px">' + appName + '</h2>'
              + '<p style="color:#5F6368;font-size:14px;margin-bottom:24px">This app has not been installed yet. Contact your administrator to install it.</p>'
              + '<a href="/" style="color:#F36C24;font-size:14px;font-weight:600;text-decoration:none">&larr; Back to Launcher</a>'
              + '</div>';
          }

          document.body.appendChild(overlay);

          // Wire up install button
          function doInstall(withSeed) {
              var btn = document.getElementById('kapp-install-btn');
              var seedBtn = document.getElementById('kapp-install-seed-btn');
              btn.disabled = true; seedBtn.disabled = true;
              btn.style.opacity = '0.5'; seedBtn.style.opacity = '0.5';
              (withSeed ? seedBtn : btn).textContent = 'Installing...';
              var logEl = document.getElementById('kapp-install-log');
              logEl.style.display = 'block';
              logEl.textContent = '';

              function addLog(msg, color) {
                var line = document.createElement('div');
                line.style.color = color || '#ccc';
                line.textContent = msg;
                logEl.appendChild(line);
                logEl.scrollTop = logEl.scrollHeight;
              }

              addLog('Connecting to server...', '#60a5fa');

              fetch('/api/appmgr/install/' + encodeURIComponent(_kappSlug), {
                method: 'POST',
                headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({ seed: withSeed, username: me.username || me.displayName })
              })
              .then(function(r3) {
                var reader = r3.body.getReader();
                var decoder = new TextDecoder();
                var buffer = '';
                function colorFor(obj) {
                  if (obj.fail) return '#f87171';
                  if (obj.warn) return '#fbbf24';
                  if (obj.ok) return '#4ade80';
                  if (obj.step === 'index') return '#60a5fa';
                  if (obj.step === 'seed') return '#c084fc';
                  return '#ccc';
                }
                function pump() {
                  return reader.read().then(function(result) {
                    if (result.value) buffer += decoder.decode(result.value, { stream: true });
                    var lines = buffer.split('\\n');
                    buffer = lines.pop();
                    lines.forEach(function(line) {
                      if (!line.trim()) return;
                      try {
                        var obj = JSON.parse(line);
                        if (obj.done) {
                          if (obj.status === 'installed') {
                            addLog('', '#ccc');
                            addLog('Installation complete! Reloading...', '#4ade80');
                            btn.textContent = 'Installed';
                            btn.style.background = '#34A853';
                            setTimeout(function(){ window.location.reload(); }, 2000);
                          } else {
                            addLog('FAILED: ' + (obj.error || 'Unknown error'), '#f87171');
                            btn.textContent = 'Install App';
                            seedBtn.textContent = 'Install App + Seed Data';
                            btn.disabled = false; seedBtn.disabled = false;
                            btn.style.opacity = '1'; seedBtn.style.opacity = '1';
                          }
                        } else if (obj.msg) {
                          addLog(obj.msg, colorFor(obj));
                        }
                      } catch(e) {}
                    });
                    if (!result.done) return pump();
                  });
                }
                return pump();
              })
              .catch(function(err) {
                addLog('Error: ' + err.message, '#f87171');
                btn.textContent = 'Retry';
                btn.disabled = false;
                seedBtn.disabled = false;
                btn.style.opacity = '1';
                seedBtn.style.opacity = '1';
              });
          }
          var btn = document.getElementById('kapp-install-btn');
          var seedBtn = document.getElementById('kapp-install-seed-btn');
          if (btn) btn.onclick = function() { doInstall(false); };
          if (seedBtn) seedBtn.onclick = function() { doInstall(true); };
        });
    })
    .catch(function(){}); // silently ignore network errors
})();
</script>`;

  // Body script: add Home icon, user menu, About modal, override doLogout
  const bodyScript = `<script>
(function(){
  var _about = ${aboutJSON};
  var _appKapp = ${appKappJSON};

  /* ── About modal CSS ── */
  var sty = document.createElement('style');
  sty.textContent = [
    '#base-about-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;display:none;align-items:flex-start;justify-content:center;padding:40px 20px;overflow-y:auto}',
    '#base-about-overlay.open{display:flex}',
    '#base-about-box{background:white;border-radius:16px;max-width:780px;width:100%;box-shadow:0 4px 12px rgba(0,0,0,.15);animation:baseAboutIn .2s ease-out}',
    '@keyframes baseAboutIn{from{opacity:0;transform:translateY(-12px)}to{opacity:1;transform:translateY(0)}}',
    '#base-about-box .ba-header{padding:20px 24px 16px;border-bottom:1px solid #E8EAED;display:flex;align-items:center;gap:12px}',
    '#base-about-box .ba-header h2{font-size:18px;color:#242F4D;flex:1}',
    '#base-about-box .ba-close{background:none;border:none;font-size:22px;color:#5F6368;padding:4px 8px;border-radius:6px;cursor:pointer;line-height:1}',
    '#base-about-box .ba-close:hover{background:#F8F9FA;color:#242F4D}',
    '#base-about-box .ba-body{padding:24px;font-size:14px;line-height:1.7;color:#202124}',
    '#base-about-box .ba-body p{margin-bottom:16px;color:#5F6368;font-size:14px}',
    '#base-about-box .ba-body .ba-kapp{display:inline-block;font-size:11px;font-family:monospace;background:#F8F9FA;border:1px solid #E8EAED;padding:2px 8px;border-radius:4px;color:#5F6368;margin-bottom:16px}',
    '#base-about-box .ba-section{font-size:15px;font-weight:700;color:#242F4D;border-bottom:2px solid #E8EAED;padding-bottom:6px;margin:24px 0 12px}',
    '#base-about-box .ba-tabs{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px}',
    '#base-about-box .ba-tab{background:#F8F9FA;border-radius:8px;padding:12px}',
    '#base-about-box .ba-tab strong{color:#242F4D;font-size:13px}',
    '#base-about-box .ba-tab span{font-size:12px;color:#5F6368;display:block;margin-top:2px}',
    '#base-about-box .ba-erd{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px}',
    '#base-about-box .ba-entity{background:white;border:1px solid #E8EAED;border-radius:8px;min-width:130px;max-width:180px;flex:1;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden}',
    '#base-about-box .ba-ename{font-size:11px;font-weight:700;color:white;padding:5px 8px;letter-spacing:.3px}',
    '#base-about-box .ba-efields{padding:4px 8px}',
    '#base-about-box .ba-efields div{font-size:10px;color:#555;padding:1px 0;border-bottom:1px solid #f3f3f3}',
    '#base-about-box .ba-efields div:last-child{border-bottom:none}',
    '#base-about-box .ba-rels{margin-top:8px}',
    '#base-about-box .ba-rel{font-size:11px;color:#5F6368;padding:2px 0}',
    '#base-about-box .ba-rel strong{color:#242F4D}',
    '#base-about-box .ba-rel .arr{color:#F36C24;font-weight:700}',
  ].join('\\n');
  document.head.appendChild(sty);

  /* ── Build modal HTML ── */
  var overlay = document.createElement('div');
  overlay.id = 'base-about-overlay';
  overlay.onclick = function(e){ if(e.target===overlay) overlay.classList.remove('open'); };
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') overlay.classList.remove('open'); });

  var box = document.createElement('div');
  box.id = 'base-about-box';
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  window._baseShowAbout = function() {
    if (!_about) return;
    var h = '<div class="ba-header"><h2>About ' + _about.title + '</h2><button class="ba-close" onclick="document.getElementById(\\'base-about-overlay\\').classList.remove(\\'open\\')">&times;</button></div>';
    h += '<div class="ba-body">';
    h += '<p>' + _about.overview + '</p>';
    h += '<span class="ba-kapp">kapp: ' + _about.kapp + '</span>';

    if (_about.tabs && _about.tabs.length) {
      h += '<div class="ba-section">Application Tabs</div>';
      h += '<div class="ba-tabs">';
      _about.tabs.forEach(function(t){ h += '<div class="ba-tab"><strong>' + t.name + '</strong><span>' + t.desc + '</span></div>'; });
      h += '</div>';
    }

    if (_about.entities && _about.entities.length) {
      h += '<div class="ba-section">Data Model</div>';
      h += '<div class="ba-erd">';
      _about.entities.forEach(function(e){
        h += '<div class="ba-entity"><div class="ba-ename" style="background:' + e.color + '">' + e.name + '</div><div class="ba-efields">';
        e.fields.forEach(function(f){ h += '<div>' + f + '</div>'; });
        h += '</div></div>';
      });
      h += '</div>';
    }

    if (_about.rels && _about.rels.length) {
      h += '<div class="ba-rels">';
      _about.rels.forEach(function(r){ h += '<div class="ba-rel"><strong>' + r[0] + '</strong> <span class="arr">\\u2192</span> <em>' + r[1] + '</em> <span class="arr">\\u2192</span> <strong>' + r[2] + '</strong></div>'; });
      h += '</div>';
    }

    h += '</div>';
    box.innerHTML = h;
    overlay.classList.add('open');
  };

  /* ── User menu CSS ── */
  var umSty = document.createElement('style');
  umSty.textContent = [
    '.base-user-menu{position:relative}',
    '.base-um-btn{background:none;border:1px solid rgba(255,255,255,.25);color:white;padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .15s;font-family:inherit}',
    '.base-um-btn:hover{border-color:#F36C24;background:rgba(255,255,255,.08)}',
    '.base-um-btn svg{opacity:.7;transition:transform .2s}',
    '.base-user-menu.open .base-um-btn svg{transform:rotate(180deg)}',
    '.base-um-drop{display:none;position:absolute;right:0;top:calc(100% + 6px);background:white;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:180px;overflow:hidden;z-index:200}',
    '.base-user-menu.open .base-um-drop{display:block}',
    '.base-um-drop .um-header{padding:12px 16px;border-bottom:1px solid #E8EAED}',
    '.base-um-drop .um-header .um-name{font-size:13px;font-weight:700;color:#202124}',
    '.base-um-drop .um-header .um-sub{font-size:11px;color:#5F6368;margin-top:2px}',
    '.base-um-drop .um-item{display:flex;align-items:center;gap:8px;padding:10px 16px;font-size:13px;color:#202124;cursor:pointer;transition:background .1s;border:none;background:none;width:100%;font-family:inherit;text-align:left}',
    '.base-um-drop .um-item:hover{background:#F1F3F4}',
    '.base-um-drop .um-item svg{width:16px;height:16px;opacity:.6;flex-shrink:0}',
  ].join('\\n');
  document.head.appendChild(umSty);

  /* ── Add Home icon + user menu to topbar ── */
  function addTopbarItems() {
    var tb = document.querySelector('.topbar') || document.querySelector('.header-bar');
    if (!tb) return;

    // Home icon
    var home = document.createElement('a');
    home.href = '/';
    home.title = 'Back to launcher';
    home.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
    home.style.cssText = 'display:inline-flex;align-items:center;margin-right:14px;padding:5px;border-radius:6px;transition:background .15s;';
    home.onmouseover = function(){ home.style.background='rgba(255,255,255,.12)'; home.querySelector('svg').style.stroke='#F36C24'; };
    home.onmouseout = function(){ home.style.background='transparent'; home.querySelector('svg').style.stroke='rgba(255,255,255,.85)'; };

    var logo = tb.querySelector('.logo') || tb.firstElementChild;
    if (logo) tb.insertBefore(home, logo);
    else tb.prepend(home);

    // Get username from session
    var sess = null;
    try { sess = JSON.parse(sessionStorage.getItem('base_session')); } catch(e){}
    var userName = (sess && (sess.displayName || sess.user)) || 'User';
    var spaceSlug = (sess && sess.spaceSlug) || '';
    var userLabel = spaceSlug ? userName + ' \\u00b7 ' + spaceSlug : userName;

    // Hide original user-info children and insert dropdown menu
    var ui = tb.querySelector('.user-info');
    if (ui) {
      // Hide existing children (but keep #user-display in DOM so app code doesn't break)
      Array.from(ui.children).forEach(function(c){ c.style.display = 'none'; });
      ui.style.gap = '0';

      var menu = document.createElement('div');
      menu.className = 'base-user-menu';
      var hasAbout = _about && !document.querySelector('[onclick*="showAbout"]');
      var items = '';
      if (hasAbout) {
        items += '<button class="um-item" id="base-um-about"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>About</button>';
      }
      items += '<button class="um-item" id="base-um-logout"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>Logout</button>';
      menu.innerHTML = '<button class="base-um-btn"><span>' + userLabel + '</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button>'
        + '<div class="base-um-drop"><div class="um-header"><div class="um-name">' + userName + '</div><div class="um-sub">' + (spaceSlug || 'Kinetic Platform') + '</div></div>' + items + '</div>';

      menu.querySelector('.base-um-btn').onclick = function(e){ e.stopPropagation(); menu.classList.toggle('open'); };
      ui.appendChild(menu);

      if (hasAbout) menu.querySelector('#base-um-about').onclick = function(){ menu.classList.remove('open'); window._baseShowAbout(); };
      menu.querySelector('#base-um-logout').onclick = function(){ window.doLogout(); };

      document.addEventListener('click', function(e){ if(!menu.contains(e.target)) menu.classList.remove('open'); });

      // Async: check if user is admin, add "Manage Kapp" link
      if (_appKapp) {
        var sess2 = null;
        try { sess2 = JSON.parse(sessionStorage.getItem('base_session')); } catch(e){}
        if (sess2 && sess2.auth) {
          fetch('/app/api/v1/me', { headers: { 'Authorization': 'Basic ' + sess2.auth } })
            .then(function(r){ return r.json(); })
            .then(function(me){
              if (me.spaceAdmin) {
                var drop = menu.querySelector('.base-um-drop');
                var logoutItem = menu.querySelector('#base-um-logout');
                var manageBtn = document.createElement('button');
                manageBtn.className = 'um-item';
                manageBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>Manage Kapp';
                manageBtn.onclick = function(){ window.open(window.location.protocol + '//' + window.location.hostname + ':4000/kapp-admin/?kapp=' + _appKapp, '_blank'); };
                if (logoutItem) drop.insertBefore(manageBtn, logoutItem);
                else drop.appendChild(manageBtn);
              }
            })
            .catch(function(){});
        }
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addTopbarItems);
  else addTopbarItems();

  window.doLogout = function() {
    sessionStorage.removeItem('kinetic_session');
    sessionStorage.removeItem('atlas_session');
    sessionStorage.removeItem('base_session');
    localStorage.removeItem('base_session');
    window.location.href = '/';
  };
})();
</script>`;

  // Inject head script after <head> (or after first <meta>)
  html = html.replace(/<head[^>]*>/i, (match) => match + "\n" + headScript);

  // Inject body script before </body>
  html = html.replace(/<\/body>/i, bodyScript + "\n</body>");

  // Rewrite the default server URL input to be empty (since we're same-origin)
  html = html.replace(/value="http:\/\/localhost:\d+"/g, 'value=""');

  return html;
}

/* ───── Crash protection ───── */
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err.message, err.stack);
});
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled rejection:", err);
});

/* ───── HTTP Server ───── */
const server = http.createServer((req, res) => {
 requestStore.run(req, async () => {
 try {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    });
    res.end();
    return;
  }

  // Base API: set/get proxy target
  if (pathname === "/api/base/target" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { url } = JSON.parse(body.toString());
      if (url && typeof url === "string") {
        proxyTarget = url.replace(/\/+$/, "");
        console.log(`[proxy] Target changed to: ${proxyTarget}`);
      } else {
        proxyTarget = KINETIC;
        console.log(`[proxy] Target reset to default: ${proxyTarget}`);
      }
      jsonResp(res, 200, { target: proxyTarget });
    } catch(e) {
      jsonResp(res, 400, { error: "Invalid JSON" });
    }
    return;
  }
  if (pathname === "/api/base/target" && req.method === "GET") {
    jsonResp(res, 200, { target: proxyTarget });
    return;
  }

  // ── Enterprise SSO step 1: begin authorization_code + PKCE flow ──
  if (pathname === "/api/base/oauth/start" && req.method === "POST") {
    try {
      let server = "";
      try { server = (JSON.parse((await readBody(req)) || "{}").server || "").trim(); } catch {}
      server = server.replace(/\/+$/, "");
      if (server && !/^https?:\/\//.test(server)) server = "https://" + server;
      if (!server) { jsonResp(res, 400, { error: "server is required" }); return; }

      const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
      const redirectUri = proto + "://" + req.headers.host + "/oauth/callback";

      const { meta, clientId, clientSecret } = await ssoRegisterClient(server, redirectUri);
      const scope = (meta.scopes_supported || []).includes("full") ? "full" : ((meta.scopes_supported || [])[0] || "read");

      const verifier = crypto.randomBytes(32).toString("base64url");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const state = crypto.randomBytes(24).toString("base64url");
      ssoGc();
      ssoPending.set(state, { server, tokenEndpoint: meta.token_endpoint, clientId, clientSecret, verifier, redirectUri, createdAt: Date.now() });

      const authorizeUrl = meta.authorization_endpoint +
        "?response_type=code&client_id=" + encodeURIComponent(clientId) +
        "&redirect_uri=" + encodeURIComponent(redirectUri) +
        "&scope=" + encodeURIComponent(scope) +
        "&state=" + encodeURIComponent(state) +
        "&code_challenge=" + encodeURIComponent(challenge) + "&code_challenge_method=S256";

      jsonResp(res, 200, { authorizeUrl, state, server });
    } catch (e) { jsonResp(res, 502, { error: e.message }); }
    return;
  }

  // ── Enterprise SSO step 2: OAuth redirect callback (the popup lands here) ──
  if (pathname === "/oauth/callback" && req.method === "GET") {
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state");
    const oauthErr = parsedUrl.searchParams.get("error");
    const pend = state ? ssoPending.get(state) : null;
    let ok = false, message = "";
    if (oauthErr) {
      const desc = parsedUrl.searchParams.get("error_description");
      message = "Authorization failed: " + oauthErr + (desc ? (" — " + desc) : "");
    } else if (!pend) {
      message = "Login session expired or unknown. Please start over.";
    } else if (!code) {
      message = "No authorization code was returned.";
    } else {
      try {
        const tok = await outboundRequest("POST", pend.tokenEndpoint, { form: {
          grant_type: "authorization_code", code, redirect_uri: pend.redirectUri,
          client_id: pend.clientId, client_secret: pend.clientSecret, code_verifier: pend.verifier,
        }});
        if (tok.status < 400 && tok.data && tok.data.access_token) {
          ssoResults.set(state, { ...tok.data, server: pend.server, createdAt: Date.now() });
          ssoPending.delete(state);
          ok = true;
        } else {
          message = "Token exchange failed (HTTP " + tok.status + "): " + ((tok.data && (tok.data.error_description || tok.data.error)) || tok.text || "").slice(0, 200);
        }
      } catch (e) { message = "Token exchange error: " + e.message; }
    }
    const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Kinetic SSO</title></head>
<body style="font-family:system-ui,Segoe UI,sans-serif;padding:48px;color:#16213e;text-align:center">
  <h2 style="color:${ok ? "#1e8e3e" : "#c0392b"}">${ok ? "Signed in &#10003;" : "Sign-in failed"}</h2>
  <p style="color:#555;max-width:520px;margin:12px auto">${ok ? "You can close this window." : esc(message)}</p>
  <script>
    (function(){
      try { if (window.opener) window.opener.postMessage({ type: "kinetic-sso", ok: ${ok}, state: ${JSON.stringify(state || "")}, message: ${JSON.stringify(message)} }, "*"); } catch (e) {}
      ${ok ? "setTimeout(function(){ try{ window.close(); }catch(e){} }, 500);" : ""}
    })();
  <\/script>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // ── Enterprise SSO step 3: opener retrieves the token once (single-use) ──
  if (pathname === "/api/base/oauth/result" && req.method === "GET") {
    const state = parsedUrl.searchParams.get("state");
    const r = state ? ssoResults.get(state) : null;
    if (!r) { jsonResp(res, 404, { error: "No completed SSO result for this state." }); return; }
    ssoResults.delete(state);
    jsonResp(res, 200, {
      access_token: r.access_token, refresh_token: r.refresh_token || null,
      token_type: r.token_type || "Bearer", expires_in: r.expires_in || null,
      scope: r.scope || null, server: r.server,
    });
    return;
  }

  // ── Enterprise SSO: silently refresh an expired access token (called on 401) ──
  if (pathname === "/api/base/oauth/refresh" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      let server = (body.server || "").trim().replace(/\/+$/, "");
      const refreshToken = body.refresh_token;
      if (!server || !refreshToken) { jsonResp(res, 400, { error: "server and refresh_token required" }); return; }
      const client = ssoClients.get(server);
      if (!client) { jsonResp(res, 409, { error: "No registered client for server (launcher restarted) — please sign in again." }); return; }
      let tokenEndpoint = client.tokenEndpoint;
      if (!tokenEndpoint) {
        const disc = await outboundRequest("GET", server + "/.well-known/oauth-authorization-server");
        tokenEndpoint = disc.data && disc.data.token_endpoint;
      }
      if (!tokenEndpoint) { jsonResp(res, 502, { error: "Could not resolve token endpoint." }); return; }
      const tok = await outboundRequest("POST", tokenEndpoint, { form: {
        grant_type: "refresh_token", refresh_token: refreshToken,
        client_id: client.clientId, client_secret: client.clientSecret,
      }});
      if (tok.status >= 400 || !tok.data || !tok.data.access_token) {
        jsonResp(res, 401, { error: "Refresh failed: " + ((tok.data && (tok.data.error_description || tok.data.error)) || tok.text || "").slice(0, 200) });
        return;
      }
      jsonResp(res, 200, { access_token: tok.data.access_token, refresh_token: tok.data.refresh_token || refreshToken, expires_in: tok.data.expires_in || null });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return;
  }

  // GET /api/base/apps — list all auto-discovered apps
  if (pathname === "/api/base/apps" && req.method === "GET") {
    const apps = Object.entries(APP_REGISTRY).map(([slug, reg]) => ({
      slug, name: reg.name, kapp: reg.kapp,
      description: reg.description || '', category: reg.category || '', tags: reg.tags || [],
      icon: reg.icon || '', color: reg.color || '', bg: reg.bg || '', created: reg.created || '',
    })).sort((a, b) => a.name.localeCompare(b.name));
    jsonResp(res, 200, { apps });
    return;
  }

  // POST /api/base/rescan — re-scan the apps/ directory on disk so newly-added
  // apps appear without a server restart, then return the refreshed list.
  if (pathname === "/api/base/rescan" && req.method === "POST") {
    const before = Object.keys(APP_REGISTRY).length;
    const beforeSlugs = new Set(Object.keys(APP_REGISTRY));
    try {
      await discoverApps();
      buildAppAbout();
    } catch (e) {
      jsonResp(res, 500, { error: "Rescan failed: " + e.message });
      return;
    }
    const added = Object.keys(APP_REGISTRY).filter(s => !beforeSlugs.has(s));
    const apps = Object.entries(APP_REGISTRY).map(([slug, reg]) => ({
      slug, name: reg.name, kapp: reg.kapp,
      description: reg.description || '', category: reg.category || '', tags: reg.tags || [],
      icon: reg.icon || '', color: reg.color || '', bg: reg.bg || '', created: reg.created || '',
    })).sort((a, b) => a.name.localeCompare(b.name));
    jsonResp(res, 200, { apps, total: apps.length, before, added });
    return;
  }

  // Built-in: install app from app.json on disk (streams NDJSON progress)
  const installMatch = pathname.match(/^\/api\/appmgr\/install\/([^/]+)$/);
  if (installMatch && req.method === "POST") {
    const appId = decodeURIComponent(installMatch[1]);
    const body = JSON.parse(await readBody(req) || "{}");
    const doSeed = body.seed === true;
    const appsDir = path.resolve(__dir, "..");
    const auth = req.headers["authorization"];

    // Stream NDJSON lines as install progresses
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    });
    function emit(obj) { res.write(JSON.stringify(obj) + "\n"); }

    try {
      // Find app directory by matching app.json slug
      let appDir = null;
      for (const dir of fs.readdirSync(appsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
        const p = path.join(appsDir, dir, "app.json");
        if (!fs.existsSync(p)) continue;
        try { if (JSON.parse(fs.readFileSync(p, "utf-8")).slug === appId) { appDir = path.join(appsDir, dir); break; } } catch {}
      }
      if (!appDir) { emit({ done: true, error: `App '${appId}' not found` }); res.end(); return; }

      const appDef = JSON.parse(fs.readFileSync(path.join(appDir, "app.json"), "utf-8"));
      const kappSlug = body.customSlug || appDef.slug;
      const kappName = body.customName || appDef.name;
      const formCount = appDef.forms.length;

      const SYS_IDX = [
        { name: "closedBy", parts: ["closedBy"], unique: false },
        { name: "createdBy", parts: ["createdBy"], unique: false },
        { name: "handle", parts: ["handle"], unique: true },
        { name: "submittedBy", parts: ["submittedBy"], unique: false },
        { name: "updatedBy", parts: ["updatedBy"], unique: false },
      ];

      function buildPages(fields) {
        const elements = fields.map(f => ({
          type: "field", name: f.name, label: f.name,
          key: crypto.randomBytes(16).toString("hex"),
          dataType: "string", renderType: "text",
          enabled: true, visible: true,
          required: f.required || false, rows: f.rows || 1,
          constraints: [], events: [], renderAttributes: {},
          defaultDataSource: "none", defaultValue: "", defaultResourceName: "",
          requiredMessage: "", omitWhenHidden: null, pattern: null,
        }));
        elements.push({ type: "button", name: "Submit Button", label: "Submit", renderType: "submit-page", visible: true, enabled: true, renderAttributes: {} });
        return [{ name: "Page 1", type: "page", renderType: "submittable", elements, events: [] }];
      }

      // Create kapp
      emit({ step: "kapp", msg: `Creating kapp: ${kappSlug}...` });
      const kr = await kineticRequest("POST", "/kapps", { name: kappName, slug: kappSlug, status: "Active" }, auth);
      if (kr.status < 300) emit({ step: "kapp", msg: `Created kapp: ${kappSlug} (${kappName})`, ok: true });
      else if (kr.data?.errorKey === "uniqueness_violation") emit({ step: "kapp", msg: `Kapp ${kappSlug} already exists`, warn: true });
      else { emit({ done: true, error: `Failed to create kapp: ${kr.status}` }); res.end(); return; }

      // Create forms
      for (let fi = 0; fi < appDef.forms.length; fi++) {
        const form = appDef.forms[fi];
        emit({ step: "form", msg: `Creating form ${fi + 1}/${formCount}: ${form.name} (${form.fields.length} fields)...` });
        const fb = { slug: form.slug, name: form.name, status: "Active", pages: buildPages(form.fields) };
        if (form.description) fb.description = form.description;
        if (form.submissionLabelExpression) fb.submissionLabelExpression = form.submissionLabelExpression;
        const r = await kineticRequest("POST", `/kapps/${kappSlug}/forms`, fb, auth);
        if (r.status < 300) emit({ step: "form", msg: `Created form: ${form.slug}`, ok: true });
        else if (r.data?.errorKey === "uniqueness_violation") emit({ step: "form", msg: `Form ${form.slug} already exists`, warn: true });
        else emit({ step: "form", msg: `FAILED form ${form.slug}: ${r.status}`, fail: true });
      }

      // Build indexes
      for (let fi = 0; fi < appDef.forms.length; fi++) {
        const form = appDef.forms[fi];
        if (!form.indexes) continue;
        const ix = form.indexes, idxDefs = [...SYS_IDX], custom = [];
        for (const p of (ix.single || [])) { idxDefs.push({ parts: [p], unique: false }); custom.push(p); }
        for (const ps of (ix.compound || [])) { idxDefs.push({ parts: ps, unique: false }); custom.push(ps.join(",")); }
        if (!custom.length) continue;
        emit({ step: "index", msg: `Building ${custom.length} indexes on ${form.slug}...` });
        await kineticRequest("PUT", `/kapps/${kappSlug}/forms/${form.slug}`, { indexDefinitions: idxDefs }, auth);
        await kineticRequest("POST", `/kapps/${kappSlug}/forms/${form.slug}/backgroundJobs`, { type: "Build Index", content: { indexes: custom } }, auth);
        // Wait for indexes to build (up to 30s per form)
        for (let w = 0; w < 15; w++) {
          await new Promise(r => setTimeout(r, 2000));
          const check = await kineticRequest("GET", `/kapps/${kappSlug}/forms/${form.slug}?include=indexDefinitions`, null, auth);
          const defs = (check.data?.form || check.data)?.indexDefinitions || [];
          const pending = defs.filter(d => d.status === "New" && custom.includes(d.parts.join(",")));
          if (!pending.length) break;
          emit({ step: "index", msg: `  Waiting for indexes on ${form.slug}... (${pending.length} remaining)` });
        }
        emit({ step: "index", msg: `Indexes built: ${form.slug} (${custom.length} custom)`, ok: true });
      }

      // Create workflows (kapp-level then form-level)
      let wfCount = 0;
      for (const wf of (appDef.workflows || [])) {
        const r = await kineticRequest("POST", `/kapps/${kappSlug}/workflows`, {
          name: wf.name, event: wf.event, type: wf.type || "Tree", status: wf.status || "Active",
        }, auth);
        if (r.status < 300 && wf.treeXml) {
          await kineticRequest("PUT", `/kapps/${kappSlug}/workflows/${r.data.id}`, { treeXml: wf.treeXml }, auth);
          wfCount++;
          emit({ step: "workflow", msg: `Workflow (kapp): ${wf.name}`, ok: true });
        } else if (r.data?.errorKey === "uniqueness_violation") {
          emit({ step: "workflow", msg: `Workflow ${wf.name} already exists`, warn: true });
        } else if (r.status >= 300) {
          emit({ step: "workflow", msg: `FAILED workflow ${wf.name}: ${r.status}`, fail: true });
        }
      }
      for (const form of appDef.forms) {
        for (const wf of (form.workflows || [])) {
          const r = await kineticRequest("POST", `/kapps/${kappSlug}/forms/${form.slug}/workflows`, {
            name: wf.name, event: wf.event, type: wf.type || "Tree", status: wf.status || "Active",
          }, auth);
          if (r.status < 300 && wf.treeXml) {
            await kineticRequest("PUT", `/kapps/${kappSlug}/forms/${form.slug}/workflows/${r.data.id}`, { treeXml: wf.treeXml }, auth);
            wfCount++;
            emit({ step: "workflow", msg: `Workflow (${form.slug}): ${wf.name}`, ok: true });
          } else if (r.data?.errorKey === "uniqueness_violation") {
            emit({ step: "workflow", msg: `Workflow ${wf.name} on ${form.slug} already exists`, warn: true });
          } else if (r.status >= 300) {
            emit({ step: "workflow", msg: `FAILED workflow ${wf.name} on ${form.slug}: ${r.status}`, fail: true });
          }
        }
      }
      if (wfCount > 0) emit({ step: "workflow", msg: `Total workflows created: ${wfCount}`, ok: true });

      // Seed data
      let seedCount = 0;
      if (doSeed) {
        const seedPath = path.join(appDir, "seed-data.json");
        if (fs.existsSync(seedPath)) {
          const seedData = JSON.parse(fs.readFileSync(seedPath, "utf-8"));
          const formSlugs = Object.keys(seedData);
          for (let si = 0; si < formSlugs.length; si++) {
            const formSlug = formSlugs[si];
            const records = seedData[formSlug];
            emit({ step: "seed", msg: `Seeding ${formSlug}: 0/${records.length}...` });
            let ok = 0;
            for (let i = 0; i < records.length; i += 10) {
              const batch = records.slice(i, i + 10);
              const results = await Promise.allSettled(batch.map(values =>
                kineticRequest("POST", `/kapps/${kappSlug}/forms/${formSlug}/submissions`, { values, coreState: "Submitted" }, auth)
              ));
              ok += results.filter(r => r.status === "fulfilled" && r.value.status < 300).length;
              emit({ step: "seed", msg: `Seeding ${formSlug}: ${ok}/${records.length}...` });
            }
            seedCount += ok;
            emit({ step: "seed", msg: `Seeded ${formSlug}: ${ok}/${records.length}`, ok: true });
          }
        } else { emit({ step: "seed", msg: "No seed-data.json found", warn: true }); }
      }

      emit({ done: true, status: "installed", kapp: kappSlug, forms: formCount, seeded: seedCount });
    } catch (e) {
      emit({ done: true, error: e.message });
    }
    res.end();
    return;
  }

  // Dynamic API dispatch — auto-discovered app handlers
  for (const { prefix, handler } of APP_HANDLERS) {
    if (pathname.startsWith(prefix)) {
      const auth = req.headers["authorization"];
      const handled = await handler(req, res, pathname, auth, appHelpers);
      if (handled) return;
      jsonResp(res, 404, { error: "Not found" });
      return;
    }
  }

  // Kinetic proxy — use per-request X-Kinetic-Server header if present
  if (pathname.startsWith("/app/")) {
    const target = resolveTarget(req);
    const url = new URL(req.url, target);
    const headers = { ...req.headers, host: url.host };
    delete headers["x-kinetic-server"];
    delete headers["origin"];
    delete headers["referer"];
    // Request identity (uncompressed) from the origin so a forwarded gzip
    // Content-Encoding + compressed Content-Length can't be mangled by an edge proxy
    // (e.g. Fly), which corrupts larger responses while small ones survive.
    delete headers["accept-encoding"];

    const proxyReq = https.request(url, { method: req.method, headers }, (proxyRes) => {
      // no-transform: stop an edge/CDN (Fly, corporate proxies) from re-compressing the
      // body, so the browser gets plain untouched bytes and a proxy/VPN that mishandles a
      // compressed response can't corrupt larger responses like GET /kapps.
      const _cc = proxyRes.headers["cache-control"];
      res.writeHead(proxyRes.statusCode, {
        ...proxyRes.headers,
        "Content-Encoding": "identity",
        "Cache-Control": _cc ? (_cc + ", no-transform") : "no-transform",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
      });
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (e) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Proxy error: " + e.message);
    });

    req.pipe(proxyReq);
    return;
  }

  // App slug routes: /{slug}/ or /{slug} or /{slug}/file.ext
  const appMatch = pathname.match(/^\/([a-z][a-z0-9-]*)(\/.*)?$/);
  if (appMatch) {
    const slug = appMatch[1];
    const subPath = appMatch[2] || "";
    const app = APP_REGISTRY[slug];
    if (app) {
      // Ensure trailing slash for bare slug
      if (!subPath) {
        res.writeHead(301, { Location: `/${slug}/` });
        res.end();
        return;
      }

      // Determine which file to serve
      const fileName = subPath === "/" ? "index.html" : subPath.slice(1);
      const filePath2 = path.join(APPS_DIR, app.dir, fileName);
      const ext2 = path.extname(filePath2);
      const types2 = {
        ".html": "text/html", ".js": "application/javascript",
        ".css": "text/css", ".json": "application/json",
        ".svg": "image/svg+xml",
      };

      try {
        let content = fs.readFileSync(filePath2, ext2 === ".html" ? "utf-8" : undefined);
        if (ext2 === ".html") {
          content = injectScripts(content, slug);
        }
        res.writeHead(200, {
          "Content-Type": types2[ext2] || "application/octet-stream",
          "Cache-Control": "no-cache",
        });
        res.end(content);
      } catch (e) {
        // Fall through to 404
      }
      return;
    }
  }

  // Landing page and static files from base directory
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(__dir, filePath);
  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html", ".js": "application/javascript",
    ".css": "text/css", ".json": "application/json",
    ".svg": "image/svg+xml",
  };

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
 } catch (err) {
    console.error("[ERROR] Request handler crash:", req.method, req.url, err.message, err.stack);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
 });
});

server.listen(PORT, () => {
  console.log(`\n  Unified Base App running at: http://localhost:${PORT}\n`);
  console.log(`  Default proxy target: ${KINETIC} (changeable via /api/base/target)`);
  console.log(`\n  Auto-discovered ${Object.keys(APP_REGISTRY).length} apps:`);
  for (const [slug, app] of Object.entries(APP_REGISTRY)) {
    console.log(`    /${slug}/  ->  ${app.name} (from ${app.dir}/)`);
  }
  console.log(`\n  Custom API handlers (${APP_HANDLERS.length} apps):`);
  for (const { prefix, appId } of APP_HANDLERS) {
    console.log(`    ${prefix}/*  (${appId})`);
  }
  console.log();
});
