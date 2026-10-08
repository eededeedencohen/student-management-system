import { randomBytes } from "crypto";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import CourseCohort from "../models/CourseCohort.js";
import Registration from "../models/Registration.js";
import Student from "../models/Student.js";
import DetailsForm from "../models/DetailsForm.js";
import DetailsSubmission from "../models/DetailsSubmission.js";
import { requiresEnglishDetails } from "./externalController.js";
import {
  attachAssignedCohorts,
  applyCourseSelection,
  clearCourseSelection,
  parseCohortIds,
} from "./registrationController.js";
import { splitName } from "../utils/normalize.js";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * טפסי השלמת פרטים אישיים לנרשמים (עמוד "ניהול טפסים"):
 * לכל מחזור פעיל נוצר טופס עם קישור ציבורי; הסטודנטים ממלאים את אותם שדות
 * כמו שלב "פרטים אישיים" בטופס העסקה (ולפרקטישינר גם שם באנגלית ופנייה),
 * ועמוד הניהול מציג מי מרשימת הנרשמים מילא ומי עדיין לא.
 */

const cleanStr = (v) => (typeof v === "string" ? v.trim().slice(0, 300) : "");

/** בדיקת ספרת ביקורת של ת.ז. ישראלית (עד 9 ספרות, מרופדת באפסים). */
const isValidIsraeliId = (id) => {
  const s = String(id || "").trim();
  if (!/^\d{5,9}$/.test(s)) return false;
  const p = s.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let n = Number(p[i]) * (i % 2 === 0 ? 1 : 2);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
};

const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || ""));
const phoneDigits = (v) =>
  String(v || "")
    .replace(/\D/g, "")
    .replace(/^972/, "0");
const isValidPhone = (v) => phoneDigits(v).length >= 9;

/** שם הקורס הקנוני של מחזור: שם הקורס הקטלוגי (לא איות חופשי). */
const cohortDisplay = (cohort) => ({
  courseName: cohort.catalogCourse?.name || "",
  label: cohort.label || "",
  requiresEnglish: requiresEnglishDetails(cohort.catalogCourse?.name || ""),
});

/* ------------------------------------------------------------------ */
/* רשימת הנרשמים של מחזור (ההגדרה המאוחדת - זהה לקטלוג/קורסים)          */
/* ------------------------------------------------------------------ */

/** מפה cohortId -> רשימת עסקאות רישום משויכות (כולל דרך coursesAll). */
const enrolledDealsByCohort = async (cohortIds) => {
  const wanted = new Set(cohortIds.map(String));
  const links = await CourseCohort.find({
    _id: { $in: cohortIds },
    sourceCourse: { $ne: null },
  })
    .select("sourceCourse")
    .lean();
  const cohortOfSource = new Map(
    links.map((c) => [String(c.sourceCourse), String(c._id)]),
  );
  const deals = await Registration.find({ recordType: "registration" })
    .select("student studentName cohort cohortsAll coursesAll")
    .lean();
  const byCohort = new Map();
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
    for (const k of set) {
      if (!wanted.has(k)) continue;
      if (!byCohort.has(k)) byCohort.set(k, []);
      byCohort.get(k).push(d);
    }
  }
  return byCohort;
};

/* ------------------------------------------------------------------ */
/* ציבורי - הטופס עצמו                                                 */
/* ------------------------------------------------------------------ */

/** GET /api/public/details-form/:token - פרטי הטופס לעמוד הציבורי. */
export const publicFormInfo = asyncHandler(async (req, res) => {
  const form = await DetailsForm.findOne({ token: req.params.token })
    .populate({
      path: "cohort",
      select: "label catalogCourse",
      populate: { path: "catalogCourse", select: "name" },
    })
    .lean();
  if (!form?.cohort) throw ApiError.notFound("הטופס לא נמצא");
  res.json({ success: true, data: cohortDisplay(form.cohort) });
});

/** POST /api/public/details-form/:token - הגשת הטופס (ציבורי, מוגבל קצב). */
export const publicFormSubmit = asyncHandler(async (req, res) => {
  const form = await DetailsForm.findOne({ token: req.params.token })
    .populate({
      path: "cohort",
      select: "label catalogCourse",
      populate: { path: "catalogCourse", select: "name" },
    })
    .lean();
  if (!form?.cohort) throw ApiError.notFound("הטופס לא נמצא");
  const { requiresEnglish } = cohortDisplay(form.cohort);

  const b = req.body || {};
  const data = {
    firstNameHe: cleanStr(b.firstNameHe),
    lastNameHe: cleanStr(b.lastNameHe),
    firstNameEn: cleanStr(b.firstNameEn),
    lastNameEn: cleanStr(b.lastNameEn),
    idNumber: cleanStr(b.idNumber),
    gender: b.gender === "male" || b.gender === "female" ? b.gender : "",
    title: cleanStr(b.title),
    city: cleanStr(b.city),
    street: cleanStr(b.street),
    houseNumber: cleanStr(b.houseNumber),
    apartment: cleanStr(b.apartment),
    zip: cleanStr(b.zip),
    addressNotes: cleanStr(b.addressNotes),
    email: cleanStr(b.email).toLowerCase(),
    phone: cleanStr(b.phone),
  };

  if (!data.firstNameHe || !data.lastNameHe)
    throw ApiError.badRequest("שם פרטי ושם משפחה בעברית הם שדות חובה");
  if (!isValidIsraeliId(data.idNumber))
    throw ApiError.badRequest("תעודת הזהות אינה תקינה");
  if (!data.gender) throw ApiError.badRequest("יש לבחור מין");
  if (!data.city || !data.street || !data.houseNumber)
    throw ApiError.badRequest("כתובת מלאה (עיר, רחוב ומספר בניין) היא שדה חובה");
  if (!isValidEmail(data.email))
    throw ApiError.badRequest("כתובת המייל אינה תקינה");
  if (!isValidPhone(data.phone))
    throw ApiError.badRequest("מספר הטלפון אינו תקין");

  // לגבר הפנייה תמיד .Mr; לפרקטישינר חובה שם באנגלית ופנייה (התעודה באנגלית)
  if (data.gender === "male") data.title = "Mr.";
  if (data.title && !["Mr.", "Ms.", "Mrs."].includes(data.title))
    throw ApiError.badRequest("הפנייה אינה תקינה");
  if (requiresEnglish && (!data.firstNameEn || !data.lastNameEn || !data.title)) {
    throw ApiError.badRequest(
      "לקורס NLP פרקטישינר חובה למלא שם פרטי ומשפחה באנגלית ופנייה (.Mr/.Ms/.Mrs) - התעודה מונפקת גם בעברית וגם באנגלית",
    );
  }

  await DetailsSubmission.create({
    form: form._id,
    cohort: form.cohort._id,
    ...data,
  });
  res.status(201).json({ success: true, data: { submitted: true } });
});

/* ------------------------------------------------------------------ */
/* ניהול (מנהל בלבד)                                                   */
/* ------------------------------------------------------------------ */

/**
 * מפתח שם ללא תלות בסדר המילים: בייבוא מה-JSON חלק מהשמות נשמרו הפוך
 * ("שימשי עודד"), ולכן "עודד שימשי" מהטופס חייב להתאים לאותו נרשם.
 */
const nameKey = (s) =>
  String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");

/**
 * התאמת הגשה לסטודנט מרשימת הנרשמים: קישור ידני (הצלבה) גובר על הכל; אחרת
 * לפי ת.ז. אמיתית, טלפון, או שם מלא (ללא תלות בסדר המילים). ההתאמה
 * האוטומטית דינמית - לא נשמרת - כדי שתתעדכן כשהרשימה או ההגשות משתנות.
 */
const matchSubmission = (sub, roster) => {
  if (sub.student) {
    const linked = roster.find((r) => r.studentId === String(sub.student));
    if (linked) return linked;
  }
  const subPhone = phoneDigits(sub.phone);
  const subName = nameKey(`${sub.firstNameHe} ${sub.lastNameHe}`);
  for (const r of roster) {
    if (sub.idNumber && r.realIdNumber && sub.idNumber === r.realIdNumber)
      return r;
  }
  for (const r of roster) {
    if (subPhone && r.phoneKey && subPhone === r.phoneKey) return r;
  }
  for (const r of roster) {
    if (subName && r.nameKey && subName === r.nameKey) return r;
  }
  return null;
};

/**
 * GET /api/details-forms
 * כל המחזורים הפעילים + כל מחזור שכבר יש לו טופס: פרטי הטופס, רשימת הנרשמים
 * עם מי מילא ומי לא, וכל ההגשות (כולל כאלה שלא זוהו ברשימה).
 */
export const adminList = asyncHandler(async (req, res) => {
  const forms = await DetailsForm.find({}).lean();
  const formByCohort = new Map(forms.map((f) => [String(f.cohort), f]));
  const cohorts = await CourseCohort.find({
    $or: [
      { status: "active" },
      { _id: { $in: forms.map((f) => f.cohort) } },
    ],
  })
    .populate("catalogCourse", "name")
    .lean();

  const cohortIds = cohorts.map((c) => c._id);
  const dealsByCohort = await enrolledDealsByCohort(cohortIds);
  const studentIds = [
    ...new Set(
      [...dealsByCohort.values()]
        .flat()
        .map((d) => (d.student ? String(d.student) : null))
        .filter(Boolean),
    ),
  ];
  const submissions = await DetailsSubmission.find({
    form: { $in: forms.map((f) => f._id) },
  })
    .sort({ createdAt: -1 })
    .lean();
  // גם סטודנטים שהוצלבו ידנית אך אינם ברשימת המחזור (למשל אחרי שהעסקה הועברה
  // למחזור אחר) - כדי להציג את שמם ליד ההגשה
  for (const s of submissions) if (s.student) studentIds.push(String(s.student));
  const students = await Student.find({ _id: { $in: [...new Set(studentIds)] } })
    .select("fullName mobile realIdNumber")
    .lean();
  const studentById = new Map(students.map((s) => [String(s._id), s]));
  const subsByForm = new Map();
  for (const s of submissions) {
    const k = String(s.form);
    if (!subsByForm.has(k)) subsByForm.set(k, []);
    subsByForm.get(k).push(s);
  }

  const data = cohorts
    .map((c) => {
      const disp = cohortDisplay(c);
      const form = formByCohort.get(String(c._id)) || null;

      // רשימת הנרשמים: סטודנט ייחודי לכל עסקה משויכת
      const roster = [];
      const seen = new Set();
      for (const d of dealsByCohort.get(String(c._id)) || []) {
        const sid = d.student ? String(d.student) : null;
        if (!sid || seen.has(sid)) continue;
        seen.add(sid);
        const st = studentById.get(sid);
        const name = st?.fullName || d.studentName || "";
        roster.push({
          studentId: sid,
          name,
          nameKey: nameKey(name),
          phone: st?.mobile || "",
          phoneKey: phoneDigits(st?.mobile),
          realIdNumber: st?.realIdNumber || "",
        });
      }

      const subs = (form && subsByForm.get(String(form._id))) || [];
      const filledStudentIds = new Map(); // studentId -> submissionId
      const subRows = subs.map((s) => {
        const m = matchSubmission(s, roster);
        if (m && !filledStudentIds.has(m.studentId))
          filledStudentIds.set(m.studentId, String(s._id));
        // הוצלב ידנית לסטודנט שכבר לא ברשימת המחזור: עדיין "מזוהה" (עם השם),
        // אבל לא נספר כמי שמילא - הוא לא נרשם כאן
        const linkedOut =
          !m && s.student ? studentById.get(String(s.student)) : null;
        return {
          id: String(s._id),
          createdAt: s.createdAt,
          matchedStudentId: m ? m.studentId : linkedOut ? String(linkedOut._id) : null,
          matchedName: m ? m.name : linkedOut ? linkedOut.fullName : "",
          linked: Boolean(s.student),
          inRoster: Boolean(m),
          firstNameHe: s.firstNameHe,
          lastNameHe: s.lastNameHe,
          firstNameEn: s.firstNameEn,
          lastNameEn: s.lastNameEn,
          idNumber: s.idNumber,
          gender: s.gender,
          title: s.title,
          city: s.city,
          street: s.street,
          houseNumber: s.houseNumber,
          apartment: s.apartment,
          zip: s.zip,
          addressNotes: s.addressNotes,
          email: s.email,
          phone: s.phone,
        };
      });

      return {
        cohortId: String(c._id),
        ...disp,
        status: c.status,
        form: form
          ? {
              id: String(form._id),
              token: form.token,
              createdAt: form.createdAt,
            }
          : null,
        roster: roster.map((r) => ({
          studentId: r.studentId,
          name: r.name,
          phone: r.phone,
          filled: filledStudentIds.has(r.studentId),
          submissionId: filledStudentIds.get(r.studentId) || null,
        })),
        submissions: subRows,
        rosterCount: roster.length,
        filledCount: filledStudentIds.size,
      };
    })
    .sort(
      (a, b) =>
        a.courseName.localeCompare(b.courseName, "he") ||
        a.label.localeCompare(b.label, "he"),
    );

  res.json({ success: true, data });
});

/** POST /api/details-forms {cohort} - יצירת טופס למחזור (אידמפוטנטי). */
export const createForm = asyncHandler(async (req, res) => {
  const cohortId = String(req.body?.cohort || "");
  const cohort = await CourseCohort.findById(cohortId).lean();
  if (!cohort) throw ApiError.notFound("המחזור לא נמצא");
  let form = await DetailsForm.findOne({ cohort: cohort._id });
  if (!form) {
    form = await DetailsForm.create({
      cohort: cohort._id,
      token: randomBytes(18).toString("base64url"),
      createdByName: req.user?.name || "",
    });
  }
  res
    .status(201)
    .json({ success: true, data: { id: String(form._id), token: form.token } });
});

/** DELETE /api/details-forms/:id - מחיקת טופס עם כל ההגשות שלו (לטסטים). */
export const deleteForm = asyncHandler(async (req, res) => {
  const form = await DetailsForm.findById(req.params.id);
  if (!form) throw ApiError.notFound("הטופס לא נמצא");
  const { deletedCount } = await DetailsSubmission.deleteMany({
    form: form._id,
  });
  await form.deleteOne();
  res.json({ success: true, data: { deleted: true, submissions: deletedCount } });
});

/** DELETE /api/details-forms/submissions/:id - מחיקת הגשה בודדת. */
export const deleteSubmission = asyncHandler(async (req, res) => {
  const sub = await DetailsSubmission.findById(req.params.id);
  if (!sub) throw ApiError.notFound("ההגשה לא נמצאה");
  await sub.deleteOne();
  res.json({ success: true, data: { deleted: true } });
});

/* ------------------------------------------------------------------ */
/* הצלבה: הגשה שלא זוהתה <-> סטודנט במאגר                              */
/* ------------------------------------------------------------------ */

/** תיאור קצר של העסקאות של סטודנט לתוצאות החיפוש: "קורס · מחזור". */
const dealSummaries = async (regs) => {
  const withCohorts = await attachAssignedCohorts(regs);
  return withCohorts.map((r) => ({
    id: String(r._id),
    text:
      r.assignedCohorts.length > 0
        ? r.assignedCohorts
            .map((c) => (c.label ? `${c.courseName} · ${c.label}` : c.courseName))
            .join(" + ")
        : r.courseRaw || r.courseField || "ללא שיוך",
    cohortIds: r.assignedCohorts.map((c) => c._id),
    unassigned: r.assignedCohorts.length === 0,
    dealDate: r.dealDate || null,
    repName: r.repName || "",
    totalAmount: r.totalAmount || 0,
    totalPaid: r.totalPaid || 0,
    paymentStatus: r.paymentStatus || "",
    recordType: r.recordType || "",
    cancelled: Boolean(r.cancellation?.canceledAt) || r.recordType === "cancelled",
  }));
};

/**
 * GET /api/details-forms/students?q=
 * חיפוש סטודנט בכל המאגר (לא רק ברשימת המחזור) להצלבה עם הגשה. כל מילה
 * בשאילתה חייבת להופיע בשם המלא (בכל סדר - שמות מהייבוא נשמרו הפוך), או
 * התאמה לת.ז. / טלפון / מייל. לכל תוצאה מצורפות העסקאות כדי לזהות את
 * האדם הנכון כשיש כמה בעלי אותו שם.
 */
export const searchStudents = asyncHandler(async (req, res) => {
  const q = cleanStr(req.query.q);
  if (q.length < 2) return res.json({ success: true, data: [] });
  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const digits = q.replace(/\D/g, "");
  const or = [
    { $and: words.map((w) => ({ fullName: new RegExp(escapeRegex(w), "i") })) },
    { email: new RegExp(escapeRegex(q), "i") },
  ];
  if (digits.length >= 4) {
    or.push({ realIdNumber: new RegExp(escapeRegex(digits)) });
    or.push({ mobile: new RegExp(escapeRegex(digits)) });
  }
  const students = await Student.find({ $or: or })
    .select("fullName englishName mobile email realIdNumber")
    .sort({ fullName: 1 })
    .limit(25)
    .lean();
  const regs = await Registration.find({
    student: { $in: students.map((s) => s._id) },
  }).sort({ dealDate: -1 });
  const summaries = await dealSummaries(regs);
  const byStudent = new Map();
  regs.forEach((r, i) => {
    const k = String(r.student);
    if (!byStudent.has(k)) byStudent.set(k, []);
    byStudent.get(k).push(summaries[i]);
  });
  res.json({
    success: true,
    data: students.map((s) => ({
      id: String(s._id),
      fullName: s.fullName,
      englishName: s.englishName || "",
      mobile: s.mobile || "",
      email: s.email || "",
      realIdNumber: s.realIdNumber || "",
      deals: byStudent.get(String(s._id)) || [],
    })),
  });
});

/**
 * GET /api/details-forms/students/:id
 * הסטודנט + כל העסקאות שלו עם השיוך בפועל - לדיאלוג ההצלבה. בלי סינון נציגה:
 * ההצלבה היא פעולת ניהול על כל המאגר.
 */
export const studentForLink = asyncHandler(async (req, res) => {
  const student = await Student.findById(req.params.id).lean();
  if (!student) throw ApiError.notFound("תלמיד/ה לא נמצא/ה");
  const regs = await Registration.find({ student: student._id }).sort({
    dealDate: -1,
  });
  res.json({
    success: true,
    data: { student, registrations: await dealSummaries(regs) },
  });
});

/** שדות הסטודנט שההצלבה רשאית לעדכן מתוך הטופס (לא כסף, לא מזהים פנימיים). */
const LINK_STUDENT_FIELDS = [
  "fullName",
  "englishName",
  "realIdNumber",
  "gender",
  "title",
  "mobile",
  "email",
  "city",
  "street",
  "houseNumber",
  "apartment",
  "zip",
  "addressNotes",
];

/**
 * POST /api/details-forms/submissions/:id/link
 * body: { studentId, student: {...}, registrations: [{ id, cohorts: [cohortId] }] }
 *
 * הצלבת הגשה לסטודנט במאגר: (1) ההגשה נקשרת לסטודנט (גובר על הזיהוי
 * האוטומטי), (2) פרטי הסטודנט מתעדכנים לפי מה שהמנהל אישר בדיאלוג (ברירת
 * המחדל: הנתונים מהטופס), (3) לכל עסקה שנשלחה - המחזורים שלה מוחלפים
 * (רשימה ריקה = הסרת השיוך). תשלומים ומחיר אינם נוגעים בשום מקרה.
 */
export const linkSubmission = asyncHandler(async (req, res) => {
  const sub = await DetailsSubmission.findById(req.params.id);
  if (!sub) throw ApiError.notFound("ההגשה לא נמצאה");
  const b = req.body || {};
  const student = await Student.findById(cleanStr(b.studentId));
  if (!student) throw ApiError.notFound("תלמיד/ה לא נמצא/ה");

  // --- פרטי הסטודנט ---
  const patch = b.student && typeof b.student === "object" ? b.student : {};
  const fullName = cleanStr(patch.fullName);
  if (Object.prototype.hasOwnProperty.call(patch, "fullName") && !fullName)
    throw ApiError.badRequest("שם מלא לא יכול להיות ריק");
  if (patch.realIdNumber && !isValidIsraeliId(cleanStr(patch.realIdNumber)))
    throw ApiError.badRequest("תעודת הזהות אינה תקינה");
  if (patch.email && !isValidEmail(cleanStr(patch.email)))
    throw ApiError.badRequest("כתובת המייל אינה תקינה");
  for (const key of LINK_STUDENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const v = cleanStr(patch[key]);
    if (key === "gender") {
      student.gender = v === "male" || v === "female" ? v : null;
    } else if (key === "title") {
      student.title = ["Mr.", "Ms.", "Mrs."].includes(v) ? v : null;
    } else if (key === "email") {
      student.email = v.toLowerCase();
    } else {
      student[key] = v || undefined;
    }
  }
  if (fullName) {
    const { firstName, lastName } = splitName(fullName);
    student.firstName = firstName;
    student.lastName = lastName;
    student.hebrewName = fullName;
  }
  // עקביות מין<->פנייה כמו בעריכת תלמיד: גבר תמיד .Mr, אישה לא .Mr
  if (student.gender === "male") student.title = "Mr.";
  else if (student.gender === "female" && student.title === "Mr.")
    student.title = null;
  await student.save();

  // --- המחזורים של העסקאות ---
  const changes = [];
  const wanted = Array.isArray(b.registrations) ? b.registrations : [];
  for (const entry of wanted) {
    const regId = cleanStr(entry?.id);
    if (!/^[0-9a-fA-F]{24}$/.test(regId)) continue;
    const reg = await Registration.findById(regId);
    if (!reg) throw ApiError.notFound("אחת העסקאות לא נמצאה");
    if (String(reg.student) !== String(student._id))
      throw ApiError.forbidden("העסקה אינה שייכת לסטודנט שנבחר");
    const ids = parseCohortIds(entry.cohorts);
    const current = (
      reg.cohortsAll?.length ? reg.cohortsAll : reg.cohort ? [reg.cohort] : []
    ).map(String);
    const same =
      ids.length === current.length && ids.every((id, i) => id === current[i]);
    if (same) continue;
    if (ids.length === 0) clearCourseSelection(reg, req.user);
    else await applyCourseSelection(reg, ids, { user: req.user });
    reg.recompute();
    await reg.save();
    changes.push({ id: String(reg._id), cohorts: ids });
  }

  sub.student = student._id;
  sub.linkedAt = new Date();
  sub.linkedByName = req.user?.name || "";
  await sub.save();

  res.json({
    success: true,
    data: {
      submissionId: String(sub._id),
      studentId: String(student._id),
      fullName: student.fullName,
      registrationsChanged: changes,
    },
  });
});

/** POST /api/details-forms/submissions/:id/unlink - ביטול הצלבה ידנית (חוזר לזיהוי אוטומטי). */
export const unlinkSubmission = asyncHandler(async (req, res) => {
  const sub = await DetailsSubmission.findById(req.params.id);
  if (!sub) throw ApiError.notFound("ההגשה לא נמצאה");
  sub.student = undefined;
  sub.linkedAt = undefined;
  sub.linkedByName = undefined;
  await sub.save();
  res.json({ success: true, data: { unlinked: true } });
});
