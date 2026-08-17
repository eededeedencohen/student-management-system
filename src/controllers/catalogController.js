import mongoose from "mongoose";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import Teacher from "../models/Teacher.js";
import CatalogCourse from "../models/CatalogCourse.js";
import CourseCohort, { COHORT_STATUSES } from "../models/CourseCohort.js";
import Course from "../models/Course.js";
import Registration from "../models/Registration.js";
import SourceCourseBlock from "../models/SourceCourseBlock.js";
import { getStyledColumnByName } from "../utils/excelStyled.js";
import { buildCourseIndex, matchDealToCourse } from "../utils/courseMatch.js";
import { cohortTeachers, teacherNamesOf } from "../utils/cohortTeachers.js";

/**
 * catalogController - יקיר's admin page: define מרצים (teachers), קורסים קטלוגיים
 * (the fixed course definitions) and מחזורי קורס (cohorts with a session list).
 * Manager-only. The legacy `Course` docs imported from קורסים.xlsx are exposed as
 * "Excel entries" he maps onto a catalog course + cohort.
 */

const cleanStr = (v) => (typeof v === "string" ? v.trim() : "");
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/* ------------------------------------------------------------------ */
/* מרצים                                                               */
/* ------------------------------------------------------------------ */

export const listTeachers = asyncHandler(async (req, res) => {
  const teachers = await Teacher.find({})
    .sort({ fullName: 1 })
    .collation({ locale: "he" })
    .lean();
  res.json({
    success: true,
    data: teachers.map((t) => ({
      id: String(t._id),
      fullName: t.fullName,
      phone: t.phone,
      email: t.email,
      idNumber: t.idNumber || "",
      active: t.active !== false,
      notes: t.notes || "",
    })),
  });
});

/**
 * הטלפון הוא המפתח העסקי של מרצה, ולכן מנורמל לצורה מקומית אחידה (05X...):
 * מסירים מפרידים, וממירים +972/972 ל-0 - אחרת אותו מרצה יוכל להיווצר פעמיים.
 */
const canonicalPhone = (raw) => {
  let p = String(raw || "").replace(/[^\d+]/g, "");
  p = p.replace(/^\+?972/, "0");
  p = p.replace(/\+/g, "");
  if (p.length > 1 && !p.startsWith("0")) p = `0${p}`;
  return p;
};

const parseTeacherBody = (b) => {
  const fullName = cleanStr(b.fullName);
  const phone = canonicalPhone(b.phone);
  const email = cleanStr(b.email).toLowerCase();
  if (!fullName) throw ApiError.badRequest("שם מלא הוא שדה חובה");
  if (phone.replace(/\D/g, "").length < 9)
    throw ApiError.badRequest("מספר טלפון אינו תקין");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    throw ApiError.badRequest("כתובת המייל אינה תקינה");
  return {
    fullName,
    phone,
    email,
    idNumber: cleanStr(b.idNumber),
    notes: cleanStr(b.notes),
  };
};

export const createTeacher = asyncHandler(async (req, res) => {
  const data = parseTeacherBody(req.body || {});
  // הטלפון הוא המפתח העסקי של מרצה
  if (await Teacher.exists({ phone: data.phone })) {
    throw ApiError.badRequest("קיים כבר מרצה עם מספר הטלפון הזה");
  }
  const t = await Teacher.create(data);
  res.status(201).json({ success: true, data: { id: String(t._id) } });
});

export const updateTeacher = asyncHandler(async (req, res) => {
  const t = await Teacher.findById(req.params.id);
  if (!t) throw ApiError.notFound("המרצה לא נמצא");
  const data = parseTeacherBody({ ...t.toObject(), ...(req.body || {}) });
  const clash = await Teacher.findOne({
    phone: data.phone,
    _id: { $ne: t._id },
  }).lean();
  if (clash) throw ApiError.badRequest("קיים כבר מרצה עם מספר הטלפון הזה");
  Object.assign(t, data);
  if (req.body?.active !== undefined) t.active = Boolean(req.body.active);
  await t.save();
  res.json({ success: true, data: { id: String(t._id) } });
});

export const deleteTeacher = asyncHandler(async (req, res) => {
  // בודקים את שני השדות - teachers (הקנוני) וגם teacher הישן במסמכים שלא עודכנו
  const inUse = await CourseCohort.exists({
    $or: [{ teachers: req.params.id }, { teacher: req.params.id }],
  });
  if (inUse)
    throw ApiError.badRequest("לא ניתן למחוק - המרצה משויך למחזור קורס");
  await Teacher.deleteOne({ _id: req.params.id });
  res.json({ success: true, data: { deleted: true } });
});

/* ------------------------------------------------------------------ */
/* קורסים קטלוגיים                                                     */
/* ------------------------------------------------------------------ */

/**
 * ספירת נרשמים + כסף שנכנס, לפי ההגדרה המאוחדת של שיוך (זהה לעמוד הקורסים):
 * עסקה שייכת למחזור אם הוא ב-cohort/cohortsAll או שקורס המקור שלו ב-coursesAll.
 * בלי תלות בתאריך העסקה. הכסף = totalPaid של עסקאות הרישום המשויכות; עסקת
 * חבילה נספרת (גם כספית) בכל אחד מהמחזורים שלה, וברמת הקורס הקטלוגי כל עסקה
 * נספרת פעם אחת לקורס. repId (נציגה) מגביל את הכסף לעסקאות שלה בלבד -
 * הספירות נשארות מלאות, כמו המדיניות בעמוד הקורסים.
 */
const enrollmentStats = async ({ repId = null } = {}) => {
  const cohortDocs = await CourseCohort.find({})
    .select("sourceCourse catalogCourse")
    .lean();
  const cohortOfSource = new Map(
    cohortDocs
      .filter((c) => c.sourceCourse)
      .map((c) => [String(c.sourceCourse), String(c._id)]),
  );
  const courseOfCohort = new Map(
    cohortDocs.map((c) => [
      String(c._id),
      c.catalogCourse ? String(c.catalogCourse) : null,
    ]),
  );
  const deals = await Registration.find({ recordType: "registration" })
    .select("cohort cohortsAll coursesAll totalPaid rep")
    .lean();
  const byCohort = new Map(); // cohortId -> { count, collected }
  const byCourse = new Map(); // catalogCourseId -> { count, collected }
  const bump = (map, key, paid) => {
    const cur = map.get(key) || { count: 0, collected: 0 };
    cur.count += 1;
    cur.collected += paid;
    map.set(key, cur);
  };
  for (const d of deals) {
    const set = new Set();
    const dealCohorts = d.cohortsAll?.length
      ? d.cohortsAll
      : d.cohort
        ? [d.cohort]
        : [];
    for (const c of dealCohorts) set.add(String(c));
    for (const courseId of d.coursesAll || []) {
      const via = cohortOfSource.get(String(courseId));
      if (via) set.add(via);
    }
    const paid = repId && String(d.rep) !== repId ? 0 : d.totalPaid || 0;
    for (const k of set) bump(byCohort, k, paid);
    const courseSet = new Set(
      [...set].map((k) => courseOfCohort.get(k)).filter(Boolean),
    );
    for (const k of courseSet) bump(byCourse, k, paid);
  }
  const round = (map) => {
    for (const v of map.values()) v.collected = Math.round(v.collected * 100) / 100;
  };
  round(byCohort);
  round(byCourse);
  return { byCohort, byCourse };
};

const catalogCourseJson = (c, cohortsCount, stats) => ({
  id: String(c._id),
  name: c.name,
  price: c.price || 0,
  defaultSessionCount: c.defaultSessionCount || 0,
  notes: c.notes || "",
  active: c.active !== false,
  cohortsCount,
  enrolledCount: stats?.count || 0,
  moneyCollected: stats?.collected || 0,
});

export const listCatalogCourses = asyncHandler(async (req, res) => {
  const courses = await CatalogCourse.find({})
    .sort({ name: 1 })
    .collation({ locale: "he" })
    .lean();
  const counts = await CourseCohort.aggregate([
    { $group: { _id: "$catalogCourse", n: { $sum: 1 } } },
  ]);
  const byCourse = new Map(counts.map((c) => [String(c._id), c.n]));
  const stats = await enrollmentStats();
  res.json({
    success: true,
    data: courses.map((c) =>
      catalogCourseJson(
        c,
        byCourse.get(String(c._id)) || 0,
        stats.byCourse.get(String(c._id)),
      ),
    ),
  });
});

/** מספר לא-שלילי מקלט טופס. ריק/רווח/null אינם 0 - הם קלט חסר (אחרת שמירה מוחקת מחיר). */
const numField = (v, label) => {
  if (v === undefined || v === null || String(v).trim() === "") {
    throw ApiError.badRequest(`${label} הוא שדה חובה`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0)
    throw ApiError.badRequest(`${label} אינו תקין`);
  return n;
};

const parseCourseBody = (b) => {
  const name = cleanStr(b.name);
  if (!name) throw ApiError.badRequest("שם הקורס הוא שדה חובה");
  return {
    name,
    price: numField(b.price, "מחיר הקורס"),
    defaultSessionCount: numField(b.defaultSessionCount, "כמות המפגשים"),
    notes: cleanStr(b.notes),
  };
};

export const createCatalogCourse = asyncHandler(async (req, res) => {
  const data = parseCourseBody(req.body || {});
  if (await CatalogCourse.exists({ name: data.name })) {
    throw ApiError.badRequest("קיים כבר קורס בשם הזה");
  }
  const c = await CatalogCourse.create(data);
  res.status(201).json({ success: true, data: { id: String(c._id) } });
});

export const updateCatalogCourse = asyncHandler(async (req, res) => {
  const c = await CatalogCourse.findById(req.params.id);
  if (!c) throw ApiError.notFound("הקורס לא נמצא");
  const data = parseCourseBody({ ...c.toObject(), ...(req.body || {}) });
  const clash = await CatalogCourse.findOne({
    name: data.name,
    _id: { $ne: c._id },
  }).lean();
  if (clash) throw ApiError.badRequest("קיים כבר קורס בשם הזה");
  Object.assign(c, data);
  if (req.body?.active !== undefined) c.active = Boolean(req.body.active);
  await c.save();
  res.json({ success: true, data: { id: String(c._id) } });
});

export const deleteCatalogCourse = asyncHandler(async (req, res) => {
  const inUse = await CourseCohort.exists({ catalogCourse: req.params.id });
  if (inUse) throw ApiError.badRequest("לא ניתן למחוק - לקורס יש מחזורים");
  await CatalogCourse.deleteOne({ _id: req.params.id });
  res.json({ success: true, data: { deleted: true } });
});

/* ------------------------------------------------------------------ */
/* מחזורי קורס                                                         */
/* ------------------------------------------------------------------ */

const cohortJson = (c, enrolled = 0, collected = 0) => ({
  id: String(c._id),
  catalogCourse: c.catalogCourse
    ? String(c.catalogCourse._id || c.catalogCourse)
    : null,
  courseName: c.catalogCourse?.name || "",
  coursePrice: c.catalogCourse?.price || 0,
  defaultSessionCount: c.catalogCourse?.defaultSessionCount || 0,
  label: c.label || "",
  // teachers = הרשימה הקנונית; teacher/teacherName נשארים לתאימות עם קוראים ותיקים.
  teachers: cohortTeachers(c).map((t) => String(t._id || t)),
  teacherNames: cohortTeachers(c)
    .map((t) => t?.fullName || "")
    .filter(Boolean),
  teacher: cohortTeachers(c)[0]
    ? String(cohortTeachers(c)[0]._id || cohortTeachers(c)[0])
    : null,
  teacherName: teacherNamesOf(c), // "עמר לוין + אביטל דניאל"
  defaultLocation: c.defaultLocation || "",
  deliveryMode: c.deliveryMode || "",
  status: c.status,
  registrationOpen: Boolean(c.registrationOpen),
  notes: c.notes || "",
  sourceCourse: c.sourceCourse ? String(c.sourceCourse) : null,
  enrolledCount: enrolled,
  moneyCollected: collected,
  sessions: (c.sessions || [])
    .map((s) => ({
      id: String(s._id),
      date: s.date,
      startTime: s.startTime || "",
      endTime: s.endTime || "",
      location: s.location || "",
      note: s.note || "",
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date)),
});

export const listCohorts = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.catalogCourse) filter.catalogCourse = req.query.catalogCourse;
  const cohorts = await CourseCohort.find(filter)
    .populate("catalogCourse", "name price defaultSessionCount")
    .populate("teachers", "fullName")
    .populate("teacher", "fullName")
    .sort({ createdAt: -1 })
    .lean();
  // ספירת נרשמים אחידה - אותה הגדרה בדיוק כמו עמוד הקורסים (enrollmentStats)
  const { byCohort } = await enrollmentStats();
  res.json({
    success: true,
    data: cohorts.map((c) => {
      const s = byCohort.get(String(c._id));
      return cohortJson(c, s?.count || 0, s?.collected || 0);
    }),
  });
});

/**
 * GET /api/courses/overview - הנתונים לעמוד "קורסים" (כל משתמש מחובר):
 * אותם מרצים/קורסים/מחזורים כמו בקטלוג, בלי רשומות האקסל. לנציגה הכסף לא
 * נשלח בכלל (2026-08-17, החלטת עדן: מורן לא רואה את עמודת "נכנס מהקורס")
 * ות.ז. של מרצים מוסתרת; הספירות מלאות לכולם.
 */
export const coursesOverview = asyncHandler(async (req, res) => {
  const isRep = req.user?.role === "rep";
  const repId = isRep ? String(req.user._id) : null;
  const stats = await enrollmentStats({ repId });

  const teachers = await Teacher.find({})
    .sort({ fullName: 1 })
    .collation({ locale: "he" })
    .lean();
  const catCourses = await CatalogCourse.find({})
    .sort({ name: 1 })
    .collation({ locale: "he" })
    .lean();
  const cohorts = await CourseCohort.find({})
    .populate("catalogCourse", "name price defaultSessionCount")
    .populate("teachers", "fullName")
    .populate("teacher", "fullName")
    .sort({ createdAt: -1 })
    .lean();
  const cohortsPerCourse = new Map();
  for (const c of cohorts) {
    const k = c.catalogCourse ? String(c.catalogCourse._id) : null;
    if (k) cohortsPerCourse.set(k, (cohortsPerCourse.get(k) || 0) + 1);
  }

  res.json({
    success: true,
    data: {
      teachers: teachers.map((t) => ({
        id: String(t._id),
        fullName: t.fullName,
        phone: t.phone,
        email: t.email,
        idNumber: isRep ? "" : t.idNumber || "",
        active: t.active !== false,
        notes: t.notes || "",
      })),
      courses: catCourses.map((c) => {
        const row = catalogCourseJson(
          c,
          cohortsPerCourse.get(String(c._id)) || 0,
          stats.byCourse.get(String(c._id)),
        );
        if (isRep) delete row.moneyCollected;
        return row;
      }),
      cohorts: cohorts.map((c) => {
        const s = stats.byCohort.get(String(c._id));
        const row = cohortJson(c, s?.count || 0, s?.collected || 0);
        if (isRep) delete row.moneyCollected;
        return row;
      }),
    },
  });
});

/** Validate + normalise the session list (dedup by date+start, cap the count). */
const parseSessions = (raw) => {
  if (!Array.isArray(raw)) return null;
  if (raw.length > 200) throw ApiError.badRequest("יותר מדי מפגשים (עד 200)");
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    // תאריך "YYYY-MM-DD" נשמר כחצות UTC כדי שהמפגש לא יזוז ביום בגלל אזור זמן
    const rawDate = String(s?.date || "");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? new Date(`${rawDate}T00:00:00.000Z`)
      : new Date(rawDate);
    if (Number.isNaN(date.getTime()))
      throw ApiError.badRequest("תאריך מפגש אינו תקין");
    const startTime = cleanStr(s?.startTime);
    const endTime = cleanStr(s?.endTime);
    if (startTime && !HHMM.test(startTime))
      throw ApiError.badRequest(`שעת התחלה אינה תקינה: ${startTime}`);
    if (endTime && !HHMM.test(endTime))
      throw ApiError.badRequest(`שעת סיום אינה תקינה: ${endTime}`);
    const key = `${date.toISOString().slice(0, 10)}|${startTime}`;
    if (seen.has(key)) continue; // אותו יום+שעה פעמיים = כפילות
    seen.add(key);
    out.push({
      date,
      startTime,
      endTime,
      location: cleanStr(s?.location),
      note: cleanStr(s?.note),
    });
  }
  return out.sort((a, b) => a.date - b.date);
};

const parseCohortBody = async (b, existing) => {
  const out = {};
  const courseId =
    cleanStr(b.catalogCourse) || (existing && String(existing.catalogCourse));
  if (!courseId) throw ApiError.badRequest("יש לבחור קורס");
  const course = await CatalogCourse.findById(courseId).lean();
  if (!course) throw ApiError.badRequest("הקורס לא נמצא");
  out.catalogCourse = course._id;

  // ריבוי מרצים: מקבלים מערך `teachers`, ועדיין תומכים ב-`teacher` בודד מקוראים ותיקים.
  if (b.teachers !== undefined || b.teacher !== undefined) {
    const raw = Array.isArray(b.teachers) ? b.teachers : [b.teacher];
    const ids = [...new Set(raw.map((v) => cleanStr(v)).filter(Boolean))];
    if (ids.length > 10)
      throw ApiError.badRequest("יותר מדי מרצים למחזור (עד 10)");
    // מזהה שאינו ObjectId תקין היה זורק CastError (500) במקום שגיאת קלט ברורה
    if (ids.some((id) => !mongoose.isValidObjectId(id))) {
      throw ApiError.badRequest("מזהה מרצה אינו תקין");
    }
    if (ids.length) {
      const found = await Teacher.find({ _id: { $in: ids } })
        .select("_id")
        .lean();
      if (found.length !== ids.length)
        throw ApiError.badRequest("אחד המרצים שנבחרו לא נמצא");
      // שומרים על סדר הבחירה של המשתמש, לא על סדר ההחזרה מהמונגו
      const ok = new Set(found.map((t) => String(t._id)));
      out.teachers = ids.filter((id) => ok.has(id));
    } else out.teachers = [];
    out.teacher = out.teachers[0] || null;
  }
  if (b.label !== undefined) out.label = cleanStr(b.label);
  if (b.defaultLocation !== undefined)
    out.defaultLocation = cleanStr(b.defaultLocation);
  // אופן קיום: זום / פרונטלי / לפי בחירה (hybrid); ריק = לא הוגדר
  if (b.deliveryMode !== undefined) {
    const dm = cleanStr(b.deliveryMode);
    if (dm && !["zoom", "frontal", "hybrid"].includes(dm)) {
      throw ApiError.badRequest("אופן קיום המחזור אינו תקין");
    }
    out.deliveryMode = dm || null;
  }
  if (b.notes !== undefined) out.notes = cleanStr(b.notes);
  if (b.status !== undefined) {
    if (!COHORT_STATUSES.includes(b.status))
      throw ApiError.badRequest("סטטוס מחזור אינו תקין");
    out.status = b.status;
  }
  if (b.registrationOpen !== undefined)
    out.registrationOpen = Boolean(b.registrationOpen);
  const sessions = parseSessions(b.sessions);
  if (sessions) out.sessions = sessions;

  // מחזור שנגמר/בוטל לא יכול להיות בהרשמה פתוחה (נאכף גם במודל)
  const status = out.status || existing?.status;
  if ((status === "ended" || status === "cancelled") && out.registrationOpen) {
    throw ApiError.badRequest("מחזור שנגמר או בוטל לא יכול להיות בהרשמה פתוחה");
  }
  return out;
};

/**
 * העמוד הראשי "קורסים", הגאנט, התאמת העסקאות והמכירות - כולם רצים על רשומות
 * ה-Course הישנות. לכן מחזור שנוצר בטופס החדש (ולא מרשומת אקסל קיימת) מקבל
 * רשומת Course תואמת ("mirror") שמזוהה ב-sourceFile הזה, וכל עריכת מחזור
 * מסנכרנת אותה - כך העמוד הראשי תמיד משקף את המחזורים.
 */
export const COHORT_MIRROR_SOURCE = "מחזור (מערכת)";

const LEGACY_STATUS = {
  active: "פעיל",
  future: "עתידי",
  ended: "הסתיים",
  cancelled: "בוטל",
};
const WEEKDAY_LETTERS = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];

/** שדות ה-Course הישן הנגזרים ממחזור. שם/מחיר נדרסים רק ב-mirror - לא ברשומת אקסל. */
const legacyFieldsFromCohort = async (cohort, catalog, { includeNaming }) => {
  const out = {};
  if (includeNaming) {
    out.name = `${catalog.name}${cohort.label ? ` ${cohort.label}` : ""}`;
    out.field = catalog.name;
    out.cohortLabel = cohort.label || "";
    out.price = catalog.price || 0;
  }
  const sessions = [...(cohort.sessions || [])].sort(
    (a, b) => new Date(a.date) - new Date(b.date),
  );
  if (sessions.length) {
    out.startDate = sessions[0].date;
    out.endDate = sessions[sessions.length - 1].date;
    out.sessionsCount = sessions.length;
    // המפגשים נשמרים כחצות UTC, ולכן היום-בשבוע נקרא ב-UTC
    out.weekday = WEEKDAY_LETTERS[new Date(sessions[0].date).getUTCDay()] || "";
  }
  if (cohort.defaultLocation) out.location = cohort.defaultLocation;
  const teacherIds = (cohort.teachers || []).map(String);
  if (teacherIds.length) {
    const docs = await Teacher.find({ _id: { $in: teacherIds } })
      .select("fullName")
      .lean();
    const nameOf = new Map(docs.map((t) => [String(t._id), t.fullName]));
    out.lecturer = teacherIds
      .map((id) => nameOf.get(id))
      .filter(Boolean)
      .join(" + ");
  }
  out.status =
    cohort.registrationOpen &&
    (cohort.status === "active" || cohort.status === "future")
      ? "פתוח להרשמה"
      : LEGACY_STATUS[cohort.status] || "פעיל";
  return out;
};

/** מסנכרן את רשומת ה-Course המקושרת (mirror או רשומת אקסל שמופה למחזור). */
const syncLegacyCourse = async (cohort) => {
  if (!cohort?.sourceCourse) return;
  const [legacy, catalog] = await Promise.all([
    Course.findById(cohort.sourceCourse),
    CatalogCourse.findById(cohort.catalogCourse).lean(),
  ]);
  if (!legacy || !catalog) return;
  const isMirror = legacy.sourceFile === COHORT_MIRROR_SOURCE;
  Object.assign(
    legacy,
    await legacyFieldsFromCohort(cohort, catalog, { includeNaming: isMirror }),
  );
  await legacy.save();
};

export const createCohort = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const data = await parseCohortBody(b, null);
  const srcId = cleanStr(b.sourceCourse);
  if (srcId) {
    const src = await Course.findById(srcId).lean();
    if (!src) throw ApiError.badRequest("רשומת האקסל לא נמצאה");
    if (await CourseCohort.exists({ sourceCourse: src._id })) {
      throw ApiError.badRequest("לרשומת האקסל הזו כבר הוגדר מחזור");
    }
    data.sourceCourse = src._id;
  } else {
    // מחזור חדש שלא הוגדר מרשומת אקסל - יוצרים לו רשומת Course בעמוד הראשי
    const catalog = await CatalogCourse.findById(data.catalogCourse).lean();
    const fields = await legacyFieldsFromCohort(data, catalog, {
      includeNaming: true,
    });
    const mirror = await Course.create({
      ...fields,
      sourceFile: COHORT_MIRROR_SOURCE,
      notes: data.notes || "",
    });
    data.sourceCourse = mirror._id;
  }
  const c = await CourseCohort.create(data);
  await syncLegacyCourse(c);
  res.status(201).json({ success: true, data: { id: String(c._id) } });
});

export const updateCohort = asyncHandler(async (req, res) => {
  const c = await CourseCohort.findById(req.params.id);
  if (!c) throw ApiError.notFound("המחזור לא נמצא");
  const data = await parseCohortBody(req.body || {}, c);
  Object.assign(c, data);
  await c.save();
  await syncLegacyCourse(c);
  const populated = await CourseCohort.findById(c._id)
    .populate("catalogCourse", "name price defaultSessionCount")
    .populate("teachers", "fullName")
    .populate("teacher", "fullName")
    .lean();
  res.json({ success: true, data: cohortJson(populated) });
});

export const deleteCohort = asyncHandler(async (req, res) => {
  const inUse = await Registration.exists({
    $or: [{ cohort: req.params.id }, { cohortsAll: req.params.id }],
  });
  if (inUse)
    throw ApiError.badRequest("לא ניתן למחוק - יש עסקאות המשויכות למחזור");
  const c = await CourseCohort.findById(req.params.id).lean();
  await CourseCohort.deleteOne({ _id: req.params.id });
  // רשומת mirror קיימת רק בזכות המחזור - נמחקת איתו. רשומת אקסל מקורית נשארת.
  if (c?.sourceCourse) {
    await Course.deleteOne({
      _id: c.sourceCourse,
      sourceFile: COHORT_MIRROR_SOURCE,
    });
  }
  res.json({ success: true, data: { deleted: true } });
});

/* ------------------------------------------------------------------ */
/* רשומות האקסל של יקיר (Course docs) - למיפוי לקורס + מחזור            */
/* ------------------------------------------------------------------ */

/**
 * GET /api/catalog/source-courses
 * The legacy Course rows (from קורסים.xlsx / the JSON dataset) with whether a cohort
 * has already been defined for each - יקיר's worklist.
 */
/**
 * רשומות המקור שעסקה שייכת אליהן, לפי שרשרת עדיפות אחידה:
 * שיוך מחזור מפורש (reg.cohort - נקבע ידנית בעריכת הנתונים, הכי סמכותי) →
 * FK קורס (reg.course + coursesAll) → ההתאמה ההיוריסטית לפי שם.
 * בלי עדיפות המחזור, עסקה ששויכה מחדש למחזור אחר המשיכה להיספר ברשומה הישנה.
 */
const dealSourceIds = (d, index, sourceByCohort) => {
  const extras = (d.coursesAll || []).map(String);
  // עסקת חבילה: כל המחזורים (cohortsAll); אחרת המחזור היחיד (cohort)
  const dealCohorts = d.cohortsAll?.length
    ? d.cohortsAll
    : d.cohort
      ? [d.cohort]
      : [];
  const viaCohorts = dealCohorts
    .map((c) => sourceByCohort.get(String(c)))
    .filter(Boolean);
  if (viaCohorts.length) return [...new Set([...viaCohorts, ...extras])];
  if (d.course) return [...new Set([String(d.course), ...extras])];
  const m = matchDealToCourse(d, index); // { courseId, how } | null
  return m?.courseId ? [String(m.courseId)] : [];
};

export const listSourceCourses = asyncHandler(async (req, res) => {
  const courses = await Course.find({}).sort({ startDate: -1, name: 1 }).lean();
  const allCohorts = await CourseCohort.find({})
    .select("sourceCourse catalogCourse label")
    .populate("catalogCourse", "name")
    .lean();
  const cohorts = allCohorts.filter((c) => c.sourceCourse);
  // "משויך" = reg.cohort מצביע על מחזור שקיים בקטלוג - אותה הגדרה בדיוק כמו
  // הפילטר "שיוך מחזור" בעמוד עריכת הנתונים, כדי ששני העמודים יראו אותם מספרים.
  const validCohortIds = new Set(allCohorts.map((c) => String(c._id)));
  const bySource = new Map(cohorts.map((c) => [String(c.sourceCourse), c]));
  const sourceByCohort = new Map(
    cohorts.map((c) => [String(c._id), String(c.sourceCourse)]),
  );
  // ספירת העסקאות לפי אותה התאמה היוריסטית שכל האפליקציה משתמשת בה (לא רק לפי ה-FK),
  // אחרת רשומות עם עסקאות יוצגו כ-0.
  const deals = await Registration.find({ recordType: "registration" })
    .select(
      "course courseRaw courseField cohortLabel dealDate coursesAll cohort cohortsAll",
    )
    .lean();
  const index = buildCourseIndex(courses);
  const dealsByCourse = new Map();
  const assignedByCourse = new Map();
  const bump = (map, id) =>
    id && map.set(String(id), (map.get(String(id)) || 0) + 1);
  let totalAssigned = 0;
  for (const d of deals) {
    // עסקת חבילה נחשבת "משויכת" אם אחד ממחזוריה קיים בקטלוג
    const dealCohorts = d.cohortsAll?.length
      ? d.cohortsAll
      : d.cohort
        ? [d.cohort]
        : [];
    const assigned = dealCohorts.some((c) => validCohortIds.has(String(c)));
    if (assigned) totalAssigned += 1;
    for (const id of dealSourceIds(d, index, sourceByCohort)) {
      bump(dealsByCourse, id);
      if (assigned) bump(assignedByCourse, id);
    }
  }

  res.json({
    success: true,
    data: courses.map((c) => {
      const hit = bySource.get(String(c._id));
      return {
        id: String(c._id),
        name: c.name,
        field: c.field || "",
        cohortLabel: c.cohortLabel || "",
        startDate: c.startDate || null,
        endDate: c.endDate || null,
        sessionsCount: c.sessionsCount || null,
        location: c.location || "",
        lecturer: c.lecturer || "",
        weekday: c.weekday || "",
        status: c.status || "",
        price: c.price ?? null,
        sourceFile: c.sourceFile || "",
        dealsCount: dealsByCourse.get(String(c._id)) || 0,
        assignedCount: assignedByCourse.get(String(c._id)) || 0,
        mapped: Boolean(hit),
        mappedTo: hit
          ? {
              cohortId: String(hit._id),
              courseName: hit.catalogCourse?.name || "",
              label: hit.label || "",
            }
          : null,
      };
    }),
    // סיכום גלובלי - אותם מספרים כמו הפילטר "שיוך מחזור" בעמוד עריכת הנתונים
    totals: {
      deals: deals.length,
      assigned: totalAssigned,
      unassigned: deals.length - totalAssigned,
    },
  });
});

/**
 * GET /api/catalog/source-courses/:id/deals
 * העסקאות של רשומת מקור אחת - לפי אותה התאמה בדיוק כמו ספירת dealsCount
 * (FK ישיר course/coursesAll, או ההתאמה ההיוריסטית לרשומות בלי FK). משמש את
 * מודל "עסקאות" בעמוד הקטלוג; לחיצה על עסקה מנווטת אליה בעמוד עריכת הנתונים.
 */
export const listSourceCourseDeals = asyncHandler(async (req, res) => {
  const target = String(req.params.id);
  const exists = await Course.exists({ _id: target });
  if (!exists) throw ApiError.notFound("רשומת הקורס לא נמצאה");

  const courses = await Course.find({}).lean();
  const allCohorts = await CourseCohort.find({})
    .select("sourceCourse catalogCourse label")
    .populate("catalogCourse", "name")
    .lean();
  const sourceByCohort = new Map(
    allCohorts
      .filter((c) => c.sourceCourse)
      .map((c) => [String(c._id), String(c.sourceCourse)]),
  );
  // שם קריא למחזור המשויך - לצ'יפ "משויך" במודל העסקאות
  const cohortNameById = new Map(
    allCohorts.map((c) => [
      String(c._id),
      `${c.catalogCourse?.name || ""}${c.label ? ` ${c.label}` : ""}`.trim(),
    ]),
  );
  const deals = await Registration.find({ recordType: "registration" })
    .select(
      "course coursesAll courseRaw courseField cohortLabel dealDate studentName repName totalAmount review.status cohort cohortsAll",
    )
    .lean();
  const index = buildCourseIndex(courses);

  const out = [];
  for (const d of deals) {
    const ids = dealSourceIds(d, index, sourceByCohort);
    if (!ids.includes(target)) continue;
    // עסקת חבילה: מציגים את כל המחזורים המשויכים (מופרדים ב-+)
    const dealCohorts = (
      d.cohortsAll?.length ? d.cohortsAll : d.cohort ? [d.cohort] : []
    )
      .map(String)
      .filter((c) => cohortNameById.has(c));
    out.push({
      id: String(d._id),
      studentName: d.studentName || "",
      repName: d.repName || "",
      dealDate: d.dealDate || null,
      totalAmount: d.totalAmount || 0,
      reviewed: d.review?.status === "done",
      cohortAssigned: dealCohorts.length > 0,
      cohortName: dealCohorts.map((c) => cohortNameById.get(c)).join(" + "),
    });
  }
  out.sort((a, b) => new Date(b.dealDate || 0) - new Date(a.dealDate || 0));
  res.json({ success: true, data: out });
});

/**
 * POST /api/catalog/source-courses/:id/assign-cohort  { cohort }
 * שיוך גורף: כל העסקאות של רשומת המקור (לפי אותה התאמה כמו הספירה, כולל
 * מבוטלות) מקבלות שיוך מחזור מפורש - שגובר על ההתאמה לפי שם, ולכן הן עוברות
 * להיספר ברשומת המקור של המחזור הנבחר.
 */
export const assignAllSourceCourseDeals = asyncHandler(async (req, res) => {
  const target = String(req.params.id);
  const course = await Course.findById(target).lean();
  if (!course) throw ApiError.notFound("רשומת הקורס לא נמצאה");
  const cohortId = cleanStr(req.body?.cohort);
  if (!cohortId) throw ApiError.badRequest("יש לבחור מחזור קורס");
  const cohort = await CourseCohort.findById(cohortId)
    .populate("catalogCourse", "name")
    .lean();
  if (!cohort) throw ApiError.badRequest("מחזור הקורס לא נמצא");

  const courses = await Course.find({}).lean();
  const index = buildCourseIndex(courses);
  const cohorts = await CourseCohort.find({ sourceCourse: { $ne: null } })
    .select("sourceCourse")
    .lean();
  const sourceByCohort = new Map(
    cohorts.map((c) => [String(c._id), String(c.sourceCourse)]),
  );
  const deals = await Registration.find({
    recordType: { $in: ["registration", "cancelled", "collection_followup"] },
  })
    .select(
      "course coursesAll courseRaw courseField cohortLabel dealDate cohort cohortsAll",
    )
    .lean();
  const toAssign = deals.filter(
    (d) =>
      dealSourceIds(d, index, sourceByCohort).includes(target) &&
      String(d.cohort || "") !== String(cohort._id),
  );

  const noteText =
    `שויך למחזור: ${cohort.catalogCourse?.name || ""} ${cohort.label || ""} (שיוך גורף מרשומת "${course.name}")`.trim();
  for (const d of toAssign) {
    const set = { cohort: cohort._id };
    // עסקת חבילה: המחזור הראשי הוחלף - מעדכנים גם את רשימת המחזורים
    if (Array.isArray(d.cohortsAll) && d.cohortsAll.length) {
      const prev = String(d.cohort || "");
      set.cohortsAll = [
        ...new Set(
          d.cohortsAll
            .map(String)
            .map((c) => (c === prev ? String(cohort._id) : c)),
        ),
      ];
    }
    await Registration.updateOne(
      { _id: d._id },
      {
        $set: set,
        $push: {
          noteEntries: {
            text: noteText,
            date: new Date(),
            byName: req.user?.name || "",
          },
        },
      },
    );
  }
  res.json({ success: true, data: { assigned: toAssign.length } });
});

/**
 * POST /api/catalog/source-courses/merge  { from, into, cohort? }
 * איחוד רשומות אקסל כפולות: כל העסקאות של רשומת from (לפי אותה התאמה כמו
 * הספירה, כולל עסקאות מבוטלות) מקבלות FK מפורש לרשומת into - ואם נשלח cohort
 * גם שיוך מחזור; רשומת from נמחקת יחד עם המחזור שהוגדר ממנה (אם היה).
 */
export const mergeSourceCourses = asyncHandler(async (req, res) => {
  const fromId = cleanStr(req.body?.from);
  const intoId = cleanStr(req.body?.into);
  if (!fromId || !intoId)
    throw ApiError.badRequest("יש לבחור שתי רשומות לאיחוד");
  if (fromId === intoId)
    throw ApiError.badRequest("אי אפשר לאחד רשומה עם עצמה");
  const [fromCourse, intoCourse] = await Promise.all([
    Course.findById(fromId).lean(),
    Course.findById(intoId).lean(),
  ]);
  if (!fromCourse || !intoCourse)
    throw ApiError.notFound("רשומת הקורס לא נמצאה");

  const cohortId = cleanStr(req.body?.cohort);
  const targetCohort = cohortId
    ? await CourseCohort.findById(cohortId).lean()
    : null;
  if (cohortId && !targetCohort)
    throw ApiError.badRequest("מחזור הקורס לא נמצא");

  const fromCohort = await CourseCohort.findOne({
    sourceCourse: fromCourse._id,
  }).lean();

  // איסוף העסקאות של from - אותה שרשרת התאמה כמו הרשימה/הספירה. כולל גם
  // רשומות מבוטלות/מעקב גבייה, אחרת הן נשארות מצביעות על רשומה שנמחקה.
  const courses = await Course.find({}).lean();
  const index = buildCourseIndex(courses);
  const cohorts = await CourseCohort.find({ sourceCourse: { $ne: null } })
    .select("sourceCourse")
    .lean();
  const sourceByCohort = new Map(
    cohorts.map((c) => [String(c._id), String(c.sourceCourse)]),
  );
  const deals = await Registration.find({
    recordType: { $in: ["registration", "cancelled", "collection_followup"] },
  })
    .select(
      "course coursesAll courseRaw courseField cohortLabel dealDate cohort cohortsAll",
    )
    .lean();
  const fromKey = String(fromCourse._id);
  const intoKey = String(intoCourse._id);
  const moved = deals.filter((d) =>
    dealSourceIds(d, index, sourceByCohort).includes(fromKey),
  );

  const noteText =
    `אוחד מרשומת הקורס "${fromCourse.name}" לרשומה "${intoCourse.name}"`.trim();
  for (const d of moved) {
    const set = { course: intoCourse._id };
    if (Array.isArray(d.coursesAll) && d.coursesAll.length) {
      set.coursesAll = [
        ...new Set(
          d.coursesAll.map(String).map((id) => (id === fromKey ? intoKey : id)),
        ),
      ];
    }
    if (targetCohort) set.cohort = targetCohort._id;
    else if (fromCohort && String(d.cohort) === String(fromCohort._id)) {
      set.cohort = null; // המחזור של from נמחק - לא משאירים שיוך יתום
    }
    // עסקת חבילה: מעדכנים גם את רשימת המחזורים - המחזור של from מוחלף
    // ביעד (אם נבחר) או יוצא מהרשימה (המחזור נמחק יחד עם from)
    if (
      fromCohort &&
      Array.isArray(d.cohortsAll) &&
      d.cohortsAll.map(String).includes(String(fromCohort._id))
    ) {
      const replaced = d.cohortsAll
        .map(String)
        .map((c) =>
          c === String(fromCohort._id)
            ? targetCohort
              ? String(targetCohort._id)
              : null
            : c,
        )
        .filter(Boolean);
      set.cohortsAll = [...new Set(replaced)];
    }
    await Registration.updateOne(
      { _id: d._id },
      {
        $set: set,
        $push: {
          noteEntries: {
            text: noteText,
            date: new Date(),
            byName: req.user?.name || "",
          },
        },
      },
    );
  }

  if (fromCohort) {
    const stillLinked = await Registration.exists({
      $or: [{ cohort: fromCohort._id }, { cohortsAll: fromCohort._id }],
    });
    if (stillLinked) {
      throw ApiError.badRequest(
        "נשארו עסקאות משויכות למחזור של הרשומה שנמחקת - יש לשייך אותן קודם",
      );
    }
    await CourseCohort.deleteOne({ _id: fromCohort._id });
  }
  await Course.deleteOne({ _id: fromCourse._id });
  res.json({ success: true, data: { moved: moved.length } });
});

/**
 * GET /api/catalog/source-courses/:id/source
 * The ORIGINAL column from קורסים.xlsx for this course, with יקיר's own colors.
 */
export const sourceCourseStyled = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id).lean();
  if (!course) throw ApiError.notFound("הקורס לא נמצא");
  const file =
    course.sourceFile && course.sourceFile.endsWith(".xlsx")
      ? course.sourceFile
      : "קורסים.xlsx";
  const names = [
    ...new Set([course.name, ...(course.rawNames || [])].filter(Boolean)),
  ];

  // קודם ממונגו (scripts/importExcelSource.js), ואם לא יובא - קריאה ישירה מה-xlsx
  const block = await SourceCourseBlock.findOne({ courseName: { $in: names } })
    .select("file sheet column entries")
    .lean();
  if (block) {
    return res.json({
      success: true,
      data: {
        file: block.file,
        sheet: block.sheet,
        column: block.column,
        entries: block.entries,
        from: "mongo",
      },
    });
  }

  try {
    const styled = await getStyledColumnByName(file, names);
    if (!styled) {
      return res.json({
        success: true,
        data: null,
        message: "לא נמצאה עמודה מתאימה בקובץ המקור",
      });
    }
    res.json({ success: true, data: styled });
  } catch (err) {
    res.json({ success: true, data: null, message: err.message });
  }
});
