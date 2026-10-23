/**
 * users.mjs — provision pilot users with admin-set attributes (NOC Tenant, NOC Role). Idempotent.
 * Password from NOC_TEST_PASSWORD (default for the dev space only). Never uses profile attributes.
 */
import { core, ok } from "./lib.mjs";
export const PW = process.env.NOC_TEST_PASSWORD || "noc-pilot-2026";
export const USERS = [
  ["noc.borealis", "Dana Okafor (NOC Operator)", "borealis", ["Operator"]],
  ["owner.borealis", "Priya Raman (Service Owner)", "borealis", ["Service Owner"]],
  ["tech.borealis", "Luis Ortega (Field Tech)", "borealis", ["Field Tech"]],
  ["support.borealis", "Tom Becker (Support Agent)", "borealis", ["Support Agent"]],
  ["exec.borealis", "Grace Holm (Operations Executive)", "borealis", ["Executive"]],
  ["noc.prairie", "Prairie NOC Operator", "prairie", ["Operator"]],
  ["int.borealis", "Borealis monitoring integration", "borealis", ["Integration"]],
  ["int.prairie", "Prairie monitoring integration", "prairie", ["Integration"]],
];
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [username, displayName, tenant, roles] of USERS) {
    const body = { username, displayName, email: `${username}@noc-pilot.example`, enabled: true, spaceAdmin: false, password: PW,
      attributes: [{ name: "NOC Tenant", values: [tenant] }, { name: "NOC Role", values: roles }] };
    let r = await core("POST", "/users", body);
    if (!ok(r)) r = await core("PUT", `/users/${encodeURIComponent(username)}`, body); // PUT includes password (PUT can otherwise clear it)
    const chk = await core("GET", `/users/${encodeURIComponent(username)}?include=attributes`);
    const attrs = Object.fromEntries((chk.data.user?.attributes || []).map((a) => [a.name, a.values]));
    console.log(`${ok(r) && attrs["NOC Tenant"]?.[0] === tenant ? "✓" : "✗"} ${username} tenant=${attrs["NOC Tenant"]} roles=${attrs["NOC Role"]} ${ok(r) ? "" : r.status + " " + JSON.stringify(r.data).slice(0, 160)}`);
  }
}
