/**
 * School Management — Custom API Handler
 */

export const appId = "school-mgmt";
export const apiPrefix = "/api/schmgmt";
export const kapp = "school-mgmt";

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 2) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // GET /api/school-mgmt/dashboard
  if (pathname === "/api/schmgmt/dashboard" && req.method === "GET") {
    try {
      const [students, teachers, classes, enrollments, buildings, busRoutes, allergies] = await Promise.all([
        collect("students", null, 2),
        collect("teachers", null, 2),
        collect("classes", null, 2),
        collect("enrollments", null, 2),
        collect("buildings", null, 2),
        collect("bus-routes", null, 2),
        collect("student-allergies", null, 2),
      ]);

      const pack = (arr) => ({ items: arr, more: arr.length >= 50 });

      jsonResp(res, 200, {
        students: pack(students),
        teachers: pack(teachers),
        classes: pack(classes),
        enrollments: pack(enrollments),
        buildings: pack(buildings),
        busRoutes: pack(busRoutes),
        allergies: pack(allergies),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
