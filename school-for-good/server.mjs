/**
 * School for Good — Custom API Handler
 */

export const appId = "school-for-good";
export const apiPrefix = "/api/school";
export const kapp = "school-for-good";

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // GET /api/school/stats
  if (pathname === "/api/school/stats" && req.method === "GET") {
    try {
      const [sites, members, trainers, classes, enrollments, reminders] = await Promise.all([
        collect("sites", null, 1),
        collect("members", null, 8),
        collect("trainers", null, 1),
        collect("classes", null, 2),
        collect("enrollments", null, 20),
        collect("reminders", null, 2),
      ]);

      // Members by site
      const membersBySite = {};
      for (const m of members) {
        const site = vf(m, "Site");
        membersBySite[site] = (membersBySite[site] || 0) + 1;
      }

      // Members by education
      const membersByEd = {};
      for (const m of members) {
        const ed = vf(m, "Education Level") || "Unknown";
        membersByEd[ed] = (membersByEd[ed] || 0) + 1;
      }

      // Favorite foods
      const foodCounts = {};
      for (const m of members) {
        const food = vf(m, "Favorite Food") || "Unknown";
        foodCounts[food] = (foodCounts[food] || 0) + 1;
      }

      // Enrollments per class
      const enrollPerClass = {};
      for (const e of enrollments) {
        const cn = vf(e, "Class Name");
        enrollPerClass[cn] = (enrollPerClass[cn] || 0) + 1;
      }

      // Reminder stats
      const pendingReminders = reminders.filter(r => vf(r, "Status") === "Pending").length;
      const sentReminders = reminders.filter(r => vf(r, "Status") === "Sent").length;

      jsonResp(res, 200, {
        totals: { sites: sites.length, members: members.length, trainers: trainers.length, classes: classes.length, enrollments: enrollments.length, reminders: reminders.length },
        membersBySite,
        membersByEd,
        foodCounts,
        enrollPerClass,
        reminderStats: { pending: pendingReminders, sent: sentReminders },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/school/sites
  if (pathname === "/api/school/sites" && req.method === "GET") {
    try {
      const sites = await collect("sites", null, 1);
      jsonResp(res, 200, { sites: sites.map(s => ({ id: s.id, ...s.values })) });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/school/members?site=...
  if (pathname === "/api/school/members" && req.method === "GET") {
    try {
      const members = await collect("members", null, 8);
      jsonResp(res, 200, { members: members.map(m => ({ id: m.id, ...m.values })) });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/school/trainers
  if (pathname === "/api/school/trainers" && req.method === "GET") {
    try {
      const trainers = await collect("trainers", null, 1);
      jsonResp(res, 200, { trainers: trainers.map(t => ({ id: t.id, ...t.values })) });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/school/classes
  if (pathname === "/api/school/classes" && req.method === "GET") {
    try {
      const classes = await collect("classes", null, 2);
      jsonResp(res, 200, { classes: classes.map(c => ({ id: c.id, ...c.values })) });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/school/enrollments
  if (pathname === "/api/school/enrollments" && req.method === "GET") {
    try {
      const enrollments = await collect("enrollments", null, 20);
      jsonResp(res, 200, { enrollments: enrollments.map(e => ({ id: e.id, ...e.values })) });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/school/reminders
  if (pathname === "/api/school/reminders" && req.method === "GET") {
    try {
      const reminders = await collect("reminders", null, 2);
      jsonResp(res, 200, { reminders: reminders.map(r => ({ id: r.id, ...r.values })) });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/school/members/new — create member + welcome email reminder
  if (pathname === "/api/school/members/new" && req.method === "POST") {
    try {
      const values = JSON.parse(await readBody(req));
      // Create the member submission
      const memberResult = await kineticRequest("POST",
        `/app/api/v1/kapps/${KAPP}/forms/members/submissions`,
        { values }, auth);
      const memberId = memberResult.submission?.id;
      const first = values["First Name"] || "";
      const site = values.Site || "your site";
      const email = values.Email || "";

      // Create a welcome email reminder
      const welcomeMessage = `Dear ${first},\n\nWelcome to SchoolForGood! We are thrilled to have you join our learning community at ${site}.\n\nYour account has been created and you're all set to start exploring classes. Here's what you can do next:\n\n- Browse available classes on your site's schedule\n- Enroll in classes that interest you\n- Receive reminders before each class session\n- Connect with your trainers and fellow members\n\nIf you have any questions, reach out to your site coordinator at ${site}.\n\nWe look forward to seeing you in class!\n\nWarm regards,\nThe SchoolForGood Team`;

      await kineticRequest("POST",
        `/app/api/v1/kapps/${KAPP}/forms/reminders/submissions`,
        { values: {
          "Member Name": `${values["First Name"]} ${values["Last Name"]}`,
          "Member Email": email,
          "Class Name": "Welcome Orientation",
          Site: site,
          Day: new Date().toLocaleDateString("en-US", { weekday: "long" }),
          Time: "N/A",
          "Reminder Date": new Date().toISOString().split("T")[0],
          Message: welcomeMessage,
          Status: "Sent",
        }}, auth);

      jsonResp(res, 200, { id: memberId, welcomeEmailSent: true });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/school/reminders/send  — mark pending reminders as sent
  if (pathname === "/api/school/reminders/send" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const ids = body.ids || [];
      const results = [];
      for (const id of ids) {
        const r = await kineticRequest("PUT", `/app/api/v1/submissions/${id}/values`, { Status: "Sent" }, auth);
        results.push(r);
      }
      jsonResp(res, 200, { sent: ids.length });
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

  server.listen(PORT, () => console.log(`\n  School for Good: http://localhost:${PORT}\n`));
}
