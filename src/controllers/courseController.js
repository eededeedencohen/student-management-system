import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import Course from "../models/Course.js";
import Registration from "../models/Registration.js";
import CourseCohort from "../models/CourseCohort.js";
import { buildCourseIndex, matchDealToCourse } from "../utils/courseMatch.js";
import { sinceOf } from "../utils/dataScope.js";

/**
 * בקר קורסים - ניהול קורסים/מחזורים + תצוגת גאנט + רשימת נרשמים.
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
  return {
    salesAmount: r2(salesAmount),
    collected: r2(collected),
    outstanding: r2(outstanding),
  };
}

/** מחזורים ישנים רבים נשמרו בלי תאריכים כלל - תווית המחזור ("11/25") היא רמז התאריך היחיד. */
function cohortEdge(course) {
  const m = /(\d{1,2})\s*\/\s*(\d{2,4})/.exec(
    course.cohortLabel || course.name || "",
  );
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
  // אין תאריכים וגם אין רמז מחזור (קורס חדש שרק נוצר) - תמיד גלוי, אחרת
  // הוא היה נעלם מהרשימה מיד אחרי היצירה (עוד אין לו נרשמים).
  if (!edge) return true;
  if (new Date(edge) >= since) return true;
  return enrolledCount > 0;
}

/** Fields we need from a deal to show it in a course roster. */
const ROSTER_FIELDS =
  "student studentName paymentStatus totalAmount totalPaid outstanding dealDate rep repName schemaVersion courseRaw";

/**
 * Compute the deal→course assignment once over ALL current-enrolment deals.
 * A deal with an explicit coursesAll (עסקה משולבת) enrolls in EVERY listed course;
 * otherwise we fall back to the best-effort matcher.
 * Returns { courses, index, byCourse: Map<courseId, deals[]>, unassigned }.
 */
async function computeEnrollment(req) {
  const courses = await Course.find({}).lean();
  const index = buildCourseIndex(courses);
  // שיוך מחזור מפורש (reg.cohort, נקבע בעריכת הנתונים) הוא ההצהרה הסמכותית -
  // גובר על FK קורס ישן ועל ההתאמה לפי שם, אחרת עסקה ששויכה מחדש נשארת
  // משובצת ברשומה הישנה.
  const cohortLinks = await CourseCohort.find({ sourceCourse: { $ne: null } })
    .select("sourceCourse")
    .lean();
  const sourceByCohort = new Map(
    cohortLinks.map((c) => [String(c._id), String(c.sourceCourse)]),
  );
  // רשומות קורס שמקושרות למחזור: הספירה שלהן חייבת להיות זהה אחד-לאחד לעמודת
  // המחזורים בקטלוג, ולכן נספרים בהן קישורים מפורשים בלבד - בלי התאמה
  // היוריסטית לפי שם, שהייתה מייצרת מספר שונה בין שני העמודים.
  const linkedSources = new Set(sourceByCohort.values());
  // ההרשמה עצמה אינה תלוית-תאריך: מי שסגר עסקה ב-2025 על מחזור של 2026 הוא
  // נרשם לכל דבר. מוד "מ-2026 בלבד" ממשיך לחול על הכסף בלבד (moneyScoped).
  const deals = await Registration.find({ recordType: "registration" })
    .select(
      ROSTER_FIELDS + " course coursesAll courseField cohortLabel cohort cohortsAll",
    )
    .lean();

  const byCourse = new Map();
  const push = (courseId, deal, how) => {
    if (!byCourse.has(courseId)) byCourse.set(courseId, []);
    byCourse.get(courseId).push({ ...deal, _matchHow: how });
  };
  let unassigned = 0;
  for (const d of deals) {
    // קישורים מפורשים = איחוד: כל מחזור משויך (cohortsAll/cohort → sourceCourse)
    // וכל קורס ברשימת coursesAll (עסקה משולבת/חבילה) - העסקה נספרת בכולם.
    const explicit = new Map(); // courseId -> how
    const dealCohorts = d.cohortsAll?.length
      ? d.cohortsAll
      : d.cohort
        ? [d.cohort]
        : [];
    for (const cid of dealCohorts) {
      const src = sourceByCohort.get(String(cid));
      if (src && index.byId.has(src)) explicit.set(src, "cohort-fk");
    }
    for (const id of (d.coursesAll || []).map(String)) {
      if (index.byId.has(id) && !explicit.has(id)) explicit.set(id, "fk-multi");
    }
    if (explicit.size) {
      for (const [id, how] of explicit) push(id, d, how);
      continue;
    }
    const m = matchDealToCourse(d, index);
    if (!m || linkedSources.has(String(m.courseId))) {
      // אין התאמה, או שההתאמה היא לקורס-מחזור - שם רק שיוך מפורש נספר
      unassigned += 1;
      continue;
    }
    push(m.courseId, d, m.how);
  }
  return { courses, index, byCourse, unassigned };
}

/**
 * מוד "מ-2026 בלבד" חל על הכסף בלבד: סכומי המכירות/גבייה מחושבים רק מעסקאות
 * שמתאריך הגבול והלאה, אבל ספירת הנרשמים והרשימה עצמה נשארות מלאות - נרשם
 * הוא נרשם גם אם סגר את העסקה לפני 2026.
 */
const moneyScoped = (req, deals) => {
  const since = sinceOf(req);
  if (!since) return deals;
  return deals.filter((d) => d.dealDate && new Date(d.dealDate) >= since);
};

/**
 * שמות קנוניים לרשומות קורס המקושרות למחזור: שם הקורס בדיוק כפי שהוגדר
 * בקטלוג (טאב "קורסים") + תווית המחזור - לא האיות החופשי מהאקסל של יקיר
 * ("נל"פ פרקטישינר" וכו'). רשומת האקסל עצמה לא משתנה במסד - רק התצוגה
 * בעמודי הקורסים/גאנט; הטאב "מהאקסל שלי" בקטלוג ממשיך להציג את המקור.
 */
const canonicalBySource = async () => {
  const links = await CourseCohort.find({ sourceCourse: { $ne: null } })
    .select("sourceCourse label catalogCourse")
    .populate("catalogCourse", "name")
    .lean();
  return new Map(
    links.map((c) => [
      String(c.sourceCourse),
      {
        cohortId: String(c._id),
        catalogName: c.catalogCourse?.name || "",
        label: c.label || "",
      },
    ]),
  );
};

/** דורס שם/תחום/מחזור באובייקט תגובה לפי הקישור הקנוני (אם קיים). */
const applyCanonicalNaming = (obj, link) => {
  if (!link || !link.catalogName) return obj;
  obj.name = link.label
    ? `${link.catalogName} ${link.label}`
    : link.catalogName;
  obj.field = link.catalogName;
  obj.cohortLabel = link.label;
  return obj;
};

/**
 * GET /api/courses
 * סינון אופציונלי: ?field, ?status, ?weekday. מיון לפי startDate עולה.
 */
/**
 * תיחום כספי לנציגה: סכומי הקורס (מכירות/נגבה/יתרה) מחושבים עבורה רק מהעסקאות
 * שלה - היא לא מקבלת אגרגטים של כלל החברה (מהם אפשר לגזור מכירות של קולגות).
 * מנהלים מקבלים את הסכום המלא. מוחל על list / gantt / get.
 */
const repMoneyDeals = (req, dealsOfCourse) =>
  req.user?.role === "rep"
    ? dealsOfCourse.filter((d) => String(d.rep) === String(req.user._id))
    : dealsOfCourse;

export const list = asyncHandler(async (req, res) => {
  const { field, status, weekday } = req.query;
  const filter = {};
  if (field) filter.field = field;
  if (status) filter.status = status;
  if (weekday) filter.weekday = weekday;

  const [data, enrollment, canonical] = await Promise.all([
    Course.find(filter).sort({ startDate: 1 }).lean(),
    computeEnrollment(req),
    // קישור למחזור: מזהה (עריכה בטופס המחזור) + השם הקנוני מהקטלוג לתצוגה
    canonicalBySource(),
  ]);
  const withCounts = data
    .map((c) => {
      const link = canonical.get(String(c._id));
      const dealsOfCourse = enrollment.byCourse.get(String(c._id)) || [];
      return applyCanonicalNaming(
        {
          ...c,
          cohortId: link ? link.cohortId : null,
          // הספירה מלאה (כל תאריכי העסקאות) - זהה לעמודת המחזורים בקטלוג
          enrolledCount: dealsOfCourse.length,
          // הכסף כן מכבד את מוד "מ-2026 בלבד"
          ...courseMoney(moneyScoped(req, repMoneyDeals(req, dealsOfCourse))),
          // נראות במוד 2026 נקבעת לפי נרשמי 2026 - קורס ישן שנגמר נשאר מוסתר
          _sinceCount: moneyScoped(req, dealsOfCourse).length,
        },
        link,
      );
    })
    .filter((c) => courseVisibleSince(req, c, c._sinceCount))
    .map(({ _sinceCount, ...c }) => c);
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
  const [enrollment, canonical] = await Promise.all([
    computeEnrollment(req),
    // הקליינט מציג בגאנט רק קורסים שהוגדר להם מחזור - cohortId מסמן אותם,
    // והשם/תחום נדרסים לשם הקנוני מהקטלוג (איחוד איותים לצבעים ולפילטרים)
    canonicalBySource(),
  ]);
  const courses = [...enrollment.courses].sort(
    (a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0),
  );

  const data = courses
    .map((c) => {
      const link = canonical.get(String(c._id));
      const dealsOfCourse = enrollment.byCourse.get(String(c._id)) || [];
      return applyCanonicalNaming(
        {
          _id: c._id,
          cohortId: link ? link.cohortId : null,
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
          // ספירה מלאה (כל התאריכים) - זהה לקטלוג; הכסף מכבד את מוד "מ-2026"
          registrationsCount: dealsOfCourse.length,
          ...courseMoney(moneyScoped(req, repMoneyDeals(req, dealsOfCourse))),
          _sinceCount: moneyScoped(req, dealsOfCourse).length,
        },
        link,
      );
    })
    .filter((c) => courseVisibleSince(req, c, c._sinceCount))
    .map(({ _sinceCount, ...c }) => c);

  res.json({ success: true, data, total: data.length });
});

/**
 * GET /api/courses/:id
 * מחזיר את הקורס + רשימת הנרשמים (roster) המקושרים אליו.
 */
export const get = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id).lean();
  if (!course) throw ApiError.notFound("קורס לא נמצא");

  const enrollment = await computeEnrollment(req);
  const roster = (enrollment.byCourse.get(String(course._id)) || []).sort(
    (a, b) => new Date(b.dealDate || 0) - new Date(a.dealDate || 0),
  );

  // Privacy: a rep may see the financial/status detail ONLY for their OWN deals.
  // For a classmate handled by another rep, expose just the name + rep (no money,
  // status, dates, or student link). Managers/super-admins see everything.
  const scoped = req.user?.role === "rep" ? String(req.user._id) : null;
  const visibleRoster = scoped
    ? roster.map((r) =>
        String(r.rep) === scoped
          ? r
          : {
              _id: r._id,
              studentName: r.studentName,
              repName: r.repName,
              masked: true,
            },
      )
    : roster;

  // לוח המפגשים האמיתי מגיע מהמחזור המקושר (כולל דילוגים על חגים) - רשומת
  // ה-Course הישנה מחזיקה רק התחלה/סוף/כמות, וחישוב שבועי ממנה מציג תאריכים שגויים.
  const cohort = await CourseCohort.findOne({ sourceCourse: course._id })
    .select("sessions label catalogCourse")
    .populate("catalogCourse", "name")
    .lean();
  // גם כאן השם הקנוני מהקטלוג - שעמוד הקורס יתאים לרשימה
  if (cohort) {
    applyCanonicalNaming(course, {
      catalogName: cohort.catalogCourse?.name || "",
      label: cohort.label || "",
    });
  }
  const cohortSessions = (cohort?.sessions || [])
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((s) => ({
      date: s.date,
      startTime: s.startTime || "",
      endTime: s.endTime || "",
      location: s.location || "",
      note: s.note || "",
    }));

  res.json({
    success: true,
    data: {
      course,
      cohortSessions,
      roster: visibleRoster,
      // הכסף מכבד את מוד "מ-2026"; רשימת הנרשמים והספירה מלאות
      money: courseMoney(moneyScoped(req, repMoneyDeals(req, roster))),
      enrolledCount: roster.length,
    },
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
  if (!course) throw ApiError.notFound("קורס לא נמצא");
  res.json({ success: true, data: course });
});

/**
 * DELETE /api/courses/:id  (מנהל בלבד)
 * מחיקת קורס.
 */
export const remove = asyncHandler(async (req, res) => {
  // רשומה שמקושרת למחזור: מוחקים גם את המחזור (אחרת הוא נשאר יתום ומופיע
  // בעמוד המחזורים), אבל רק אם אין עסקאות משויכות אליו.
  const cohort = await CourseCohort.findOne({
    sourceCourse: req.params.id,
  }).lean();
  if (cohort) {
    const inUse = await Registration.exists({
      $or: [{ cohort: cohort._id }, { cohortsAll: cohort._id }],
    });
    if (inUse) {
      throw ApiError.badRequest(
        "לא ניתן למחוק - יש עסקאות המשויכות למחזור של הקורס",
      );
    }
    await CourseCohort.deleteOne({ _id: cohort._id });
  }
  const course = await Course.findByIdAndDelete(req.params.id);
  if (!course) throw ApiError.notFound("קורס לא נמצא");
  res.json({ success: true, data: { _id: course._id } });
});