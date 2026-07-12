import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import Course from '../models/Course.js';
import Registration from '../models/Registration.js';
import { buildCourseIndex, matchDealToCourse } from '../utils/courseMatch.js';

/**
 * בקר קורסים — ניהול קורסים/מחזורים + תצוגת גאנט + רשימת נרשמים.
 *
 * שיוך נרשמים: העסקה (רישום) היא ליטרלי ההרשמה לקורס, ולכן כל מי שביצע עסקה
 * (גם אם שילם רק מקדמה) משובץ לקורס. מיכל/מורן נתנו לקורסים שמות חופשיים ולא
 * דייקו במחזור, ולכן השיוך נעשה במנוע best-effort (utils/courseMatch.js):
 *   FK → מחזור מפורש → רמז חודש עברי ("מאי") → קרבת תאריך עסקה לתחילת מחזור → מחזור יחיד.
 * עסקאות שאין להן מחזור קיים (בעיקר מחזורי 2024/2025 ישנים) נשארות "לא משויכות".
 */

/** Fields we need from a deal to show it in a course roster. */
const ROSTER_FIELDS =
  'student studentName paymentStatus totalAmount totalPaid outstanding dealDate rep repName schemaVersion courseRaw';

/**
 * Compute the deal→course assignment once over ALL current-enrolment deals.
 * A deal with an explicit coursesAll (עסקה משולבת) enrolls in EVERY listed course;
 * otherwise we fall back to the best-effort matcher.
 * Returns { courses, index, byCourse: Map<courseId, deals[]>, unassigned }.
 */
async function computeEnrollment() {
  const courses = await Course.find({}).lean();
  const index = buildCourseIndex(courses);
  const deals = await Registration.find({ recordType: 'registration' })
    .select(ROSTER_FIELDS + ' course coursesAll courseField cohortLabel')
    .lean();

  const byCourse = new Map();
  const push = (courseId, deal, how) => {
    if (!byCourse.has(courseId)) byCourse.set(courseId, []);
    byCourse.get(courseId).push({ ...deal, _matchHow: how });
  };
  let unassigned = 0;
  for (const d of deals) {
    // explicit multi-course link (combined deal) — enroll in each listed course
    const all = (d.coursesAll || []).map(String).filter((id) => index.byId.has(id));
    if (all.length) {
      for (const id of all) push(id, d, 'fk-multi');
      continue;
    }
    const m = matchDealToCourse(d, index);
    if (!m) {
      unassigned += 1;
      continue;
    }
    push(m.courseId, d, m.how);
  }
  return { courses, index, byCourse, unassigned };
}

/**
 * GET /api/courses
 * סינון אופציונלי: ?field, ?status, ?weekday. מיון לפי startDate עולה.
 */
export const list = asyncHandler(async (req, res) => {
  const { field, status, weekday } = req.query;
  const filter = {};
  if (field) filter.field = field;
  if (status) filter.status = status;
  if (weekday) filter.weekday = weekday;

  const [data, enrollment] = await Promise.all([
    Course.find(filter).sort({ startDate: 1 }).lean(),
    computeEnrollment(),
  ]);
  const withCounts = data.map((c) => ({
    ...c,
    enrolledCount: enrollment.byCourse.get(String(c._id))?.length || 0,
  }));
  res.json({
    success: true,
    data: withCounts,
    total: withCounts.length,
    unassignedCount: enrollment.unassigned, // עסקאות שלא שויכו למחזור קיים (בעיקר מחזורים ישנים)
  });
});

/**
 * GET /api/courses/gantt
 * מחזיר קורסים בפורמט מתאים לגאנט, כולל ספירת נרשמים לכל קורס.
 */
export const gantt = asyncHandler(async (req, res) => {
  const enrollment = await computeEnrollment();
  const courses = [...enrollment.courses].sort(
    (a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0)
  );

  const data = courses.map((c) => ({
    _id: c._id,
    name: c.name,
    field: c.field,
    startDate: c.startDate,
    endDate: c.endDate,
    sessionsCount: c.sessionsCount,
    location: c.location,
    lecturer: c.lecturer,
    weekday: c.weekday,
    status: c.status,
    registrationsCount: enrollment.byCourse.get(String(c._id))?.length || 0,
  }));

  res.json({ success: true, data, total: data.length });
});

/**
 * GET /api/courses/:id
 * מחזיר את הקורס + רשימת הנרשמים (roster) המקושרים אליו.
 */
export const get = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id).lean();
  if (!course) throw ApiError.notFound('קורס לא נמצא');

  const enrollment = await computeEnrollment();
  const roster = (enrollment.byCourse.get(String(course._id)) || []).sort(
    (a, b) => new Date(b.dealDate || 0) - new Date(a.dealDate || 0)
  );

  // Privacy: a rep may see the financial/status detail ONLY for their OWN deals.
  // For a classmate handled by another rep, expose just the name + rep (no money,
  // status, dates, or student link). Managers/super-admins see everything.
  const scoped = req.user?.role === 'rep' ? String(req.user._id) : null;
  const visibleRoster = scoped
    ? roster.map((r) =>
        String(r.rep) === scoped
          ? r
          : { _id: r._id, studentName: r.studentName, repName: r.repName, masked: true }
      )
    : roster;

  res.json({ success: true, data: { course, roster: visibleRoster } });
});

/**
 * POST /api/courses  (מנהל בלבד)
 * יצירת קורס/מחזור חדש.
 */
export const create = asyncHandler(async (req, res) => {
  const course = await Course.create(req.body);
  res.status(201).json({ success: true, data: course });
});

/**
 * PUT /api/courses/:id  (מנהל בלבד)
 * עדכון קורס קיים.
 */
export const update = asyncHandler(async (req, res) => {
  const course = await Course.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!course) throw ApiError.notFound('קורס לא נמצא');
  res.json({ success: true, data: course });
});

/**
 * DELETE /api/courses/:id  (מנהל בלבד)
 * מחיקת קורס.
 */
export const remove = asyncHandler(async (req, res) => {
  const course = await Course.findByIdAndDelete(req.params.id);
  if (!course) throw ApiError.notFound('קורס לא נמצא');
  res.json({ success: true, data: { _id: course._id } });
});
