/**
 * AI Classes — Custom API Handler
 * Dashboard aggregation + per-class roster/feedback rollups across
 * teachers, students, classes, attendance and feedback forms.
 */
export const appId = "ai-classes";
export const apiPrefix = "/api/ai-classes";
export const kapp = "ai-classes";

const UPCOMING = new Set(["Scheduled", "In Progress"]);

function num(x) { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; }
function avg(arr) { return arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0; }

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, jsonResp, vf } = helpers;

  async function collect(formSlug, kql, maxPages = 12) {
    return collectByQuery(kapp, formSlug, kql, auth, maxPages);
  }

  // GET /api/ai-classes/dashboard — program-wide overview
  if (pathname === "/api/ai-classes/dashboard" && req.method === "GET") {
    try {
      const [classes, teachers, students, attendance, feedback] = await Promise.all([
        collect("classes", null, 8),
        collect("teachers", null, 4),
        collect("students", null, 6),
        collect("attendance", null, 16),
        collect("feedback", null, 16),
      ]);

      // class lookup by Class Code → teacher, for joining feedback back to instructor
      const classByCode = {};
      for (const c of classes) classByCode[vf(c, "Class Code")] = c;

      const completed = classes.filter(c => vf(c, "Status") === "Completed");
      const upcoming = classes.filter(c => UPCOMING.has(vf(c, "Status")));

      // attendance rollups
      const attByStatus = {};
      const lunchBreakdown = {};
      let present = 0, attended = 0;
      for (const a of attendance) {
        const st = vf(a, "Status") || "Unknown";
        attByStatus[st] = (attByStatus[st] || 0) + 1;
        if (st !== "Excused") {
          attended++;
          if (st === "Present" || st === "Late") present++;
        }
        const lunch = vf(a, "Lunch Preference") || "Unspecified";
        lunchBreakdown[lunch] = (lunchBreakdown[lunch] || 0) + 1;
      }
      const attendanceRate = attended ? Math.round((present / attended) * 100) : 0;

      // feedback rollups
      const overall = [], content = [], instr = [];
      let recommendYes = 0, recommendTotal = 0;
      const teacherRatings = {}; // teacher -> [instructorRating]
      for (const f of feedback) {
        const o = num(vf(f, "Overall Rating"));
        if (o) overall.push(o);
        const c = num(vf(f, "Content Rating"));
        if (c) content.push(c);
        const i = num(vf(f, "Instructor Rating"));
        if (i) instr.push(i);
        const rec = vf(f, "Recommend");
        if (rec) { recommendTotal++; if (rec === "Yes") recommendYes++; }
        const cls = classByCode[vf(f, "Class Code")];
        const teacher = cls ? vf(cls, "Teacher") : "";
        if (teacher && i) (teacherRatings[teacher] ||= []).push(i);
      }

      // classes by state / status
      const classesByState = {}, classesByStatus = {};
      for (const c of classes) {
        const stt = vf(c, "State") || "—";
        classesByState[stt] = (classesByState[stt] || 0) + 1;
        const status = vf(c, "Status") || "Unknown";
        classesByStatus[status] = (classesByStatus[status] || 0) + 1;
      }

      // teacher leaderboard (by avg instructor rating, then class count)
      const classCountByTeacher = {};
      for (const c of classes) {
        const t = vf(c, "Teacher");
        if (t) classCountByTeacher[t] = (classCountByTeacher[t] || 0) + 1;
      }
      const leaderboard = teachers.map(t => {
        const name = vf(t, "Name");
        const ratings = teacherRatings[name] || [];
        return {
          name,
          specialty: vf(t, "Specialty"),
          state: vf(t, "State"),
          classes: classCountByTeacher[name] || 0,
          avgRating: avg(ratings),
          reviews: ratings.length,
        };
      }).sort((a, b) => b.avgRating - a.avgRating || b.classes - a.classes);

      // recent feedback (newest first)
      const recentFeedback = [...feedback]
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, 8)
        .map(f => ({
          id: f.id,
          student: vf(f, "Student"),
          classTitle: vf(f, "Class Title"),
          overall: vf(f, "Overall Rating"),
          recommend: vf(f, "Recommend"),
          comments: vf(f, "Comments"),
        }));

      jsonResp(res, 200, {
        kpis: {
          totalClasses: classes.length,
          upcoming: upcoming.length,
          completed: completed.length,
          activeTeachers: teachers.filter(t => vf(t, "Status") !== "Inactive").length,
          totalTeachers: teachers.length,
          totalStudents: students.length,
          avgOverall: avg(overall),
          attendanceRate,
          attendanceRecords: attendance.length,
          recommendPct: recommendTotal ? Math.round((recommendYes / recommendTotal) * 100) : 0,
          avgContent: avg(content),
          avgInstructor: avg(instr),
        },
        classesByState,
        classesByStatus,
        attByStatus,
        lunchBreakdown,
        leaderboard,
        recentFeedback,
      });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: String(e?.message || e) });
      return true;
    }
  }

  // GET /api/ai-classes/class-detail?code=XXX — roster + feedback for one class
  if (pathname === "/api/ai-classes/class-detail" && req.method === "GET") {
    try {
      const u = new URL(req.url, "http://x");
      const code = u.searchParams.get("code");
      if (!code) { jsonResp(res, 400, { error: "code required" }); return true; }

      const [att, fb] = await Promise.all([
        collect("attendance", `values[Class Code] = "${code}"`, 6),
        collect("feedback", `values[Class Code] = "${code}"`, 6),
      ]);

      const lunchCounts = {}, statusCounts = {};
      for (const a of att) {
        const l = vf(a, "Lunch Preference") || "Unspecified";
        lunchCounts[l] = (lunchCounts[l] || 0) + 1;
        const s = vf(a, "Status") || "Unknown";
        statusCounts[s] = (statusCounts[s] || 0) + 1;
      }
      const overall = fb.map(f => num(vf(f, "Overall Rating"))).filter(Boolean);

      jsonResp(res, 200, {
        roster: att.map(a => ({
          id: a.id,
          student: vf(a, "Student"),
          email: vf(a, "Student Email"),
          status: vf(a, "Status"),
          lunch: vf(a, "Lunch Preference"),
        })),
        feedback: fb.map(f => ({
          id: f.id,
          student: vf(f, "Student"),
          overall: vf(f, "Overall Rating"),
          content: vf(f, "Content Rating"),
          instructor: vf(f, "Instructor Rating"),
          recommend: vf(f, "Recommend"),
          comments: vf(f, "Comments"),
        })),
        lunchCounts,
        statusCounts,
        avgOverall: avg(overall),
        enrolled: att.length,
        feedbackCount: fb.length,
      });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: String(e?.message || e) });
      return true;
    }
  }

  // GET /api/ai-classes/options — teachers, students & classes for dropdowns
  if (pathname === "/api/ai-classes/options" && req.method === "GET") {
    try {
      const [teachers, students, classes] = await Promise.all([
        collect("teachers", null, 4),
        collect("students", null, 6),
        collect("classes", null, 8),
      ]);
      jsonResp(res, 200, {
        teachers: teachers
          .filter(t => vf(t, "Status") !== "Inactive")
          .map(t => ({ name: vf(t, "Name"), specialty: vf(t, "Specialty") })),
        students: students.map(s => ({ name: vf(s, "Name"), email: vf(s, "Email") })),
        classes: classes.map(c => ({
          id: c.id,
          code: vf(c, "Class Code"),
          title: vf(c, "Class Title"),
          city: vf(c, "City"),
          state: vf(c, "State"),
          date: vf(c, "Date"),
          status: vf(c, "Status"),
        })),
      });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: String(e?.message || e) });
      return true;
    }
  }

  return false;
}
