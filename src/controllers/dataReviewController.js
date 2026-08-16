import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import Registration from "../models/Registration.js";
import Student from "../models/Student.js";
import CourseCohort from "../models/CourseCohort.js";
import SourceRef from "../models/SourceRef.js";
import SourceRow from "../models/SourceRow.js";
import { isValidIsraeliId } from "../utils/israeliId.js";
import { getStyledRows } from "../utils/excelStyled.js";
import { teacherNamesOf } from "../utils/cohortTeachers.js";

/**
 * dataReviewController - "עריכת נתונים" (legacy-data cleanup).
 *
 * Each rep sees ONLY her own deals + students and completes them to the standard of a
 * new deal: full student details (validated ת.ז.), a payment breakdown for every 2026
 * deal, and a course-cohort assignment. Managers see everything.
 *
 * The point is to make the reps work as LITTLE as possible: the deal list ships with
 * a ready-made suggestion (prefilled student fields, a suggested payment split derived
 * from the imported money, and a cohort guess), plus the exact original Excel row with
 * its real colors so they can compare against what they wrote.
 */

const SINCE_2026 = new Date("2026-01-01T00:00:00.000Z");
const cleanStr = (v) => (typeof v === "string" ? v.trim() : "");
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const PAY_METHODS = ["credit", "ern", "cash", "transfer"];
const PAY_TYPES = ["advance", "installment", "one_time"];

/** Rep scope: a rep is limited to her own deals; managers/super-admin see all. */
const repFilter = (req) =>
  req.user?.role === "rep" ? { rep: req.user._id } : {};

/**
 * האם ה-_id הוא ObjectId אמיתי. ה-ADMIN_TOKEN shortcut מזריק `_id:'admin-token'`
 * (middleware/auth.js), ושמירתו בשדה ref גורמת ל-CastError ולכשל השמירה.
 */
const isRealUserId = (id) => /^[0-9a-fA-F]{24}$/.test(String(id || ""));

/** Which student fields a new deal requires - drives the "what's missing" checklist. */
const REQUIRED_STUDENT_FIELDS = [
  ["firstName", "שם פרטי"],
  ["lastName", "שם משפחה"],
  ["realIdNumber", "תעודת זהות"],
  ["gender", "מין"],
  ["title", "פנייה"],
  ["mobile", "טלפון"],
  ["email", "מייל"],
  ["city", "עיר"],
  ["street", "רחוב"],
  ["houseNumber", "מספר בית"],
];

/** Missing/invalid student fields for the review checklist. */
function studentIssues(student) {
  const issues = [];
  if (!student) return [{ field: "student", label: "לא מקושר תלמיד/ה" }];
  for (const [field, label] of REQUIRED_STUDENT_FIELDS) {
    if (!cleanStr(student[field])) issues.push({ field, label });
  }
  const id = cleanStr(student.realIdNumber);
  if (id && !isValidIsraeliId(id)) {
    issues.push({
      field: "realIdNumber",
      label: "ת.ז. אינה תקינה (ספרת ביקורת)",
    });
  }
  return issues;
}

/**
 * הסכום שפירוט התשלומים צריך לכסות. `writeOff` = יתרה שנמחלה (הנחה בדיעבד או יתרת
 * עסקה שבוטלה) - לפי recompute(): outstanding = total − collected − writeOff, ולכן
 * התשלומים מכסים את המחיר פחות המחילה. בלי זה עסקאות שנסגרו בהנחה לא ניתנות לאישור
 * אלא בהמצאת כסף שלא נגבה.
 */
const expectedPaymentsSum = (reg) => {
  const total = round2(reg.dealPrice > 0 ? reg.dealPrice : reg.totalAmount);
  return {
    total,
    expected: round2(Math.max(total - (Number(reg.writeOff) || 0), 0)),
  };
};

/** Deal-level issues: 2026 deals must carry a real payment breakdown + a cohort. */
function dealIssues(reg) {
  const issues = [];
  const is2026 = reg.dealDate && new Date(reg.dealDate) >= SINCE_2026;
  const payments = reg.payments || [];
  if (is2026) {
    if (payments.length === 0)
      issues.push({ field: "payments", label: "חסר פירוט תשלומים" });
    else {
      const sum = round2(
        payments.reduce((s, p) => s + (Number(p.amount) || 0), 0),
      );
      const { total, expected } = expectedPaymentsSum(reg);
      if (total > 0 && Math.abs(sum - expected) > 1) {
        issues.push({
          field: "payments",
          label:
            expected === total
              ? `סך התשלומים (${sum}) אינו שווה לסכום העסקה (${total})`
              : `סך התשלומים (${sum}) אינו שווה ל-${expected} (עסקה ${total} בניכוי מחילה ${round2(reg.writeOff)})`,
        });
      }
      if (payments.some((p) => !p.dueDate)) {
        issues.push({ field: "payments", label: "יש תשלום ללא תאריך" });
      }
      if (
        payments.some(
          (p) => !PAY_METHODS.includes(p.methodCategory || p.method),
        )
      ) {
        issues.push({
          field: "payments",
          label: "יש תשלום ללא אמצעי תשלום מוגדר",
        });
      }
    }
  }
  if (!reg.cohort)
    issues.push({ field: "cohort", label: "לא שויך מחזור קורס" });
  return issues;
}

/**
 * Suggest a payment breakdown from the legacy money, so the rep usually only has to
 * confirm. Uses the imported advance/balance/method as recorded; credit = one paid
 * charge (money arrives at once), ERN/other = split over the recorded installments.
 */
function suggestPayments(reg) {
  const existing = reg.payments || [];
  if (existing.length > 0) {
    return existing.map((p) => ({
      type: p.type || (p.kind === "advance" ? "advance" : "one_time"),
      amount: round2(p.amount),
      method: PAY_METHODS.includes(p.methodCategory || p.method)
        ? p.methodCategory || p.method
        : reg.paymentCategory && PAY_METHODS.includes(reg.paymentCategory)
          ? reg.paymentCategory
          : "credit",
      dueDate: p.dueDate || p.date || reg.dealDate,
      // בעסקאות v1 מיובאות כל רשומת תשלום היא כסף שנגבה (v1 recompute סוכם את כולן),
      // וה-flag `paid` נשמר שם כ-false כברירת מחדל - ולכן אין להסתמך עליו.
      paid: reg.schemaVersion === 2 ? Boolean(p.paid) : true,
      installments: p.installments || undefined,
      note: p.note || "",
    }));
  }

  const total = round2(reg.dealPrice > 0 ? reg.dealPrice : reg.totalAmount);
  if (!(total > 0)) return [];
  const method = PAY_METHODS.includes(reg.paymentCategory)
    ? reg.paymentCategory
    : "credit";
  const advance = round2(reg.advancePaid);
  const out = [];
  if (advance > 0 && advance < total) {
    out.push({
      type: "advance",
      amount: advance,
      method,
      dueDate: reg.dealDate,
      paid: true,
      note: "מקדמה (הוצע מהנתונים הישנים)",
    });
  }
  const remaining = round2(
    total - (advance > 0 && advance < total ? advance : 0),
  );
  if (remaining > 0) {
    const n = Number(reg.installments) > 1 ? Number(reg.installments) : 1;
    if (method === "credit" || n <= 1) {
      // אשראי - כל הכסף נכנס בחיוב אחד (הפריסה היא מול חברת האשראי)
      out.push({
        type: advance > 0 ? "installment" : "one_time",
        amount: remaining,
        method,
        dueDate: reg.nextPaymentDate || reg.dealDate,
        paid: round2(reg.totalPaid) >= total - 1,
        installments: n > 1 ? n : undefined,
        note: "הוצע מהנתונים הישנים",
      });
    } else {
      const per = round2(remaining / n);
      const base = reg.nextPaymentDate
        ? new Date(reg.nextPaymentDate)
        : new Date(reg.dealDate);
      // מסמנים כ"שולם" רק עד גובה הכסף שנגבה בפועל לפי הנתונים הישנים - כך לא ממציאים
      // גבייה, וגם לא משאירים תשלום שמועדו עבר "פתוח" (שאותו הריצה היומית תאשר לבד).
      let creditLeft = Math.max(
        round2(reg.totalPaid) - (advance > 0 && advance < total ? advance : 0),
        0,
      );
      for (let i = 0; i < n; i += 1) {
        const d = new Date(base);
        d.setMonth(d.getMonth() + i);
        const amount = i === n - 1 ? round2(remaining - per * (n - 1)) : per;
        const covered = creditLeft >= amount - 1;
        if (covered) creditLeft = round2(creditLeft - amount);
        out.push({
          type: "installment",
          amount,
          method,
          dueDate: d,
          paid: covered,
          note: `${i + 1}/${n} (הוצע מהנתונים הישנים)`,
        });
      }
    }
  }
  return out;
}

/** Cohort guess: exact legacy-course link first, then a name/label match. */
async function suggestCohort(reg, cohorts) {
  if (reg.cohort) return null;
  const bySource = reg.course
    ? cohorts.find((c) => String(c.sourceCourse || "") === String(reg.course))
    : null;
  if (bySource)
    return { cohortId: String(bySource._id), reason: "לפי הקורס שקושר בייבוא" };
  const raw = cleanStr(reg.courseRaw).toLowerCase();
  const label = cleanStr(reg.cohortLabel).toLowerCase();
  if (!raw && !label) return null;
  const hit = cohorts.find((c) => {
    const cname = cleanStr(c.catalogCourse?.name).toLowerCase();
    const clabel = cleanStr(c.label).toLowerCase();
    const nameMatch =
      cname && raw && (raw.includes(cname) || cname.includes(raw));
    const labelMatch = clabel && label && clabel === label;
    return nameMatch && (labelMatch || !label);
  });
  return hit
    ? { cohortId: String(hit._id), reason: "לפי שם הקורס/מחזור" }
    : null;
}

/**
 * GET /api/data-review/deals
 * The rep's deals with per-deal review state, issues, prefilled suggestions and the
 * source-row pointers. `?scope=2026|all` (default 2026 - those need payment detail),
 * `?state=pending|done`.
 */
/**
 * Build the review payload for a set of deals matching `filter` (scoped by caller).
 * Shared by the list endpoint and the single-deal refresh, so a card refreshed after a
 * save is shaped exactly like the one from the list.
 */
async function buildDeals(filter) {
  const regs = await Registration.find(filter)
    .select("-contract.signatureDataUrl") // תמונת החתימה יכולה להיות מאות KB - לא נחוצה כאן
    .sort({ dealDate: -1 })
    .lean();
  const studentIds = [
    ...new Set(
      regs
        .map((r) => r.student)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const [students, cohorts, refs] = await Promise.all([
    Student.find({ _id: { $in: studentIds } }).lean(),
    CourseCohort.find({}).populate("catalogCourse", "name price").lean(),
    SourceRef.find({ deal: { $in: regs.map((r) => r._id) } }).lean(),
  ]);
  const studentById = new Map(students.map((s) => [String(s._id), s]));
  const refsByDeal = new Map();
  for (const ref of refs) {
    const k = String(ref.deal);
    if (!refsByDeal.has(k)) refsByDeal.set(k, []);
    refsByDeal.get(k).push(ref);
  }

  const data = [];
  for (const reg of regs) {
    const student = reg.student ? studentById.get(String(reg.student)) : null;
    const sIssues = studentIssues(student);
    const dIssues = dealIssues(reg);
    const sourceRefs = refsByDeal.get(String(reg._id)) || [];
    // rows to show from the original workbook: the deal row + any payment rows
    const rows = [
      ...(reg.sourceRow ? [reg.sourceRow] : []),
      ...sourceRefs.map((r) => r.sourceRow).filter(Boolean),
    ];
    data.push({
      id: String(reg._id),
      externalId: reg.externalId || "",
      studentId: student ? String(student._id) : null,
      studentName: reg.studentName || "",
      studentNumber: student?.studentNumber || null,
      repName: reg.repName || "",
      courseRaw: reg.courseRaw || "",
      cohortLabel: reg.cohortLabel || "",
      cohort: reg.cohort ? String(reg.cohort) : null,
      dealDate: reg.dealDate,
      is2026: Boolean(reg.dealDate && new Date(reg.dealDate) >= SINCE_2026),
      totalAmount: reg.totalAmount || 0,
      dealPrice: reg.dealPrice ?? null,
      writeOff: round2(reg.writeOff) || 0,
      // הסכום שפירוט התשלומים אמור לכסות (מחיר בניכוי מחילה) - זה מה שהשרת מאמת
      paymentsTarget: expectedPaymentsSum(reg).expected,
      totalPaid: reg.totalPaid || 0,
      outstanding: reg.outstanding || 0,
      paymentCategory: reg.paymentCategory || "",
      installments: reg.installments || null,
      payments: (reg.payments || []).map((p) => ({
        id: String(p._id),
        type: p.type || "",
        amount: p.amount || 0,
        method: p.methodCategory || p.method || "",
        dueDate: p.dueDate || p.date || null,
        paid: Boolean(p.paid),
        installments: p.installments || null,
        note: p.note || "",
      })),
      suggestedPayments: suggestPayments(reg),
      suggestedCohort: await suggestCohort(reg, cohorts),
      review: {
        status: reg.dataReview?.status || "pending",
        byName: reg.dataReview?.byName || "",
        at: reg.dataReview?.at || null,
      },
      issues: [
        ...sIssues.map((i) => ({ ...i, scope: "student" })),
        ...dIssues.map((i) => ({ ...i, scope: "deal" })),
      ],
      source: {
        file: reg.sourceFile || sourceRefs[0]?.sourceFile || "",
        sheet: reg.sourceSheet || sourceRefs[0]?.sourceSheet || "",
        rows: [...new Set(rows)].sort((a, b) => a - b),
      },
      student: student
        ? {
            id: String(student._id),
            fullName: student.fullName || "",
            firstName: student.firstName || "",
            lastName: student.lastName || "",
            englishName: student.englishName || "",
            realIdNumber: student.realIdNumber || "",
            gender: student.gender || "",
            title: student.title || "",
            mobile: student.mobile || "",
            email: student.email || "",
            city: student.city || "",
            street: student.street || "",
            houseNumber: student.houseNumber || "",
            apartment: student.apartment || "",
            zip: student.zip || "",
            addressNotes: student.addressNotes || "",
          }
        : null,
    });
  }
  return data;
}

/**
 * GET /api/data-review/deals
 * All the caller's deals in one shot (the client caches them and filters locally, so it
 * doesn't re-hit the server when switching tabs). `?scope=2026` limits to 2026 deals.
 */
export const listDeals = asyncHandler(async (req, res) => {
  const filter = { ...repFilter(req), recordType: "registration" };
  if (req.query.scope === "2026") filter.dealDate = { $gte: SINCE_2026 };

  const data = await buildDeals(filter);
  const done = data.filter((d) => d.review.status === "done").length;
  res.json({
    success: true,
    data,
    summary: {
      total: data.length,
      done,
      pending: data.length - done,
      shown: data.length,
    },
  });
});

/**
 * GET /api/data-review/deals/:id
 * One deal in the same shape - lets the client refresh a single card after a save
 * instead of reloading (and re-rendering) the whole list.
 */
export const getDeal = asyncHandler(async (req, res) => {
  const data = await buildDeals({ _id: req.params.id, ...repFilter(req) });
  if (!data.length) throw ApiError.notFound("העסקה לא נמצאה");
  res.json({ success: true, data: data[0] });
});

/** GET /api/data-review/cohorts - course cohorts for the assignment dropdown. */
export const listCohortOptions = asyncHandler(async (req, res) => {
  const cohorts = await CourseCohort.find({})
    .populate("catalogCourse", "name price")
    .populate("teachers", "fullName")
    .populate("teacher", "fullName")
    .sort({ createdAt: -1 })
    .lean();
  res.json({
    success: true,
    data: cohorts.map((c) => ({
      id: String(c._id),
      courseName: c.catalogCourse?.name || "(קורס נמחק)",
      price: c.catalogCourse?.price || 0,
      label: c.label || "",
      // מחזור יכול להיות עם יותר ממרצה אחד - מוצגים כ"א + ב"
      teacherName: teacherNamesOf(c),
      status: c.status,
      registrationOpen: c.registrationOpen,
      sessionsCount: (c.sessions || []).length,
      firstSession:
        (c.sessions || [])
          .map((s) => s.date)
          .sort((a, b) => new Date(a) - new Date(b))[0] || null,
    })),
  });
});

/**
 * GET /api/data-review/deals/:id/source
 * The ORIGINAL Excel rows for this deal WITH the reps' own colors/fonts.
 */
export const dealSource = asyncHandler(async (req, res) => {
  const reg = await Registration.findOne({
    _id: req.params.id,
    ...repFilter(req),
  }).lean();
  if (!reg) throw ApiError.notFound("העסקה לא נמצאה");
  const refs = await SourceRef.find({ deal: reg._id }).lean();
  const file = reg.sourceFile || refs[0]?.sourceFile || "";
  const sheet = reg.sourceSheet || refs[0]?.sourceSheet || "";
  const rows = [
    ...new Set(
      [reg.sourceRow, ...refs.map((r) => r.sourceRow)].filter(Boolean),
    ),
  ];
  if (!file || rows.length === 0) {
    return res.json({
      success: true,
      data: null,
      message: "לעסקה זו אין הפניה לקובץ מקור",
    });
  }

  // הקבצים המעודכנים של הנציגות. אומת שמספרי השורות זהים לקבצים הישנים (492/492
  // אצל מיכל, 127/128 אצל מורן - רק שורת הכותרת שונה), ולכן מציגים את המעודכן.
  const NEWER_FILE = {
    "מיכל.xlsx": "מיכל - פרטי מרשמים.xlsx",
    "מורן.xlsx": "מורן פרטי נרשמים.xlsx",
  };
  const wanted = rows.slice(0, 30);
  const preferred = NEWER_FILE[file] || file;

  const fetchRows = (f) =>
    SourceRow.find({ file: f, row: { $in: [1, ...wanted] } })
      .select("file sheet row cells")
      .lean();

  let docs = await fetchRows(preferred);
  let usedFile = preferred;
  if (!docs.some((d) => d.row !== 1) && preferred !== file) {
    docs = await fetchRows(file); // הקובץ המעודכן לא מכיל את השורה - חוזרים לישן
    usedFile = file;
  }

  if (docs.length) {
    // כותרת: אם בקובץ המעודכן תא הכותרת "זבל" (למשל מחרוזת נקודה-פסיק שנשארה בקובץ),
    // משלימים אותו מהכותרת של הקובץ הישן - כדי שהכותרות יתאימו לעמודות.
    const isJunk = (t) => !String(t || "").trim() || !/[֐-׿\w]/.test(String(t));
    let header = docs.find((d) => d.row === 1)?.cells || [];
    if (header.some((c) => isJunk(c.v))) {
      const other = usedFile === file ? NEWER_FILE[file] : file;
      if (other) {
        const alt = await SourceRow.findOne({ file: other, row: 1 })
          .select("cells")
          .lean();
        if (alt?.cells?.length) {
          header = header.map((c, i) =>
            isJunk(c.v) && alt.cells[i] && !isJunk(alt.cells[i].v)
              ? alt.cells[i]
              : c,
          );
        }
      }
    }

    const body = docs
      .filter((d) => d.row !== 1)
      .sort((a, b) => a.row - b.row)
      .map((d) => ({ row: d.row, cells: d.cells }));
    if (body.length) {
      return res.json({
        success: true,
        data: {
          file: usedFile,
          sheet: docs[0].sheet || sheet || "",
          headers: header,
          rows: body,
          from: "mongo",
        },
      });
    }
  }

  try {
    const styled = await getStyledRows(file, sheet, wanted);
    res.json({ success: true, data: { ...styled, from: "xlsx" } });
  } catch (err) {
    res.json({ success: true, data: null, message: err.message });
  }
});

/** PUT /api/data-review/students/:id - update the student's details (validated). */
export const updateStudent = asyncHandler(async (req, res) => {
  const student = await Student.findById(req.params.id);
  if (!student) throw ApiError.notFound("תלמיד/ה לא נמצא/ה");

  // A rep may only edit a student she has a deal with.
  if (req.user?.role === "rep") {
    const owns = await Registration.exists({
      student: student._id,
      rep: req.user._id,
    });
    if (!owns) throw ApiError.forbidden("אין הרשאה לערוך תלמיד/ה זה");
  }

  const b = req.body || {};
  const id = cleanStr(b.realIdNumber);
  if (id && !isValidIsraeliId(id)) {
    throw ApiError.badRequest(
      "מספר תעודת הזהות אינו תקין (ספרת הביקורת אינה מתאימה)",
    );
  }
  const email = cleanStr(b.email).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw ApiError.badRequest("כתובת המייל אינה תקינה");
  }
  if (
    b.gender !== undefined &&
    b.gender &&
    !["male", "female"].includes(b.gender)
  ) {
    throw ApiError.badRequest("מין לא תקין");
  }
  if (
    b.title !== undefined &&
    b.title &&
    !["Mr.", "Ms.", "Mrs."].includes(b.title)
  ) {
    throw ApiError.badRequest("פנייה לא תקינה");
  }

  const FIELDS = [
    "firstName",
    "lastName",
    "englishName",
    "hebrewName",
    "mobile",
    "city",
    "street",
    "houseNumber",
    "apartment",
    "zip",
    "addressNotes",
  ];
  for (const f of FIELDS) if (b[f] !== undefined) student[f] = cleanStr(b[f]);
  const prevGender = student.gender;
  const prevTitle = student.title;
  // gender/title הם enum במודל - מחרוזת ריקה נכשלת בוולידציה, ולכן מציבים רק ערך אמיתי
  for (const f of ["gender", "title"]) {
    const v = cleanStr(b[f]);
    if (v) student[f] = v;
  }
  if (id) student.realIdNumber = id;
  if (email) student.email = email;
  // עקביות מין↔פנייה: השדה שהשתנה בבקשה מוביל (מין גובר כששניהם השתנו).
  // גבר ⇒ תמיד Mr.; אישה עם Mr. ישן ⇒ הפנייה מתרוקנת (בוחרים Ms./Mrs. מחדש);
  // Mr. ⇒ גבר; Ms./Mrs. ⇒ אישה. כך לא נשמרת סתירה בשום צירוף.
  const genderChanged = student.gender !== prevGender;
  const titleChanged = student.title !== prevTitle;
  if (genderChanged || !titleChanged) {
    if (student.gender === "male") student.title = "Mr.";
    else if (student.gender === "female" && student.title === "Mr.")
      student.title = undefined;
  } else {
    if (student.title === "Mr.") student.gender = "male";
    else if (["Ms.", "Mrs."].includes(student.title)) student.gender = "female";
  }
  const first = cleanStr(student.firstName);
  const last = cleanStr(student.lastName);
  if (first || last) student.fullName = [first, last].filter(Boolean).join(" ");

  await student.save();
  res.json({
    success: true,
    data: { id: String(student._id), fullName: student.fullName },
  });
});

/**
 * PUT /api/data-review/deals/:id/payments
 * Replace the deal's payment breakdown (the reps confirm/adjust the suggestion).
 * Validates against the deal total, then recomputes the money.
 */
export const updatePayments = asyncHandler(async (req, res) => {
  const reg = await Registration.findOne({
    _id: req.params.id,
    ...repFilter(req),
  });
  if (!reg) throw ApiError.notFound("העסקה לא נמצאה");

  const raw = Array.isArray(req.body?.payments) ? req.body.payments : null;
  if (!raw) throw ApiError.badRequest("חסרה רשימת תשלומים");
  if (raw.length === 0) throw ApiError.badRequest("יש להזין לפחות תשלום אחד");
  if (raw.length > 60) throw ApiError.badRequest("יותר מדי תשלומים");

  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const payments = raw.map((p, i) => {
    const amount = round2(p.amount);
    if (!(amount > 0))
      throw ApiError.badRequest(`סכום לא תקין בתשלום ${i + 1}`);
    const method = PAY_METHODS.includes(p.method) ? p.method : null;
    if (!method)
      throw ApiError.badRequest(`אמצעי תשלום לא תקין בתשלום ${i + 1}`);
    if (!p.dueDate) throw ApiError.badRequest(`חסר תאריך בתשלום ${i + 1}`);
    const dueDate = new Date(p.dueDate);
    if (Number.isNaN(dueDate.getTime()))
      throw ApiError.badRequest(`תאריך לא תקין בתשלום ${i + 1}`);
    const paid = Boolean(p.paid);
    // סתירה: אי אפשר לסמן "שולם" על תשלום שמועדו עוד לא הגיע
    if (paid && dueDate > endOfToday) {
      throw ApiError.badRequest(
        `תשלום ${i + 1} סומן כשולם אך נושא תאריך עתידי`,
      );
    }
    return {
      type: PAY_TYPES.includes(p.type) ? p.type : "one_time",
      amount,
      method,
      methodCategory: method,
      dueDate,
      paid,
      installments:
        Number(p.installments) > 1 ? Number(p.installments) : undefined,
      note: cleanStr(p.note) || undefined,
      confirmedByName: paid
        ? `${req.user?.name || ""} (עריכת נתונים)`
        : undefined,
      confirmedAt: paid ? new Date() : undefined,
    };
  });

  const sum = round2(payments.reduce((s, p) => s + p.amount, 0));

  // הסכום הקובע נלקח מהעסקה שבשרת - לא מגוף הבקשה, אחרת הבדיקה מאמתת את עצמה
  // ונציגה יכולה לשנות את מחיר העסקה (וההכנסה/הפרמיה) בבקשה מותאמת.
  // שינוי מחיר מותר למנהל בלבד, ורק לערך מספרי חיובי.
  let declaredTotal = null;
  if (req.body?.dealPrice !== undefined && req.user?.role === "manager") {
    const n = round2(req.body.dealPrice);
    if (!Number.isFinite(n) || n <= 0)
      throw ApiError.badRequest("מחיר עסקה אינו תקין");
    declaredTotal = n;
  }
  const hadExplicitPrice = reg.dealPrice > 0;
  const total =
    declaredTotal ?? round2(hadExplicitPrice ? reg.dealPrice : reg.totalAmount);
  const expected = round2(Math.max(total - (Number(reg.writeOff) || 0), 0));
  if (total > 0 && Math.abs(sum - expected) > 1) {
    throw ApiError.badRequest(
      expected === total
        ? `סך התשלומים (${sum}) חייב להשתוות לסכום העסקה (${total})`
        : `סך התשלומים (${sum}) חייב להשתוות ל-${expected} (עסקה ${total} בניכוי מחילה ${round2(reg.writeOff)})`,
    );
  }

  reg.payments = payments;
  // לא "מקפיאים" מחיר לעסקאות v2 שנוצרו בטופס - שם הסכום נגזר מהתשלומים בכוונה.
  if (declaredTotal !== null) reg.dealPrice = declaredTotal;
  else if (!hadExplicitPrice && reg.schemaVersion !== 2 && total > 0)
    reg.dealPrice = total;
  // מעבר לפורמט v2: הכסף נגזר מהתשלומים
  reg.schemaVersion = 2;
  // אמצעי התשלום הראשי = הדומינטי (כמו ב-registrationController), לא הראשון ברשימה
  const byMethod = payments.reduce(
    (m, p) => ({ ...m, [p.method]: (m[p.method] || 0) + 1 }),
    {},
  );
  reg.paymentCategory = Object.entries(byMethod).sort(
    (a, b) => b[1] - a[1],
  )[0][0];
  const spread = payments.find((p) => Number(p.installments) > 1);
  reg.installments = spread ? spread.installments : undefined; // לא משאירים ספירה מיושנת
  reg.noteEntries.push({
    text: "פירוט התשלומים עודכן בעמוד עריכת הנתונים",
    date: new Date(),
    ...(isRealUserId(req.user?._id) ? { by: req.user._id } : {}),
    byName: req.user?.name || "",
  });
  reg.recompute();
  await reg.save();

  res.json({
    success: true,
    data: {
      id: String(reg._id),
      totalAmount: reg.totalAmount,
      totalPaid: reg.totalPaid,
      outstanding: reg.outstanding,
      paymentStatus: reg.paymentStatus,
    },
  });
});

/** PUT /api/data-review/deals/:id/cohort - assign the deal to a course cohort. */
export const assignCohort = asyncHandler(async (req, res) => {
  const reg = await Registration.findOne({
    _id: req.params.id,
    ...repFilter(req),
  });
  if (!reg) throw ApiError.notFound("העסקה לא נמצאה");
  const cohortId = cleanStr(req.body?.cohort);
  if (!cohortId) throw ApiError.badRequest("יש לבחור מחזור קורס");
  const cohort = await CourseCohort.findById(cohortId).populate(
    "catalogCourse",
    "name",
  );
  if (!cohort) throw ApiError.badRequest("מחזור הקורס לא נמצא");

  // שומרים רק את השיוך עצמו. courseField/cohortLabel הם הערכים הקנוניים מהייבוא,
  // שעליהם מסתמכים סינונים, ייצוא והתאמת קורסים - לא דורסים אותם.
  // עסקת חבילה: החלפת המחזור הראשי מעדכנת גם את רשימת המחזורים (cohortsAll)
  if (reg.cohortsAll?.length) {
    const prev = String(reg.cohort || "");
    const next = reg.cohortsAll.map((c) =>
      String(c) === prev ? cohort._id : c,
    );
    reg.cohortsAll = [
      ...new Map(next.map((c) => [String(c), c])).values(),
    ];
  }
  reg.cohort = cohort._id;
  reg.noteEntries.push({
    text: `שויך למחזור: ${cohort.catalogCourse?.name || ""} ${cohort.label || ""}`.trim(),
    date: new Date(),
    ...(isRealUserId(req.user?._id) ? { by: req.user._id } : {}),
    byName: req.user?.name || "",
  });
  await reg.save();
  res.json({
    success: true,
    data: { id: String(reg._id), cohort: String(cohort._id) },
  });
});

/**
 * POST /api/data-review/deals/:id/approve  (body: { undo?: true })
 * Mark the deal as reviewed - only allowed once there are no outstanding issues.
 */
export const approveDeal = asyncHandler(async (req, res) => {
  const reg = await Registration.findOne({
    _id: req.params.id,
    ...repFilter(req),
  });
  if (!reg) throw ApiError.notFound("העסקה לא נמצאה");

  if (req.body?.undo) {
    reg.dataReview = { status: "pending" };
    await reg.save();
    return res.json({
      success: true,
      data: { id: String(reg._id), status: "pending" },
    });
  }

  const student = reg.student
    ? await Student.findById(reg.student).lean()
    : null;
  const issues = [
    ...studentIssues(student).map((i) => i.label),
    ...dealIssues(reg.toObject()).map((i) => i.label),
  ];
  if (issues.length) {
    throw ApiError.badRequest(
      `לא ניתן לאשר - חסרים נתונים: ${issues.join("; ")}`,
    );
  }

  reg.dataReview = {
    status: "done",
    ...(isRealUserId(req.user?._id) ? { by: req.user._id } : {}),
    byName: req.user?.name || "",
    at: new Date(),
  };
  await reg.save();
  res.json({ success: true, data: { id: String(reg._id), status: "done" } });
});
