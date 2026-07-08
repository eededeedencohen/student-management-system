import Student from '../models/Student.js';
import Registration from '../models/Registration.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { splitName } from '../utils/normalize.js';

/** Clamp pagination params: page>=1, 1<=limit<=500 (default 50). */
const parsePaging = (query) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  let limit = parseInt(query.limit, 10) || 50;
  if (limit < 1) limit = 50;
  if (limit > 500) limit = 500;
  return { page, limit, skip: (page - 1) * limit };
};

/** Escape user input before using it inside a RegExp. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whitelist of sortable columns (?sortBy=) → the aggregated field they map to. */
const STUDENT_SORT_FIELDS = {
  fullName: 'fullName',
  paid: 'totalPaid', // נגבה
  future: 'totalOutstanding', // עתידי (יתרה לגבייה)
  total: 'totalDeals', // סה"כ עסקאות
  deals: 'dealsCount', // מספר עסקאות
};

/**
 * GET /api/students
 * חיפוש תלמידים: ?q regex על fullName / idNumber / mobile / email.
 * מצרף לכל תלמיד/ה סכומים כספיים מצטברים מהעסקאות (recordType='registration'):
 *   totalPaid (נגבה) · totalOutstanding (עתידי) · totalDeals (סה"כ) · dealsCount.
 * תומך במיון ?sortBy=fullName|paid|future|total|deals & ?order=asc|desc.
 * מחזיר { data, total, page, pages }.
 */
export const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePaging(req.query);
  const match = {};

  const q = (req.query.q || '').toString().trim();
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    match.$or = [
      { fullName: rx },
      { idNumber: rx },
      { mobile: rx },
      { email: rx },
    ];
  }

  const sortField = STUDENT_SORT_FIELDS[req.query.sortBy] || 'fullName';
  const dir = req.query.order === 'desc' ? -1 : 1;
  // Break ties by name so ordering is stable when a financial column has equal values.
  const sortSpec =
    sortField === 'fullName' ? { fullName: dir } : { [sortField]: dir, fullName: 1 };

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: 'registrations',
        localField: '_id',
        foreignField: 'student',
        as: 'regs',
      },
    },
    {
      // Only true sales count toward the money totals — collection follow-ups are
      // already folded into their parent deal (counting them would double-count).
      $addFields: {
        deals: {
          $filter: {
            input: '$regs',
            as: 'r',
            cond: { $eq: ['$$r.recordType', 'registration'] },
          },
        },
      },
    },
    {
      $addFields: {
        totalPaid: { $sum: '$deals.totalPaid' },
        totalOutstanding: { $sum: '$deals.outstanding' },
        totalDeals: { $sum: '$deals.totalAmount' },
        dealsCount: { $size: '$deals' },
      },
    },
    { $project: { regs: 0, deals: 0 } },
    { $sort: sortSpec },
    { $skip: skip },
    { $limit: limit },
  ];

  const [data, total] = await Promise.all([
    Student.aggregate(pipeline).collation({ locale: 'he' }),
    Student.countDocuments(match),
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
 * GET /api/students/:id
 * תלמיד/ה + כל הרישומים שלו/ה (העסקות), ממוין לפי תאריך עסקה יורד.
 */
export const getOne = asyncHandler(async (req, res) => {
  const student = await Student.findById(req.params.id);
  if (!student) throw ApiError.notFound('תלמיד/ה לא נמצא/ה');

  const registrations = await Registration.find({ student: student._id }).sort({
    dealDate: -1,
  });

  res.json({ success: true, data: { student, registrations } });
});

/**
 * POST /api/students
 * יצירת תלמיד/ה. fullName חובה; firstName/lastName מושלמים מ-fullName אם חסרים.
 */
export const create = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const fullName = (b.fullName || '').toString().trim();
  if (!fullName) throw ApiError.badRequest('שם מלא הוא שדה חובה');

  const { firstName, lastName } = splitName(fullName);

  const student = await Student.create({
    fullName,
    firstName: b.firstName ?? firstName,
    lastName: b.lastName ?? lastName,
    hebrewName: b.hebrewName,
    englishName: b.englishName,
    idNumber: b.idNumber,
    mobile: b.mobile,
    email: b.email,
    city: b.city,
    street: b.street,
    houseNumber: b.houseNumber,
    apartment: b.apartment,
    notes: b.notes,
  });

  res.status(201).json({ success: true, data: student });
});

/**
 * PUT /api/students/:id
 * עדכון פרטי תלמיד/ה. רק שדות מותרים מתעדכנים.
 */
export const update = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const allowed = [
    'fullName',
    'firstName',
    'lastName',
    'hebrewName',
    'englishName',
    'idNumber',
    'mobile',
    'email',
    'city',
    'street',
    'houseNumber',
    'apartment',
    'notes',
  ];

  const updates = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(b, key)) updates[key] = b[key];
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, 'fullName') &&
    !String(updates.fullName || '').trim()
  ) {
    throw ApiError.badRequest('שם מלא לא יכול להיות ריק');
  }

  const student = await Student.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true,
  });
  if (!student) throw ApiError.notFound('תלמיד/ה לא נמצא/ה');

  res.json({ success: true, data: student });
});

/**
 * DELETE /api/students/:id
 * מחיקת מסמך התלמיד/ה. הרישומים נשארים (משמרים studentName גולמי).
 */
export const remove = asyncHandler(async (req, res) => {
  const student = await Student.findByIdAndDelete(req.params.id);
  if (!student) throw ApiError.notFound('תלמיד/ה לא נמצא/ה');

  res.json({ success: true, data: { _id: student._id } });
});
