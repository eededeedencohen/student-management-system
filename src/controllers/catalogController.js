import mongoose from 'mongoose';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import Teacher from '../models/Teacher.js';
import CatalogCourse from '../models/CatalogCourse.js';
import CourseCohort, { COHORT_STATUSES } from '../models/CourseCohort.js';
import Course from '../models/Course.js';
import Registration from '../models/Registration.js';
import SourceCourseBlock from '../models/SourceCourseBlock.js';
import { getStyledColumnByName } from '../utils/excelStyled.js';
import { buildCourseIndex, matchDealToCourse } from '../utils/courseMatch.js';
import { cohortTeachers, teacherNamesOf } from '../utils/cohortTeachers.js';

/**
 * catalogController — יקיר's admin page: define מרצים (teachers), קורסים קטלוגיים
 * (the fixed course definitions) and מחזורי קורס (cohorts with a session list).
 * Manager-only. The legacy `Course` docs imported from קורסים.xlsx are exposed as
 * "Excel entries" he maps onto a catalog course + cohort.
 */

const cleanStr = (v) => (typeof v === 'string' ? v.trim() : '');
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/* ------------------------------------------------------------------ */
/* מרצים                                                               */
/* ------------------------------------------------------------------ */

export const listTeachers = asyncHandler(async (req, res) => {
  const teachers = await Teacher.find({}).sort({ fullName: 1 }).collation({ locale: 'he' }).lean();
  res.json({
    success: true,
    data: teachers.map((t) => ({
      id: String(t._id),
      fullName: t.fullName,
      phone: t.phone,
      email: t.email,
      idNumber: t.idNumber || '',
      active: t.active !== false,
      notes: t.notes || '',
    })),
  });
});

/**
 * הטלפון הוא המפתח העסקי של מרצה, ולכן מנורמל לצורה מקומית אחידה (05X...):
 * מסירים מפרידים, וממירים +972/972 ל-0 — אחרת אותו מרצה יוכל להיווצר פעמיים.
 */
const canonicalPhone = (raw) => {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  p = p.replace(/^\+?972/, '0');
  p = p.replace(/\+/g, '');
  if (p.length > 1 && !p.startsWith('0')) p = `0${p}`;
  return p;
};

const parseTeacherBody = (b) => {
  const fullName = cleanStr(b.fullName);
  const phone = canonicalPhone(b.phone);
  const email = cleanStr(b.email).toLowerCase();
  if (!fullName) throw ApiError.badRequest('שם מלא הוא שדה חובה');
  if (phone.replace(/\D/g, '').length < 9) throw ApiError.badRequest('מספר טלפון אינו תקין');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw ApiError.badRequest('כתובת המייל אינה תקינה');
  return { fullName, phone, email, idNumber: cleanStr(b.idNumber), notes: cleanStr(b.notes) };
};

export const createTeacher = asyncHandler(async (req, res) => {
  const data = parseTeacherBody(req.body || {});
  // הטלפון הוא המפתח העסקי של מרצה
  if (await Teacher.exists({ phone: data.phone })) {
    throw ApiError.badRequest('קיים כבר מרצה עם מספר הטלפון הזה');
  }
  const t = await Teacher.create(data);
  res.status(201).json({ success: true, data: { id: String(t._id) } });
});

export const updateTeacher = asyncHandler(async (req, res) => {
  const t = await Teacher.findById(req.params.id);
  if (!t) throw ApiError.notFound('המרצה לא נמצא');
  const data = parseTeacherBody({ ...t.toObject(), ...(req.body || {}) });
  const clash = await Teacher.findOne({ phone: data.phone, _id: { $ne: t._id } }).lean();
  if (clash) throw ApiError.badRequest('קיים כבר מרצה עם מספר הטלפון הזה');
  Object.assign(t, data);
  if (req.body?.active !== undefined) t.active = Boolean(req.body.active);
  await t.save();
  res.json({ success: true, data: { id: String(t._id) } });
});

export const deleteTeacher = asyncHandler(async (req, res) => {
  // בודקים את שני השדות — teachers (הקנוני) וגם teacher הישן במסמכים שלא עודכנו
  const inUse = await CourseCohort.exists({
    $or: [{ teachers: req.params.id }, { teacher: req.params.id }],
  });
  if (inUse) throw ApiError.badRequest('לא ניתן למחוק — המרצה משויך למחזור קורס');
  await Teacher.deleteOne({ _id: req.params.id });
  res.json({ success: true, data: { deleted: true } });
});

/* ------------------------------------------------------------------ */
/* קורסים קטלוגיים                                                     */
/* ------------------------------------------------------------------ */

export const listCatalogCourses = asyncHandler(async (req, res) => {
  const courses = await CatalogCourse.find({}).sort({ name: 1 }).collation({ locale: 'he' }).lean();
  const counts = await CourseCohort.aggregate([
    { $group: { _id: '$catalogCourse', n: { $sum: 1 } } },
  ]);
  const byCourse = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json({
    success: true,
    data: courses.map((c) => ({
      id: String(c._id),
      name: c.name,
      price: c.price || 0,
      defaultSessionCount: c.defaultSessionCount || 0,
      notes: c.notes || '',
      active: c.active !== false,
      cohortsCount: byCourse.get(String(c._id)) || 0,
    })),
  });
});

/** מספר לא-שלילי מקלט טופס. ריק/רווח/null אינם 0 — הם קלט חסר (אחרת שמירה מוחקת מחיר). */
const numField = (v, label) => {
  if (v === undefined || v === null || String(v).trim() === '') {
    throw ApiError.badRequest(`${label} הוא שדה חובה`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw ApiError.badRequest(`${label} אינו תקין`);
  return n;
};

const parseCourseBody = (b) => {
  const name = cleanStr(b.name);
  if (!name) throw ApiError.badRequest('שם הקורס הוא שדה חובה');
  return {
    name,
    price: numField(b.price, 'מחיר הקורס'),
    defaultSessionCount: numField(b.defaultSessionCount, 'כמות המפגשים'),
    notes: cleanStr(b.notes),
  };
};

export const createCatalogCourse = asyncHandler(async (req, res) => {
  const data = parseCourseBody(req.body || {});
  if (await CatalogCourse.exists({ name: data.name })) {
    throw ApiError.badRequest('קיים כבר קורס בשם הזה');
  }
  const c = await CatalogCourse.create(data);
  res.status(201).json({ success: true, data: { id: String(c._id) } });
});

export const updateCatalogCourse = asyncHandler(async (req, res) => {
  const c = await CatalogCourse.findById(req.params.id);
  if (!c) throw ApiError.notFound('הקורס לא נמצא');
  const data = parseCourseBody({ ...c.toObject(), ...(req.body || {}) });
  const clash = await CatalogCourse.findOne({ name: data.name, _id: { $ne: c._id } }).lean();
  if (clash) throw ApiError.badRequest('קיים כבר קורס בשם הזה');
  Object.assign(c, data);
  if (req.body?.active !== undefined) c.active = Boolean(req.body.active);
  await c.save();
  res.json({ success: true, data: { id: String(c._id) } });
});

export const deleteCatalogCourse = asyncHandler(async (req, res) => {
  const inUse = await CourseCohort.exists({ catalogCourse: req.params.id });
  if (inUse) throw ApiError.badRequest('לא ניתן למחוק — לקורס יש מחזורים');
  await CatalogCourse.deleteOne({ _id: req.params.id });
  res.json({ success: true, data: { deleted: true } });
});

/* ------------------------------------------------------------------ */
/* מחזורי קורס                                                         */
/* ------------------------------------------------------------------ */

const cohortJson = (c, enrolled = 0) => ({
  id: String(c._id),
  catalogCourse: c.catalogCourse ? String(c.catalogCourse._id || c.catalogCourse) : null,
  courseName: c.catalogCourse?.name || '',
  coursePrice: c.catalogCourse?.price || 0,
  defaultSessionCount: c.catalogCourse?.defaultSessionCount || 0,
  label: c.label || '',
  // teachers = הרשימה הקנונית; teacher/teacherName נשארים לתאימות עם קוראים ותיקים.
  teachers: cohortTeachers(c).map((t) => String(t._id || t)),
  teacherNames: cohortTeachers(c).map((t) => t?.fullName || '').filter(Boolean),
  teacher: cohortTeachers(c)[0] ? String(cohortTeachers(c)[0]._id || cohortTeachers(c)[0]) : null,
  teacherName: teacherNamesOf(c), // "עמר לוין + אביטל דניאל"
  defaultLocation: c.defaultLocation || '',
  status: c.status,
  registrationOpen: Boolean(c.registrationOpen),
  notes: c.notes || '',
  sourceCourse: c.sourceCourse ? String(c.sourceCourse) : null,
  enrolledCount: enrolled,
  sessions: (c.sessions || [])
    .map((s) => ({
      id: String(s._id),
      date: s.date,
      startTime: s.startTime || '',
      endTime: s.endTime || '',
      location: s.location || '',
      note: s.note || '',
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date)),
});

export const listCohorts = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.catalogCourse) filter.catalogCourse = req.query.catalogCourse;
  const cohorts = await CourseCohort.find(filter)
    .populate('catalogCourse', 'name price defaultSessionCount')
    .populate('teachers', 'fullName')
    .populate('teacher', 'fullName')
    .sort({ createdAt: -1 })
    .lean();
  const counts = await Registration.aggregate([
    { $match: { recordType: 'registration', cohort: { $ne: null } } },
    { $group: { _id: '$cohort', n: { $sum: 1 } } },
  ]);
  const byCohort = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json({
    success: true,
    data: cohorts.map((c) => cohortJson(c, byCohort.get(String(c._id)) || 0)),
  });
});

/** Validate + normalise the session list (dedup by date+start, cap the count). */
const parseSessions = (raw) => {
  if (!Array.isArray(raw)) return null;
  if (raw.length > 200) throw ApiError.badRequest('יותר מדי מפגשים (עד 200)');
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    // תאריך "YYYY-MM-DD" נשמר כחצות UTC כדי שהמפגש לא יזוז ביום בגלל אזור זמן
    const rawDate = String(s?.date || '');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? new Date(`${rawDate}T00:00:00.000Z`)
      : new Date(rawDate);
    if (Number.isNaN(date.getTime())) throw ApiError.badRequest('תאריך מפגש אינו תקין');
    const startTime = cleanStr(s?.startTime);
    const endTime = cleanStr(s?.endTime);
    if (startTime && !HHMM.test(startTime)) throw ApiError.badRequest(`שעת התחלה אינה תקינה: ${startTime}`);
    if (endTime && !HHMM.test(endTime)) throw ApiError.badRequest(`שעת סיום אינה תקינה: ${endTime}`);
    const key = `${date.toISOString().slice(0, 10)}|${startTime}`;
    if (seen.has(key)) continue; // אותו יום+שעה פעמיים = כפילות
    seen.add(key);
    out.push({ date, startTime, endTime, location: cleanStr(s?.location), note: cleanStr(s?.note) });
  }
  return out.sort((a, b) => a.date - b.date);
};

const parseCohortBody = async (b, existing) => {
  const out = {};
  const courseId = cleanStr(b.catalogCourse) || (existing && String(existing.catalogCourse));
  if (!courseId) throw ApiError.badRequest('יש לבחור קורס');
  const course = await CatalogCourse.findById(courseId).lean();
  if (!course) throw ApiError.badRequest('הקורס לא נמצא');
  out.catalogCourse = course._id;

  // ריבוי מרצים: מקבלים מערך `teachers`, ועדיין תומכים ב-`teacher` בודד מקוראים ותיקים.
  if (b.teachers !== undefined || b.teacher !== undefined) {
    const raw = Array.isArray(b.teachers) ? b.teachers : [b.teacher];
    const ids = [...new Set(raw.map((v) => cleanStr(v)).filter(Boolean))];
    if (ids.length > 10) throw ApiError.badRequest('יותר מדי מרצים למחזור (עד 10)');
    // מזהה שאינו ObjectId תקין היה זורק CastError (500) במקום שגיאת קלט ברורה
    if (ids.some((id) => !mongoose.isValidObjectId(id))) {
      throw ApiError.badRequest('מזהה מרצה אינו תקין');
    }
    if (ids.length) {
      const found = await Teacher.find({ _id: { $in: ids } }).select('_id').lean();
      if (found.length !== ids.length) throw ApiError.badRequest('אחד המרצים שנבחרו לא נמצא');
      // שומרים על סדר הבחירה של המשתמש, לא על סדר ההחזרה מהמונגו
      const ok = new Set(found.map((t) => String(t._id)));
      out.teachers = ids.filter((id) => ok.has(id));
    } else out.teachers = [];
    out.teacher = out.teachers[0] || null;
  }
  if (b.label !== undefined) out.label = cleanStr(b.label);
  if (b.defaultLocation !== undefined) out.defaultLocation = cleanStr(b.defaultLocation);
  if (b.notes !== undefined) out.notes = cleanStr(b.notes);
  if (b.status !== undefined) {
    if (!COHORT_STATUSES.includes(b.status)) throw ApiError.badRequest('סטטוס מחזור אינו תקין');
    out.status = b.status;
  }
  if (b.registrationOpen !== undefined) out.registrationOpen = Boolean(b.registrationOpen);
  const sessions = parseSessions(b.sessions);
  if (sessions) out.sessions = sessions;

  // מחזור שנגמר/בוטל לא יכול להיות בהרשמה פתוחה (נאכף גם במודל)
  const status = out.status || existing?.status;
  if ((status === 'ended' || status === 'cancelled') && out.registrationOpen) {
    throw ApiError.badRequest('מחזור שנגמר או בוטל לא יכול להיות בהרשמה פתוחה');
  }
  return out;
};

/**
 * העמוד הראשי "קורסים", הגאנט, התאמת העסקאות והמכירות — כולם רצים על רשומות
 * ה-Course הישנות. לכן מחזור שנוצר בטופס החדש (ולא מרשומת אקסל קיימת) מקבל
 * רשומת Course תואמת ("mirror") שמזוהה ב-sourceFile הזה, וכל עריכת מחזור
 * מסנכרנת אותה — כך העמוד הראשי תמיד משקף את המחזורים.
 */
export const COHORT_MIRROR_SOURCE = 'מחזור (מערכת)';

const LEGACY_STATUS = { active: 'פעיל', future: 'עתידי', ended: 'הסתיים', cancelled: 'בוטל' };
const WEEKDAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

/** שדות ה-Course הישן הנגזרים ממחזור. שם/מחיר נדרסים רק ב-mirror — לא ברשומת אקסל. */
const legacyFieldsFromCohort = async (cohort, catalog, { includeNaming }) => {
  const out = {};
  if (includeNaming) {
    out.name = `${catalog.name}${cohort.label ? ` ${cohort.label}` : ''}`;
    out.field = catalog.name;
    out.cohortLabel = cohort.label || '';
    out.price = catalog.price || 0;
  }
  const sessions = [...(cohort.sessions || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
  if (sessions.length) {
    out.startDate = sessions[0].date;
    out.endDate = sessions[sessions.length - 1].date;
    out.sessionsCount = sessions.length;
    // המפגשים נשמרים כחצות UTC, ולכן היום-בשבוע נקרא ב-UTC
    out.weekday = WEEKDAY_LETTERS[new Date(sessions[0].date).getUTCDay()] || '';
  }
  if (cohort.defaultLocation) out.location = cohort.defaultLocation;
  const teacherIds = (cohort.teachers || []).map(String);
  if (teacherIds.length) {
    const docs = await Teacher.find({ _id: { $in: teacherIds } }).select('fullName').lean();
    const nameOf = new Map(docs.map((t) => [String(t._id), t.fullName]));
    out.lecturer = teacherIds.map((id) => nameOf.get(id)).filter(Boolean).join(' + ');
  }
  out.status =
    cohort.registrationOpen && (cohort.status === 'active' || cohort.status === 'future')
      ? 'פתוח להרשמה'
      : LEGACY_STATUS[cohort.status] || 'פעיל';
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
  Object.assign(legacy, await legacyFieldsFromCohort(cohort, catalog, { includeNaming: isMirror }));
  await legacy.save();
};

export const createCohort = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const data = await parseCohortBody(b, null);
  const srcId = cleanStr(b.sourceCourse);
  if (srcId) {
    const src = await Course.findById(srcId).lean();
    if (!src) throw ApiError.badRequest('רשומת האקסל לא נמצאה');
    if (await CourseCohort.exists({ sourceCourse: src._id })) {
      throw ApiError.badRequest('לרשומת האקסל הזו כבר הוגדר מחזור');
    }
    data.sourceCourse = src._id;
  } else {
    // מחזור חדש שלא הוגדר מרשומת אקסל — יוצרים לו רשומת Course בעמוד הראשי
    const catalog = await CatalogCourse.findById(data.catalogCourse).lean();
    const fields = await legacyFieldsFromCohort(data, catalog, { includeNaming: true });
    const mirror = await Course.create({ ...fields, sourceFile: COHORT_MIRROR_SOURCE, notes: data.notes || '' });
    data.sourceCourse = mirror._id;
  }
  const c = await CourseCohort.create(data);
  await syncLegacyCourse(c);
  res.status(201).json({ success: true, data: { id: String(c._id) } });
});

export const updateCohort = asyncHandler(async (req, res) => {
  const c = await CourseCohort.findById(req.params.id);
  if (!c) throw ApiError.notFound('המחזור לא נמצא');
  const data = await parseCohortBody(req.body || {}, c);
  Object.assign(c, data);
  await c.save();
  await syncLegacyCourse(c);
  const populated = await CourseCohort.findById(c._id)
    .populate('catalogCourse', 'name price defaultSessionCount')
    .populate('teachers', 'fullName')
    .populate('teacher', 'fullName')
    .lean();
  res.json({ success: true, data: cohortJson(populated) });
});

export const deleteCohort = asyncHandler(async (req, res) => {
  const inUse = await Registration.exists({ cohort: req.params.id });
  if (inUse) throw ApiError.badRequest('לא ניתן למחוק — יש עסקאות המשויכות למחזור');
  const c = await CourseCohort.findById(req.params.id).lean();
  await CourseCohort.deleteOne({ _id: req.params.id });
  // רשומת mirror קיימת רק בזכות המחזור — נמחקת איתו. רשומת אקסל מקורית נשארת.
  if (c?.sourceCourse) {
    await Course.deleteOne({ _id: c.sourceCourse, sourceFile: COHORT_MIRROR_SOURCE });
  }
  res.json({ success: true, data: { deleted: true } });
});

/* ------------------------------------------------------------------ */
/* רשומות האקסל של יקיר (Course docs) — למיפוי לקורס + מחזור            */
/* ------------------------------------------------------------------ */

/**
 * GET /api/catalog/source-courses
 * The legacy Course rows (from קורסים.xlsx / the JSON dataset) with whether a cohort
 * has already been defined for each — יקיר's worklist.
 */
export const listSourceCourses = asyncHandler(async (req, res) => {
  const courses = await Course.find({}).sort({ startDate: -1, name: 1 }).lean();
  const cohorts = await CourseCohort.find({ sourceCourse: { $ne: null } })
    .select('sourceCourse catalogCourse label')
    .populate('catalogCourse', 'name')
    .lean();
  const bySource = new Map(cohorts.map((c) => [String(c.sourceCourse), c]));
  // ספירת העסקאות לפי אותה התאמה היוריסטית שכל האפליקציה משתמשת בה (לא רק לפי ה-FK),
  // אחרת רשומות עם עסקאות יוצגו כ-0.
  const deals = await Registration.find({ recordType: 'registration' })
    .select('course courseRaw courseField cohortLabel dealDate coursesAll')
    .lean();
  const index = buildCourseIndex(courses);
  const dealsByCourse = new Map();
  const bump = (id) => id && dealsByCourse.set(String(id), (dealsByCourse.get(String(id)) || 0) + 1);
  for (const d of deals) {
    if (d.course) {
      bump(d.course);
      for (const extra of d.coursesAll || []) if (String(extra) !== String(d.course)) bump(extra);
    } else {
      const m = matchDealToCourse(d, index); // { courseId, how } | null
      if (m?.courseId) bump(m.courseId);
    }
  }

  res.json({
    success: true,
    data: courses.map((c) => {
      const hit = bySource.get(String(c._id));
      return {
        id: String(c._id),
        name: c.name,
        field: c.field || '',
        cohortLabel: c.cohortLabel || '',
        startDate: c.startDate || null,
        endDate: c.endDate || null,
        sessionsCount: c.sessionsCount || null,
        location: c.location || '',
        lecturer: c.lecturer || '',
        weekday: c.weekday || '',
        status: c.status || '',
        price: c.price ?? null,
        sourceFile: c.sourceFile || '',
        dealsCount: dealsByCourse.get(String(c._id)) || 0,
        mapped: Boolean(hit),
        mappedTo: hit
          ? { cohortId: String(hit._id), courseName: hit.catalogCourse?.name || '', label: hit.label || '' }
          : null,
      };
    }),
  });
});

/**
 * GET /api/catalog/source-courses/:id/source
 * The ORIGINAL column from קורסים.xlsx for this course, with יקיר's own colors.
 */
export const sourceCourseStyled = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id).lean();
  if (!course) throw ApiError.notFound('הקורס לא נמצא');
  const file = course.sourceFile && course.sourceFile.endsWith('.xlsx') ? course.sourceFile : 'קורסים.xlsx';
  const names = [...new Set([course.name, ...(course.rawNames || [])].filter(Boolean))];

  // קודם ממונגו (scripts/importExcelSource.js), ואם לא יובא — קריאה ישירה מה-xlsx
  const block = await SourceCourseBlock.findOne({ courseName: { $in: names } })
    .select('file sheet column entries')
    .lean();
  if (block) {
    return res.json({
      success: true,
      data: {
        file: block.file,
        sheet: block.sheet,
        column: block.column,
        entries: block.entries,
        from: 'mongo',
      },
    });
  }

  try {
    const styled = await getStyledColumnByName(file, names);
    if (!styled) {
      return res.json({ success: true, data: null, message: 'לא נמצאה עמודה מתאימה בקובץ המקור' });
    }
    res.json({ success: true, data: styled });
  } catch (err) {
    res.json({ success: true, data: null, message: err.message });
  }
});
