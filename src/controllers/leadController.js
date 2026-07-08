import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import User from '../models/User.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { parseDateQuery } from '../utils/dateRanges.js';

/**
 * Leads controller (/api/leads) — ניהול לידים לחישוב אחוזי סגירה.
 * Reps see only their own leads (via scopeToRep -> req.scopeRepId);
 * managers see everything and may filter by ?repId/?rep.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** Resolve the rep filter: reps are forced to their own id; managers may pass ?rep/?repId. */
const resolveRepFilter = (req) => {
  if (req.scopeRepId) return req.scopeRepId; // rep: locked to self
  return req.query.repId || req.query.rep || null; // manager: optional filter
};

/** Look up a rep's display name to denormalize onto the lead (repName). */
const repNameFor = async (repId) => {
  if (!repId) return undefined;
  const user = await User.findById(repId).select('name').lean();
  return user?.name;
};

/**
 * GET /api/leads
 * Filters: ?rep/?repId (scoped), ?status, ?from&?to (on receivedDate).
 * Sorted newest receivedDate first.
 */
export const list = asyncHandler(async (req, res) => {
  const filter = {};

  const repId = resolveRepFilter(req);
  if (repId) filter.rep = repId;

  if (req.query.status) filter.status = req.query.status;

  // Date filtering applies to receivedDate for leads (not dealDate).
  const dateFilter = parseDateQuery(req.query);
  if (dateFilter) filter.receivedDate = dateFilter;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));

  const [data, total] = await Promise.all([
    Lead.find(filter)
      .sort({ receivedDate: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Lead.countDocuments(filter),
  ]);

  res.json({ success: true, data, total, page, pages: Math.ceil(total / limit) || 1 });
});

/**
 * POST /api/leads
 * Creates either an individual lead, or an aggregate count for a period
 * ({ isAggregate:true, count, periodStart, periodEnd, rep }).
 * repName is derived from the rep. Reps are forced to themselves.
 */
export const create = asyncHandler(async (req, res) => {
  const body = req.body || {};

  // Reps may only create leads for themselves; managers may target any rep.
  const repId = req.scopeRepId || body.rep || null;

  const payload = {
    rep: repId || undefined,
    repName: (await repNameFor(repId)) ?? body.repName,
    name: body.name,
    phone: body.phone,
    source: body.source,
    status: body.status,
    receivedDate: body.receivedDate,
    convertedRegistration: body.convertedRegistration,
    notes: body.notes,
  };

  if (body.isAggregate) {
    // Aggregate mode: a bulk count of leads received in a period.
    const count = parseInt(body.count, 10);
    if (!Number.isFinite(count) || count <= 0) {
      throw ApiError.badRequest('כמות לידים (count) חייבת להיות מספר חיובי במצב צבירה');
    }
    payload.isAggregate = true;
    payload.count = count;
    payload.periodStart = body.periodStart;
    payload.periodEnd = body.periodEnd;
  }

  const lead = await Lead.create(payload);
  res.status(201).json({ success: true, data: lead });
});

/** Load a lead enforcing rep scoping; throws notFound otherwise. */
const findScoped = async (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('ליד לא נמצא');
  const filter = { _id: req.params.id };
  if (req.scopeRepId) filter.rep = req.scopeRepId; // reps may only touch their own
  const lead = await Lead.findOne(filter);
  if (!lead) throw ApiError.notFound('ליד לא נמצא');
  return lead;
};

/**
 * PUT /api/leads/:id
 * Update mutable fields (notably status, convertedRegistration).
 */
export const update = asyncHandler(async (req, res) => {
  const lead = await findScoped(req);
  const body = req.body || {};

  const updatable = [
    'name',
    'phone',
    'source',
    'status',
    'receivedDate',
    'convertedRegistration',
    'isAggregate',
    'count',
    'periodStart',
    'periodEnd',
    'notes',
  ];
  for (const key of updatable) {
    if (body[key] !== undefined) lead[key] = body[key];
  }

  // Managers may reassign the rep; keep repName in sync.
  if (!req.scopeRepId && body.rep !== undefined) {
    lead.rep = body.rep || undefined;
    lead.repName = (await repNameFor(body.rep)) ?? body.repName ?? lead.repName;
  }

  await lead.save();
  res.json({ success: true, data: lead });
});

/** DELETE /api/leads/:id */
export const remove = asyncHandler(async (req, res) => {
  const lead = await findScoped(req);
  await lead.deleteOne();
  res.json({ success: true, data: { _id: lead._id } });
});

/**
 * GET /api/leads/stats
 * Per-rep close-rate stats. Filters: ?period or ?from&?to (on receivedDate), ?repId.
 * leads = sum(count) for aggregates + doc count for individuals.
 * won = status 'won' OR convertedRegistration set.
 * closeRate = won / leads (0 when no leads).
 */
export const stats = asyncHandler(async (req, res) => {
  const match = {};

  const repId = resolveRepFilter(req);
  if (repId) match.rep = new mongoose.Types.ObjectId(repId);

  const dateFilter = parseDateQuery(req.query);
  if (dateFilter) match.receivedDate = dateFilter;

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: '$rep',
        repName: { $first: '$repName' },
        // aggregates contribute their count; individuals contribute 1.
        leads: {
          $sum: {
            $cond: [{ $eq: ['$isAggregate', true] }, { $ifNull: ['$count', 0] }, 1],
          },
        },
        won: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ['$status', 'won'] },
                  { $ne: [{ $ifNull: ['$convertedRegistration', null] }, null] },
                ],
              },
              // a won aggregate counts its full count, otherwise 1
              { $cond: [{ $eq: ['$isAggregate', true] }, { $ifNull: ['$count', 0] }, 1] },
              0,
            ],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        repId: '$_id',
        repName: 1,
        leads: 1,
        won: 1,
        closeRate: {
          $cond: [{ $gt: ['$leads', 0] }, { $divide: ['$won', '$leads'] }, 0],
        },
      },
    },
    { $sort: { leads: -1 } },
  ];

  const data = await Lead.aggregate(pipeline);
  res.json({ success: true, data });
});
