// Test harness: drives server.mjs's handleAPI directly against a real Kinetic space, with the same
// helper contract the base launcher provides. Credentials come from the environment only.
//   KINETIC_URL, KINETIC_USER, KINETIC_PASS
import { Readable } from "stream";
import { handleAPI, apiPrefix } from "../server.mjs";

export const BASE = (process.env.KINETIC_URL || "").replace(/\/+$/, "");
export function basic(user = process.env.KINETIC_USER, pass = process.env.KINETIC_PASS) {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}
if (!BASE || !process.env.KINETIC_USER || !process.env.KINETIC_PASS) { console.error("Set KINETIC_URL, KINETIC_USER, KINETIC_PASS"); process.exit(1); }

export async function kineticRequest(method, apiPath, body, auth) {
  const r = await fetch(BASE + "/app/api/v1" + apiPath, { method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: r.status, data };
}
const helpers = {
  kineticRequest,
  kineticTarget: () => BASE,
  jsonResp(res, status, data) { res.status = status; res.body = data; },
  readBody(req) { return new Promise(resolve => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => resolve(Buffer.concat(c).toString())); }); },
};

// call("GET", "/stats") → { status, body }
export async function call(method, path, payload, { auth = basic(), agent = "" } = {}) {
  const req = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []);
  req.method = method; req.url = apiPrefix + path;
  req.headers = { authorization: auth, ...(agent ? { "x-cb-agent": agent } : {}) };
  const res = { writeHead(status, headers) { res.status = status; res.headers = headers; }, end(b) { res.body = b; } };
  const handled = await handleAPI(req, res, apiPrefix + path.split("?")[0], auth, helpers);
  if (handled === false) return { status: 404, body: { error: "route not handled" } };
  return { status: res.status, body: res.body };
}
