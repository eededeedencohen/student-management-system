import Registration from "../models/Registration.js";
import Student from "../models/Student.js";
import User from "../models/User.js";
import Course from "../models/Course.js";
import Lead from "../models/Lead.js";
import PaymentReceipt from "../models/PaymentReceipt.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { parseDateQuery } from "../utils/dateRanges.js";
import { applySince } from "../utils/dataScope.js";
import {
  parseNumber,
  parsePaymentMethod,
  splitName,
  cleanStr,
} from "../utils/normalize.js";

/** Escape a user string so it can be safely used inside a RegExp. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Clamp pagination params: page>=1, 1<=limit<=500 (default 50). */
const paging = (query) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 500);
  return { page, limit, skip: (page - 1) * limit };
};

/** Whitelist of sortable fields (?sortBy=) so clients can't sort by arbitrary keys. */
const SORT_FIELDS = [
  "dealDate",
  "sourceRow",
  "totalAmount",
  "outstanding",
  "studentName",
  "createdAt",
];

/**
 * Build a Mongo sort spec from ?sortBy/?order. Default: newest deals first.
 * sourceRow = the original row number in the source Excel file; we add sourceFile
 * + _id as tie-breakers so the order is stable and groups cleanly per file.
 */
const buildSort = (query) => {
  const by = SORT_FIELDS.includes(query.sortBy) ? query.sortBy : null;
  const dir = query.order === "asc" ? 1 : -1;
  if (!by) return { dealDate: -1, createdAt: -1 };
  if (by === "sourceRow") return { sourceRow: dir, sourceFile: dir, _id: 1 };
  return { [by]: dir, _id: 1 };
};

/**
 * GET /api/registrations
 * Filters: ?rep|?repId, ?course, ?courseField, ?paymentStatus, ?recordType,
 * ?needsReview(true/false), ?q (studentName regex), date via parseDateQuery on dealDate.
 * Rep-scoped (req.scopeRepId). Returns { data, total, page, pages }.
 */
export const list = asyncHandler(async (req, res) => {
  const filter = {};

  // --- rep scoping: reps are locked to their own id; managers may pass ?rep/?repId ---
  if (req.scopeRepId) {
    filter.rep = req.scopeRepId;
  } else {
    const repId = req.query.repId || req.query.rep;
    if (repId) filter.rep = repId;
  }

  if (req.query.course) filter.course = req.query.course;
  if (req.query.courseField) filter.courseField = req.query.courseField;
  if (req.query.paymentStatus) {
    filter.paymentStatus = req.query.paymentStatus;
    // סינון לפי סטטוס תשלום מדבר על עסקאות אמת - עסקה מבוטלת (יתרה 0 דרך writeOff)
    // לא "שולמה"; מי שרוצה מבוטלות בוחר סוג רשומה "מבוטל" במפורש.
    if (!req.query.recordType)
      filter.recordType = { $nin: ["cancelled", "refund"] };
  }
  if (req.query.recordType) filter.recordType = req.query.recordType;
  if (req.query.needsReview !== undefined) {
    filter.needsReview = req.query.needsReview === "true";
  }
  // ?reconciled=false → only deals whose payments don't reconcile (paid+future ≠ total)
  if (req.query.reconciled === "false") filter.reconciled = false;
  if (req.query.q) {
    filter.studentName = { $regex: escapeRegex(req.query.q), $options: "i" };
  }

  // תאריך עסקה - date filter on dealDate when from/to/period supplied
  const dateFilter = parseDateQuery(req.query);
  if (dateFilter) filter.dealDate = dateFilter;
  applySince(req, filter); // מוד "מ-2026 בלבד"

  const { page, limit, skip } = paging(req.query);

  const [data, total] = await Promise.all([
    Registration.find(filter)
      .sort(buildSort(req.query)) // default newest first; ?sortBy=sourceRow&order=asc
      .skip(skip)
      .limit(limit)
      .populate("rep", "name")
      .populate("course", "name field"),
    Registration.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data,
    total,
    page,
    pages: Math.max(Math.ceil(total / limit), 1),
  });
});

/**
 * GET /api/registrations/debtors
 * חייבים - registrations with outstanding>0 regardless of recordType
 * (intentionally includes advertising/collection_followup/other, per convention #6,
 * since this endpoint is explicitly about outstanding balances). Rep-scoped.
 */
export const debtors = asyncHandler(async (req, res) => {
  const filter = { outstanding: { $gt: 0 } };
  applySince(req, filter); // מוד "מ-2026 בלבד"

  if (req.scopeRepId) {
    filter.rep = req.scopeRepId;
  } else {
    const repId = req.query.repId || req.query.rep;
    if (repId) filter.rep = repId;
  }

  const data = await Registration.find(filter)
    .sort({ outstanding: -1 })
    .populate("rep", "name")
    .populate("course", "name field");

  res.json({ success: true, data });
});

/** GET /api/registrations/:id - populate rep, course, student. */
export const detail = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id)
    .populate("rep", "name")
    .populate("course", "name field")
    .populate("student");
  if (!reg) throw ApiError.notFound("הרישום לא נמצא");

  // reps may only view their own registrations
  if (req.scopeRepId && String(reg.rep?._id || reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אין הרשאה לצפות ברישום זה");
  }

  res.json({ success: true, data: reg });
});

/**
 * Find an existing Student (by fullName + idNumber when available) or create one.
 * Returns the Student document.
 */
/** Next sequential studentNumber (1..N) for a newly created student. */
const nextStudentNumber = async () => {
  const top = await Student.findOne({ studentNumber: { $ne: null } })
    .sort({ studentNumber: -1 })
    .select("studentNumber")
    .lean();
  return (top?.studentNumber || 0) + 1;
};

const findOrCreateStudent = async ({ studentName, idNumber, mobile }) => {
  const fullName = cleanStr(studentName);
  const id = cleanStr(idNumber);
  const phone = cleanStr(mobile);
  if (!fullName) return null;

  const query = { fullName };
  if (id) query.idNumber = id;
  let student = await Student.findOne(query);
  if (!student) {
    const { firstName, lastName } = splitName(fullName);
    student = await Student.create({
      fullName,
      idNumber: id || undefined,
      firstName,
      lastName,
      mobile: phone || undefined,
      studentNumber: await nextStudentNumber(),
    });
  } else if (phone && !student.mobile) {
    student.mobile = phone; // backfill a phone we learned from the lead
    await student.save();
  }
  return student;
};

/**
 * POST /api/registrations
 * Accept full body. Find-or-create Student from studentName when no student id given.
 * Resolve repName from the rep user. recompute() before save.
 */
export const create = asyncHandler(async (req, res) => {
  const body = req.body || {};

  // reps may only create registrations for themselves
  let repId = body.rep;
  if (req.scopeRepId) repId = req.scopeRepId;

  // --- student: use given id, else find-or-create from studentName ---
  let studentId = body.student;
  if (!studentId && body.studentName) {
    const student = await findOrCreateStudent({
      studentName: body.studentName,
      idNumber: body.idNumber,
      mobile: body.phone, // when converting a lead, seed the student's phone
    });
    if (student) studentId = student._id;
  }

  // --- repName: resolve from rep user when possible ---
  let repName = cleanStr(body.repName);
  if (repId) {
    const repUser = await User.findById(repId).select("name");
    if (repUser) repName = repUser.name;
  }

  // ================= v2: clean deal entered via the new form =================
  // total & status are DERIVED from the payments list (see recompute); the client
  // guarantees Σpayments = course price × (1 − discount).
  if (Number(body.schemaVersion) === 2) {
    const uid =
      req.user?._id && req.user._id !== "admin-token"
        ? req.user._id
        : undefined;
    const uname = req.user?.name || "";
    const METHODS = [
      "credit",
      "ern",
      "cash",
      "transfer",
      "financing",
      "combined",
      "other",
    ];
    const TYPES = ["advance", "installment", "one_time"];

    let courseDoc = null;
    if (body.course)
      courseDoc = await Course.findById(body.course).select(
        "name field cohortLabel",
      );

    const payments = (Array.isArray(body.payments) ? body.payments : []).map(
      (p) => {
        const paid = Boolean(p.paid);
        const method = METHODS.includes(p.method) ? p.method : "credit";
        return {
          type: TYPES.includes(p.type) ? p.type : "one_time",
          amount: parseNumber(p.amount),
          method,
          methodCategory: method,
          dueDate: p.dueDate ? new Date(p.dueDate) : undefined,
          paid,
          // פריסת אשראי מגיעה מהטופס כרשומה אחת משולמת עם מספר התשלומים כמטא-נתון
          installments: p.installments
            ? parseNumber(p.installments)
            : undefined,
          note: cleanStr(p.label) || undefined,
          confirmedBy: paid ? uid : undefined,
          confirmedByName: paid ? uname : undefined,
          confirmedAt: paid ? new Date() : undefined,
        };
      },
    );

    // dominant category for cash-flow (which reads deal.paymentCategory)
    const catCount = {};
    for (const p of payments)
      if (p.method) catCount[p.method] = (catCount[p.method] || 0) + 1;
    const dominant = Object.entries(catCount).sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0];

    const noteEntries = [];
    const noteText = cleanStr(body.notes);
    if (noteText)
      noteEntries.push({
        text: noteText,
        date: new Date(),
        by: uid,
        byName: uname,
      });
    if (Array.isArray(body.noteEntries)) {
      for (const n of body.noteEntries) {
        const t = cleanStr(n.text);
        if (t)
          noteEntries.push({
            text: t,
            date: n.date ? new Date(n.date) : new Date(),
            byName: cleanStr(n.byName),
          });
      }
    }

    const reg = new Registration({
      schemaVersion: 2,
      student: studentId,
      studentName: cleanStr(body.studentName),
      lead: body.lead || undefined,
      rep: repId,
      repName,
      course: body.course || undefined,
      courseRaw: cleanStr(body.courseRaw) || courseDoc?.name,
      courseField: cleanStr(body.courseField) || courseDoc?.field,
      cohortLabel: cleanStr(body.cohortLabel) || courseDoc?.cohortLabel,
      dealDate: body.dealDate ? new Date(body.dealDate) : new Date(),
      discountPercent: parseNumber(body.discountPercent),
      payments,
      paymentCategory: dominant,
      noteEntries,
      recordType: "registration",
    });
    reg.recompute(); // derives totalAmount/totalPaid/outstanding/status/nextPaymentDate
    await reg.save();

    // אסמכתאות העברה בנקאית שצורפו כבר בטופס היצירה (אופציונלי)
    if (await attachCreationReceipts(reg, body.payments || [], uname)) {
      await reg.save();
    }

    // Close the originating lead: mark it "won" and link it to this deal.
    if (body.lead) {
      const lead = await Lead.findById(body.lead);
      if (lead && (!req.scopeRepId || String(lead.rep) === req.scopeRepId)) {
        lead.status = "won";
        lead.convertedRegistration = reg._id;
        await lead.save();
      }
    }
    return res.status(201).json({ success: true, data: reg });
  }

  // --- payment method normalisation (keeps raw, derives category/installments) ---
  const pm = parsePaymentMethod(body.primaryPaymentMethod);

  const reg = new Registration({
    student: studentId,
    studentName: cleanStr(body.studentName),
    idNumber: cleanStr(body.idNumber),
    rep: repId,
    repName,
    registeredByRaw: cleanStr(body.registeredByRaw),
    course: body.course,
    courseRaw: cleanStr(body.courseRaw),
    courseField: cleanStr(body.courseField),
    cohortLabel: cleanStr(body.cohortLabel),

    dealDate: body.dealDate ? new Date(body.dealDate) : undefined,
    dealDateRaw: cleanStr(body.dealDateRaw),
    dateAssumed: Boolean(body.dateAssumed),

    totalAmount: parseNumber(body.totalAmount),
    amountExVat:
      body.amountExVat !== undefined
        ? parseNumber(body.amountExVat)
        : undefined,
    vatAmount:
      body.vatAmount !== undefined ? parseNumber(body.vatAmount) : undefined,
    advancePaid: parseNumber(body.advancePaid),
    balanceDue: parseNumber(body.balanceDue),
    finalBalance: parseNumber(body.finalBalance),
    payments: Array.isArray(body.payments) ? body.payments : [],
    primaryPaymentMethod: pm.raw || cleanStr(body.primaryPaymentMethod),
    paymentCategory: pm.category || body.paymentCategory,
    installments:
      body.installments !== undefined
        ? parseNumber(body.installments)
        : pm.installments,
    nextPaymentDate: body.nextPaymentDate
      ? new Date(body.nextPaymentDate)
      : undefined,
    nextPaymentNote: cleanStr(body.nextPaymentNote),

    checklist: body.checklist || {},

    recordType: body.recordType || "registration",
    needsReview: Boolean(body.needsReview),
    notes: cleanStr(body.notes),
  });

  reg.recompute(); // derive totalPaid/outstanding/paymentStatus/checklistComplete
  await reg.save();

  res.status(201).json({ success: true, data: reg });
});

/**
 * PUT /api/registrations/:id
 * Update allowed fields. If payments/checklist/amounts changed -> recompute() before save.
 */
export const update = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id);
  if (!reg) throw ApiError.notFound("הרישום לא נמצא");

  // reps may only edit their own registrations
  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אין הרשאה לערוך רישום זה");
  }

  const body = req.body || {};

  // fields that, when present, trigger a money/status recompute
  const moneyFields = [
    "totalAmount",
    "amountExVat",
    "vatAmount",
    "advancePaid",
    "balanceDue",
    "finalBalance",
    "payments",
    "checklist",
  ];

  // simple string/ref fields that can be overwritten directly
  const directFields = [
    "studentName",
    "idNumber",
    "registeredByRaw",
    "courseRaw",
    "courseField",
    "cohortLabel",
    "dealDateRaw",
    "primaryPaymentMethod",
    "paymentCategory",
    "nextPaymentNote",
    "recordType",
    "notes",
  ];

  let needsRecompute = false;

  for (const f of directFields) {
    if (body[f] !== undefined) reg[f] = cleanStr(body[f]);
  }

  // refs / scalars handled explicitly
  if (body.student !== undefined) reg.student = body.student || undefined;
  if (body.course !== undefined) reg.course = body.course || undefined;
  if (body.installments !== undefined)
    reg.installments = parseNumber(body.installments);
  if (body.dateAssumed !== undefined)
    reg.dateAssumed = Boolean(body.dateAssumed);
  if (body.needsReview !== undefined)
    reg.needsReview = Boolean(body.needsReview);
  if (body.dealDate !== undefined)
    reg.dealDate = body.dealDate ? new Date(body.dealDate) : undefined;
  if (body.nextPaymentDate !== undefined) {
    reg.nextPaymentDate = body.nextPaymentDate
      ? new Date(body.nextPaymentDate)
      : undefined;
  }

  // rep change (managers only - reps are scoped to themselves)
  if (body.rep !== undefined && !req.scopeRepId) {
    reg.rep = body.rep || undefined;
    const repUser = body.rep
      ? await User.findById(body.rep).select("name")
      : null;
    reg.repName = repUser ? repUser.name : cleanStr(body.repName);
  } else if (body.repName !== undefined && !req.scopeRepId) {
    reg.repName = cleanStr(body.repName);
  }

  // money fields (parsed) + recompute trigger
  for (const f of moneyFields) {
    if (body[f] === undefined) continue;
    needsRecompute = true;
    if (f === "payments")
      reg.payments = Array.isArray(body.payments)
        ? body.payments
        : reg.payments;
    else if (f === "checklist")
      reg.checklist = {
        ...(reg.checklist?.toObject?.() || reg.checklist),
        ...body.checklist,
      };
    else reg[f] = parseNumber(body[f]);
  }

  if (needsRecompute) reg.recompute();
  await reg.save();

  res.json({ success: true, data: reg });
});

/**
 * PUT /api/registrations/:id/payment-plan  (v2)
 * החלפה מלאה של תוכנית התשלומים של עסקה קיימת, באותם חוקים כמו יצירת עסקה:
 * סך כל התשלומים חייב להשתוות למחיר העסקה (בניכוי הנחה/מחילה שנרשמה כ-writeOff).
 * תשלום שכבר סומן כשולם נעול — סכום/אמצעי/תאריך אינם ניתנים לשינוי, ומחיקתו
 * דורשת אישור מפורש (confirmRemovePaid) — כך כסף שנגבה לא "נעלם" בטעות.
 */
export const updatePaymentPlan = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id);
  if (!reg) throw ApiError.notFound("העסקה לא נמצאה");
  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אפשר לערוך תשלומים רק בעסקאות שלך");
  }
  if (reg.schemaVersion !== 2) {
    throw ApiError.badRequest(
      "עריכת תוכנית תשלומים זמינה לעסקאות מהפורמט החדש בלבד — עסקה ישנה משלימים קודם בעמוד עריכת הנתונים",
    );
  }

  const METHODS = [
    "credit",
    "ern",
    "cash",
    "transfer",
    "financing",
    "combined",
    "other",
  ];
  const TYPES = ["advance", "installment", "one_time"];
  const incoming = Array.isArray(req.body?.payments) ? req.body.payments : null;
  if (!incoming || incoming.length === 0) {
    throw ApiError.badRequest(
      "נדרשת רשימת תשלומים — כל עוד העסקה קיימת התוכנית חייבת לכסות את מלוא הסכום",
    );
  }

  // מחיר העסקה מקובע: עריכה משנה איך משלמים, לעולם לא כמה משלמים
  const priceBase =
    reg.dealPrice > 0 ? reg.dealPrice : Number(reg.totalAmount) || 0;
  const writeOff = Number(reg.writeOff) || 0;
  const target = Math.max(priceBase - writeOff, 0);

  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const uid =
    req.user?._id && req.user._id !== "admin-token" ? req.user._id : undefined;
  const uname = req.user?.name || "";
  const dayOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

  const existingById = new Map(
    (reg.payments || []).map((p) => [String(p._id), p]),
  );
  const seenIds = new Set();
  const rows = [];

  incoming.forEach((p, i) => {
    const rowNo = i + 1;
    const amount = parseNumber(p.amount);
    if (!(amount > 0))
      throw ApiError.badRequest(`שורה ${rowNo}: סכום התשלום חייב להיות חיובי`);
    const method = METHODS.includes(p.method) ? p.method : null;
    if (!method)
      throw ApiError.badRequest(`שורה ${rowNo}: יש לבחור אמצעי תשלום`);
    const dueDate = p.dueDate ? new Date(p.dueDate) : null;
    if (!dueDate || Number.isNaN(+dueDate))
      throw ApiError.badRequest(`שורה ${rowNo}: יש לקבוע תאריך לתשלום`);
    const paid = Boolean(p.paid);
    if (paid && dueDate > endOfToday) {
      throw ApiError.badRequest(
        `שורה ${rowNo}: תשלום שסומן כשולם לא יכול לשאת תאריך עתידי`,
      );
    }
    const type = TYPES.includes(p.type) ? p.type : "one_time";
    const instNum = parseInt(p.installments, 10);
    const installments =
      Number.isInteger(instNum) && instNum >= 1
        ? Math.min(instNum, 60)
        : undefined;
    const note = cleanStr(p.note) || undefined;

    const prev = p._id ? existingById.get(String(p._id)) : null;
    if (p._id && !prev) {
      throw ApiError.badRequest(
        `שורה ${rowNo}: התשלום המקורי כבר לא קיים בעסקה — רענן את העמוד ונסה שוב`,
      );
    }
    if (prev) seenIds.add(String(prev._id));

    if (prev && prev.paid && paid) {
      // תשלום ששולם: כשהערכים לא השתנו נשמר האישור המקורי (מי אישר ומתי).
      // שינוי סכום/אמצעי/תאריך אפשרי רק אחרי פתיחת הנעילה בממשק — ואז האישור
      // נחתם מחדש על שם העורך הנוכחי, כדי שתמיד יהיה ברור מי ערב לכסף הזה.
      const sameAmount = Math.abs((prev.amount || 0) - amount) < 0.01;
      const sameMethod = (prev.method || "") === method;
      const sameDate = dayOf(prev.dueDate) === dayOf(dueDate);
      const untouched = sameAmount && sameMethod && sameDate;
      rows.push({
        _id: prev._id,
        type,
        amount,
        method,
        methodCategory: method,
        dueDate,
        paid: true,
        confirmedBy: untouched ? prev.confirmedBy : uid,
        confirmedByName: untouched ? prev.confirmedByName : uname,
        confirmedAt: untouched ? prev.confirmedAt : new Date(),
        installments: installments ?? prev.installments,
        date: prev.date,
        dateRaw: prev.dateRaw,
        kind: prev.kind,
        source: prev.source,
        note: note ?? prev.note,
      });
      return;
    }

    rows.push({
      ...(prev
        ? {
            _id: prev._id,
            date: prev.date,
            dateRaw: prev.dateRaw,
            kind: prev.kind,
            source: prev.source,
          }
        : {}),
      type,
      amount,
      method,
      methodCategory: method,
      dueDate,
      paid,
      installments,
      note,
      // תשלום שהפך לשולם בעריכה זו נחתם על שם העורך; ביטול סימון מנקה את האישור
      confirmedBy: paid ? uid : undefined,
      confirmedByName: paid ? uname : undefined,
      confirmedAt: paid ? new Date() : undefined,
    });
  });

  const removedPaid = (reg.payments || []).filter(
    (p) => p.paid && !seenIds.has(String(p._id)),
  );
  if (removedPaid.length > 0 && req.body?.confirmRemovePaid !== true) {
    const total = removedPaid.reduce((s, p) => s + (p.amount || 0), 0);
    throw ApiError.badRequest(
      `הרשימה מוחקת ${removedPaid.length} תשלומים שכבר סומנו כשולמו (${Math.round(total).toLocaleString("he-IL")} ₪) — נדרש אישור מפורש למחיקה`,
    );
  }

  const sum = rows.reduce((s, r) => s + r.amount, 0);
  // עסקה נדירה בלי מחיר מוגדר: התוכנית הראשונה שנשמרת קובעת אותו
  const effTarget = target > 0 ? target : sum;
  if (Math.abs(sum - effTarget) > 0.5) {
    throw ApiError.badRequest(
      `סך התשלומים (${Math.round(sum).toLocaleString("he-IL")} ₪) חייב להשתוות לסכום העסקה (${Math.round(effTarget).toLocaleString("he-IL")} ₪)` +
        (writeOff > 0
          ? ` — המחיר בניכוי הנחה/מחילה של ${Math.round(writeOff).toLocaleString("he-IL")} ₪`
          : ""),
    );
  }

  reg.payments = rows;
  // קיבוע מחיר מפורש: מעכשיו recompute לא ייגזר מהתשלומים ולא יזוז בעריכות הבאות
  if (!(reg.dealPrice > 0)) reg.dealPrice = priceBase > 0 ? priceBase : sum;

  // אמצעי דומיננטי לתזרים (כמו ביצירת עסקה)
  const catCount = {};
  for (const r of rows) catCount[r.method] = (catCount[r.method] || 0) + 1;
  const dominant = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (dominant) reg.paymentCategory = dominant;

  // תיעוד ביומן ההערות של העסקה: מי שינה את התוכנית, מתי ולְמה
  reg.noteEntries = reg.noteEntries || [];
  reg.noteEntries.push({
    text: `תוכנית התשלומים עודכנה: ${rows.length} תשלומים בסך ${Math.round(sum).toLocaleString("he-IL")} ₪`,
    date: new Date(),
    by: uid,
    byName: uname,
  });

  reg.recompute();
  await reg.save();

  res.json({ success: true, data: reg });
});

/**
 * POST /api/registrations/:id/payments
 * Body { amount, method, date, kind, note }. Push payment, recompute(), save.
 */
export const addPayment = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id);
  if (!reg) throw ApiError.notFound("הרישום לא נמצא");

  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אין הרשאה לעדכן רישום זה");
  }

  const { amount, method, date, kind, note } = req.body || {};
  const amt = parseNumber(amount);
  if (!amt || amt <= 0) throw ApiError.badRequest("יש להזין סכום תשלום חיובי");

  const pm = parsePaymentMethod(method);
  reg.payments.push({
    amount: amt,
    method: cleanStr(method),
    methodCategory: pm.category || undefined,
    installments: pm.installments,
    date: date ? new Date(date) : new Date(),
    note: cleanStr(note),
    kind: ["advance", "balance", "extra"].includes(kind) ? kind : "balance",
  });

  reg.recompute();
  await reg.save();

  res.json({ success: true, data: reg });
});

/**
 * PATCH /api/registrations/:id/checklist
 * Merge partial checklist flags, recompute(), save.
 */
export const updateChecklist = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id);
  if (!reg) throw ApiError.notFound("הרישום לא נמצא");

  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אין הרשאה לעדכן רישום זה");
  }

  const allowed = [
    "signedTakanon",
    "addedToCourseWhatsapp",
    "addedToAlumniWhatsapp",
    "invoiceIssued",
  ];
  const current = reg.checklist?.toObject?.() || reg.checklist || {};
  const merged = { ...current };
  for (const key of allowed) {
    if (req.body?.[key] !== undefined) merged[key] = Boolean(req.body[key]);
  }
  reg.checklist = merged;

  reg.recompute();
  await reg.save();

  res.json({ success: true, data: reg });
});

/**
 * PATCH /api/registrations/:id/installments/:index/confirm
 * Mark a scheduled installment as collected (the ✓ action). Adds a payment and recomputes.
 * Permission: reps may confirm only their OWN deals; managers may confirm any.
 */
export const confirmInstallment = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id);
  if (!reg) throw ApiError.notFound("הרישום לא נמצא");
  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אפשר לאשר תשלומים רק בעסקאות שלך");
  }
  const idx = parseInt(req.params.index, 10);
  const item = (reg.installmentPlan || []).find((it) => it.index === idx);
  if (!item) throw ApiError.notFound("התשלום לא נמצא בלוח");

  if (item.status !== "paid") {
    const amount =
      req.body?.amount != null ? Number(req.body.amount) : item.amount;
    const date = req.body?.date ? new Date(req.body.date) : new Date();
    item.status = "paid";
    item.paidAt = date;
    item.amount = amount || item.amount;
    item.confirmedBy =
      req.user?._id && req.user._id !== "admin-token"
        ? req.user._id
        : undefined;
    item.confirmedByName = req.user?.name || "";
    reg.payments.push({
      amount: item.amount,
      method: item.method,
      methodCategory: item.method,
      date,
      kind: "balance",
      note: `אישור תשלום ${item.label}`,
      source: `אישור ידני במערכת · ${req.user?.name || "משתמש"} · ${new Date().toISOString().slice(0, 10)}`,
    });
    reg.recompute();
    await reg.save();
  }
  res.json({ success: true, data: reg });
});

/** PATCH /api/registrations/:id/installments/:index/unconfirm - undo a confirmation. */
export const unconfirmInstallment = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id);
  if (!reg) throw ApiError.notFound("הרישום לא נמצא");
  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אפשר לעדכן תשלומים רק בעסקאות שלך");
  }
  const idx = parseInt(req.params.index, 10);
  const item = (reg.installmentPlan || []).find((it) => it.index === idx);
  if (!item) throw ApiError.notFound("התשלום לא נמצא בלוח");

  if (item.status === "paid") {
    const note = `אישור תשלום ${item.label}`;
    const pi = reg.payments.findIndex((p) => p.note === note);
    if (pi >= 0) reg.payments.splice(pi, 1);
    item.status = "pending";
    item.paidAt = undefined;
    item.confirmedBy = undefined;
    item.confirmedByName = undefined;
    reg.recompute();
    await reg.save();
  }
  res.json({ success: true, data: reg });
});

/**
 * PATCH /api/registrations/:id/payments/:paymentId/pay  (v2)
 * Mark a single unified payment as collected ("סמן כשולם"). Records who confirmed it.
 * Permission: reps may confirm only their OWN deals; managers any.
 */
export const markPaymentPaid = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id);
  if (!reg) throw ApiError.notFound("העסקה לא נמצאה");
  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אפשר לאשר תשלומים רק בעסקאות שלך");
  }
  const p = reg.payments.id(req.params.paymentId);
  if (!p) throw ApiError.notFound("התשלום לא נמצא");
  if (!p.paid) {
    p.paid = true;
    p.confirmedBy =
      req.user?._id && req.user._id !== "admin-token"
        ? req.user._id
        : undefined;
    p.confirmedByName = req.user?.name || "";
    p.confirmedAt = new Date();
    if (req.body?.date) p.date = new Date(req.body.date);
    if (req.body?.amount != null) p.amount = Number(req.body.amount);
    reg.recompute();
    await reg.save();
  }
  res.json({ success: true, data: reg });
});

/** האם המחרוזת היא data-URL של תמונה (אסמכתא)? */
export const isImageDataUrl = (s) =>
  typeof s === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(s);

/**
 * שמירת אסמכתאות שצורפו כבר ביצירת העסקה (טופס פנימי/חיצוני).
 * rawPayments = המערך שהגיע מהקליינט (אותו סדר כמו reg.payments אחרי היצירה);
 * לכל תשלום עם receiptImageDataUrl נוצרת רשומת PaymentReceipt, ועל התשלום
 * נרשמים הדגל, המספר והחותם. מחזירה true אם צריך reg.save() נוסף.
 */
export async function attachCreationReceipts(reg, rawPayments, byName) {
  let changed = false;
  for (let i = 0; i < rawPayments.length && i < reg.payments.length; i += 1) {
    const raw = rawPayments[i] || {};
    const reference = cleanStr(raw.receiptReference);
    const image = isImageDataUrl(raw.receiptImageDataUrl)
      ? raw.receiptImageDataUrl
      : "";
    if (!reference && !image) continue;
    const p = reg.payments[i];
    if (image) {
      await PaymentReceipt.findOneAndUpdate(
        { registration: reg._id, paymentId: p._id },
        {
          $set: {
            imageDataUrl: image,
            byteLength: image.length,
            uploadedAt: new Date(),
            uploadedByName: byName || "",
          },
        },
        { upsert: true },
      );
      p.receiptImage = true;
    }
    if (reference) p.receiptReference = reference;
    p.receiptUploadedAt = new Date();
    p.receiptUploadedByName = byName || "";
    changed = true;
  }
  return changed;
}

/**
 * PUT /api/registrations/:id/payments/:paymentId/receipt  (v2)
 * צירוף/עדכון אסמכתת העברה בנקאית: מספר אסמכתא + תמונה (dataURL).
 * התמונה נשמרת ב-PaymentReceipt; על התשלום רק הדגל, המספר והחותם.
 * Permission: נציגה רק בעסקאות שלה; מנהל בכולן.
 */
export const setPaymentReceipt = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id);
  if (!reg) throw ApiError.notFound("העסקה לא נמצאה");
  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אפשר לעדכן אסמכתאות רק בעסקאות שלך");
  }
  const p = reg.payments.id(req.params.paymentId);
  if (!p) throw ApiError.notFound("התשלום לא נמצא");

  const reference = cleanStr(req.body?.reference);
  const imageDataUrl =
    typeof req.body?.imageDataUrl === "string" ? req.body.imageDataUrl : "";
  if (imageDataUrl && !isImageDataUrl(imageDataUrl))
    throw ApiError.badRequest("קובץ האסמכתא חייב להיות תמונה");
  if (imageDataUrl.length > 12 * 1024 * 1024)
    throw ApiError.badRequest("תמונת האסמכתא גדולה מדי (עד ~8MB)");
  const uname = req.user?.name || "";

  if (imageDataUrl) {
    await PaymentReceipt.findOneAndUpdate(
      { registration: reg._id, paymentId: p._id },
      {
        $set: {
          imageDataUrl,
          byteLength: imageDataUrl.length,
          uploadedAt: new Date(),
          uploadedByName: uname,
        },
      },
      { upsert: true },
    );
    p.receiptImage = true;
  }
  // שליחת reference (גם ריק) מעדכנת את המספר; אי-שליחה משאירה את הקיים
  if ("reference" in (req.body || {})) p.receiptReference = reference || undefined;
  p.receiptUploadedAt = new Date();
  p.receiptUploadedByName = uname;
  await reg.save();
  res.json({ success: true, data: reg });
});

/** GET /api/registrations/:id/payments/:paymentId/receipt - פרטי האסמכתא + התמונה. */
export const getPaymentReceipt = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id).select("rep payments");
  if (!reg) throw ApiError.notFound("העסקה לא נמצאה");
  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אין הרשאה לצפות באסמכתאות של עסקה זו");
  }
  const p = reg.payments.id(req.params.paymentId);
  if (!p) throw ApiError.notFound("התשלום לא נמצא");
  const doc = await PaymentReceipt.findOne({
    registration: reg._id,
    paymentId: p._id,
  }).lean();
  res.json({
    success: true,
    data: {
      reference: p.receiptReference || "",
      imageDataUrl: doc?.imageDataUrl || "",
      uploadedAt: p.receiptUploadedAt || doc?.uploadedAt || null,
      uploadedByName: p.receiptUploadedByName || doc?.uploadedByName || "",
    },
  });
});

/** PATCH /api/registrations/:id/payments/:paymentId/unpay - undo "סמן כשולם". */
export const unmarkPaymentPaid = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id);
  if (!reg) throw ApiError.notFound("העסקה לא נמצאה");
  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אפשר לעדכן תשלומים רק בעסקאות שלך");
  }
  const p = reg.payments.id(req.params.paymentId);
  if (!p) throw ApiError.notFound("התשלום לא נמצא");
  if (p.paid) {
    p.paid = false;
    p.confirmedBy = undefined;
    p.confirmedByName = undefined;
    p.confirmedAt = undefined;
    reg.recompute();
    await reg.save();
  }
  res.json({ success: true, data: reg });
});

/** DELETE /api/registrations/:id */
export const remove = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id);
  if (!reg) throw ApiError.notFound("הרישום לא נמצא");

  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אין הרשאה למחוק רישום זה");
  }

  await reg.deleteOne();
  res.json({ success: true, data: { _id: reg._id } });
});

/**
 * GET /api/registrations/:id/contract.pdf
 * מוריד את עותק ה-PDF החתום שנשמר לעסקה (נשמר אוטומטית אחרי חתימה).
 * נציגה יכולה להוריד רק מעסקאות שלה — כמו בצפייה ברישום.
 */
export const downloadContractPdf = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id).select("rep contract studentName");
  if (!reg) throw ApiError.notFound("הרישום לא נמצא");
  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אין הרשאה לצפות ברישום זה");
  }
  const { default: ContractPdf } = await import("../models/ContractPdf.js");
  const doc = await ContractPdf.findOne({ registration: reg._id }).lean();
  if (!doc?.pdfBase64) {
    throw ApiError.notFound("אין עותק PDF שמור לעסקה זו (נשמר אוטומטית בחתימות חדשות)");
  }
  const filename = doc.filename || `תקנון-${reg.studentName || "חוזה"}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  return res.send(Buffer.from(doc.pdfBase64, "base64"));
});

/**
 * POST /api/registrations/:id/contract
 * יצירת חוזה לעסקה קיימת (עסקאות ישנות שנוצרו בלי חוזה): טוקן + סטטוס pending.
 * אידמפוטנטי — אם כבר קיים חוזה, מחזיר את העסקה כמו שהיא. משם אפשר לחתום
 * דיגיטלית (קישור), להוריד PDF להדפסה, או להעלות עותק חתום סרוק.
 */
export const createContract = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id);
  if (!reg) throw ApiError.notFound("העסקה לא נמצאה");
  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אפשר ליצור חוזה רק בעסקאות שלך");
  }
  if (!reg.contract?.token) {
    const { randomBytes } = await import("crypto");
    const token = randomBytes(24).toString("base64url"); // 192 ביט - לא ניתן לניחוש
    reg.contract = { token, status: "pending", createdAt: new Date() };
    reg.noteEntries.push({
      text: `נוצר חוזה לעסקה (ידנית מעמוד הסטודנט) ע"י ${req.user?.name || "משתמש"}`,
      date: new Date(),
      byName: req.user?.name || "",
    });
    await reg.save();
  }
  const { default: ContractPdf } = await import("../models/ContractPdf.js");
  const pdfStored = Boolean(await ContractPdf.exists({ registration: reg._id }));
  res.status(201).json({
    success: true,
    data: { ...reg.toObject(), contractPdfStored: pdfStored },
  });
});

/**
 * POST /api/registrations/:id/contract/upload-signed
 * העלאת חוזה חתום ידנית (סריקה/צילום שהומרו ל-PDF בצד הלקוח). שומר את הקובץ
 * כעותק הרשמי (ContractPdf, פעם אחת בלבד) ומסמן את החוזה כחתום — בדיוק כמו
 * חתימה דיגיטלית: status=signed + checklist.signedTakanon.
 */
export const uploadSignedContract = asyncHandler(async (req, res) => {
  const reg = await Registration.findById(req.params.id);
  if (!reg) throw ApiError.notFound("העסקה לא נמצאה");
  if (req.scopeRepId && String(reg.rep) !== req.scopeRepId) {
    throw ApiError.forbidden("אפשר להעלות חוזה רק בעסקאות שלך");
  }

  const pdfBase64 = String(req.body?.pdfBase64 || "")
    .replace(/^data:application\/pdf;base64,/, "")
    .replace(/\s+/g, "");
  if (!pdfBase64 || pdfBase64.length < 1000)
    throw ApiError.badRequest("קובץ ה-PDF חסר או פגום");
  if (pdfBase64.length > 14_000_000)
    throw ApiError.badRequest("קובץ ה-PDF גדול מדי");
  // חייב להיות PDF אמיתי ("%PDF" = "JVBER" ב-base64) — לא בייטים שרירותיים
  if (!pdfBase64.startsWith("JVBER"))
    throw ApiError.badRequest("הקובץ אינו PDF תקין");

  const { default: ContractPdf } = await import("../models/ContractPdf.js");
  if (reg.contract?.status === "signed") {
    const exists = await ContractPdf.exists({ registration: reg._id });
    if (exists)
      throw ApiError.badRequest("החוזה כבר חתום וקיים לו עותק שמור");
  }

  // עסקה בלי חוזה: נוצר חוזה במקום (ההעלאה עצמה היא החתימה)
  if (!reg.contract?.token) {
    const { randomBytes } = await import("crypto");
    reg.contract = {
      token: randomBytes(24).toString("base64url"),
      status: "pending",
      createdAt: new Date(),
    };
  }

  const uname = req.user?.name || "משתמש";
  reg.contract.status = "signed";
  reg.contract.signedAt = reg.contract.signedAt || new Date();
  reg.contract.signerName =
    cleanStr(req.body?.signerName) || reg.studentName || "";
  reg.contract.signedVia = "upload";
  // כמו בחתימה דיגיטלית — סוגר אוטומטית את "נחתם תקנון" בצ'ק-ליסט
  reg.checklist = {
    ...(reg.checklist?.toObject?.() || reg.checklist || {}),
    signedTakanon: true,
  };
  reg.noteEntries.push({
    text: `הועלה חוזה חתום ידנית (סריקה/צילום) ע"י ${uname}`,
    date: new Date(),
    byName: uname,
  });

  const filename = `תקנון-מכללת-ספרא-${reg.studentName || "חוזה"}.pdf`;
  // $setOnInsert — העותק הראשון שנשמר הוא הקובע; אין דריסה (מניעת זיוף)
  await ContractPdf.findOneAndUpdate(
    { registration: reg._id },
    {
      $setOnInsert: {
        registration: reg._id,
        token: reg.contract.token,
        filename,
        pdfBase64,
        byteLength: pdfBase64.length,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  reg.recompute();
  await reg.save();
  res.json({
    success: true,
    data: { ...reg.toObject(), contractPdfStored: true },
  });
});
