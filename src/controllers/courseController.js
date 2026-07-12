import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import Course from '../models/Course.js';
import Registration from '../models/Registration.js';
import { buildCourseIndex, matchDealToCourse } from '../utils/courseMatch.js';
import { applySince, sinceOf } from '../utils/dataScope.js';

/**
 * בקר קורסים — ניהול קורסים/מחזורים + תצוגת גאנט + רשימת נרשמים.
 *
 * שיוך נרשמים: העסקה (רישום) היא ליטרלי ההרשמה לקורס, ולכן כל מי שביצע עסקה
 * (גם אם שילם רק מקדמה) משובץ לקורס. מיכל/מורן נתנו לקורסים שמות חופשיים ולא
 * דייקו במחזור, ולכן השיוך נעשה במנוע best-effort (utils/courseMatch.js):
 *   FK → מחזור מפורש → רמז חודש עברי ("מאי") → קרבת תאריך עסקה לתחילת מחזור → מחזור יחיד.
 * עסקאות שאין להן מחזור קיים (בעיקר מחזורי 2024/2025 ישנים) נשארות "לא משויכות".
 */


/** סכומי כסף לקורס מתוך עסקאות הרישום שלו. */
function courseMoney(dealsOfCourse) {
  let salesAmount = 0;
  let collected = 0;
  let outstanding = 0;
  for (const d of dealsOfCourse || []) {
    salesAmount += d.totalAmount || 0;
    collected += d.totalPaid || 0;
    outstanding += d.outstanding || 0;
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return { salesAmount: r2(salesAmount), collected: r2(collected), outstanding: r2(outstanding) };
}

/** מחזורים ישנים רבים נשמרו בלי תאריכים כלל — תווית המחזור ("11/25") היא רמז התאריך היחיד. */
function cohortEdge(course) {
  const m = /(\d{1,2})\s*\/\s*(\d{2,4})/.exec(course.cohortLabel || course.name || '');
  if (!m) return null;
  const month = Number(m[1]);
  const yr = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(yr < 100 ? 2000 + yr : yr, month - 1, 1));
}

/** במוד "מ-2026 בלבד": קורס ישן (שהסתיים לפני 2026 ואין לו נרשמי 2026) מוסתר. */
function courseVisibleSince(req, course, enrolledCount) {
  const since = sinceOf(req);
  if (!since) return true;
  const edge = course.endDate || course.startDate || cohortEdge(course);
  // אין תאריכים וגם אין רמז מחזור (קורס חדש שרק נוצר) — תמיד גלוי, אחרת
  // הוא היה נעלם מהרשימה מיד אחרי היצירה (עוד אין לו נרשמים).
  if (!edge) return true;
  if (new Date(edge) >= since) return true;
  return enrolledCount > 0;
}

/** Fields we need from a deal to show it in a course roster. */
const ROSTER_FIELDS =
  'student studentName paymentStatus totalAmount totalPaid outstanding dealDate rep repName schemaVersion courseRaw';

/**
 * Compute the deal→course assignment once over ALL current-enrolment deals.
 * A deal with an explicit coursesAll (עסקה משולבת) enrolls in EVERY listed course;
 * otherwise we fall back to the best-effort matcher.
 * Returns { courses, index, byCourse: Map<courseId, deals[]>, unassigned }.
 */
async function computeEnrollment(req) {
  const courses = await Course.find({}).lean();
  const index = buildCourseIndex(courses);
  const dealsFilter = { recordType: 'registration' };
  if (req) applySince(req, dealsFilter); // מוד "מ-2026 בלבד"
  const deals = await Registration.find(dealsFilter)
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
    computeEnrollment(req),
  ]);
  const withCounts = data
    .map((c) => {
      const dealsOfCourse = enrollment.byCourse.get(String(c._id)) || [];
      return { ...c, enrolledCount: dealsOfCourse.length, ...courseMoney(dealsOfCourse) };
    })
    .filter((c) => courseVisibleSince(req, c, c.enrolledCount));
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
  const enrollment = await computeEnrollment(req);
  const courses = [...enrollment.courses].sort(
    (a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0)
  );

  const data = courses
    .map((c) => {
      const dealsOfCourse = enrollment.byCourse.get(String(c._id)) || [];
      return {
        _id: c._id,
        name: c.name,
        field: c.field,
        cohortLabel: c.cohortLabel,
        startDate: c.startDate,
        endDate: c.endDate,
        sessionsCount: c.sessionsCount,
        location: c.location,
        lecturer: c.lecturer,
        weekday: c.weekday,
        status: c.status,
        registrationsCount: dealsOfCourse.length,
        ...courseMoney(dealsOfCourse),
      };
    })
    .filter((c) => courseVisibleSince(req, c, c.registrationsCount));

  res.json({ success: true, data, total: data.length });
});

/**
 * GET /api/courses/:id
 * מחזיר את הקורס + רשימת הנרשמים (roster) המקושרים אליו.
 */
export const get = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id).lean();
  if (!course) throw ApiError.notFound('קורס לא נמצא');

  const enrollment = await computeEnrollment(req);
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

  res.json({
    success: true,
    data: { course, roster: visibleRoster, money: courseMoney(roster), enrolledCount: roster.length },
  });
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
