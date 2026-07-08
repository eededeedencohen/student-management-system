/**
 * Date range + bucketing helpers for the dashboard.
 * Supports the granularities the manager asked for:
 *   day | week | month | quarter | half | year
 * All math is UTC-based to match the dates stored by the import.
 */

const GRANULARITIES = ['day', 'week', 'month', 'quarter', 'half', 'year'];
export { GRANULARITIES };

/**
 * Resolve the "current time" for a request. The client may send ?asOf=YYYY-MM-DD to view
 * the data as if it were a different day ("time travel"); otherwise it's the real now.
 * Falls back to the real now on a missing/invalid value so it can never break a query.
 */
export const nowFromReq = (req) => {
  const raw = req?.query?.asOf;
  if (raw) {
    const dt = new Date(raw);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  return new Date();
};

const d = (date) => (date instanceof Date ? new Date(date.getTime()) : new Date(date));

export const startOfDay = (date) => {
  const x = d(date);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
};

/** Week starts on Sunday (Israeli week). */
export const startOfWeek = (date) => {
  const x = startOfDay(date);
  const day = x.getUTCDay(); // 0 = Sunday
  x.setUTCDate(x.getUTCDate() - day);
  return x;
};

export const startOfMonth = (date) => {
  const x = d(date);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1));
};

export const startOfQuarter = (date) => {
  const x = d(date);
  const q = Math.floor(x.getUTCMonth() / 3);
  return new Date(Date.UTC(x.getUTCFullYear(), q * 3, 1));
};

export const startOfHalf = (date) => {
  const x = d(date);
  const h = x.getUTCMonth() < 6 ? 0 : 6;
  return new Date(Date.UTC(x.getUTCFullYear(), h, 1));
};

export const startOfYear = (date) => {
  const x = d(date);
  return new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
};

export const addDays = (date, n) => {
  const x = d(date);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};
export const addMonths = (date, n) => {
  const x = d(date);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x;
};

/** Current period [from, to) for a granularity, relative to refDate (default now). */
export const rangeFor = (granularity, refDate = new Date()) => {
  const ref = d(refDate);
  switch (granularity) {
    case 'day':
      return { from: startOfDay(ref), to: addDays(startOfDay(ref), 1) };
    case 'week':
      return { from: startOfWeek(ref), to: addDays(startOfWeek(ref), 7) };
    case 'month':
      return { from: startOfMonth(ref), to: addMonths(startOfMonth(ref), 1) };
    case 'quarter':
      return { from: startOfQuarter(ref), to: addMonths(startOfQuarter(ref), 3) };
    case 'half':
      return { from: startOfHalf(ref), to: addMonths(startOfHalf(ref), 6) };
    case 'year':
    default:
      return { from: startOfYear(ref), to: addMonths(startOfYear(ref), 12) };
  }
};

const pad = (n) => String(n).padStart(2, '0');

/** Stable sort/group key + a Hebrew-friendly label for a date at a granularity. */
export const bucketOf = (date, granularity) => {
  const x = d(date);
  const y = x.getUTCFullYear();
  const m = x.getUTCMonth();
  switch (granularity) {
    case 'day': {
      const s = startOfDay(x);
      return { key: `${y}-${pad(m + 1)}-${pad(x.getUTCDate())}`, label: `${pad(x.getUTCDate())}/${pad(m + 1)}/${y}`, start: s };
    }
    case 'week': {
      const s = startOfWeek(x);
      return { key: `${s.getUTCFullYear()}-W${pad(Math.ceil(((s - startOfYear(s)) / 86400000 + 1) / 7))}`, label: `שבוע ${pad(s.getUTCDate())}/${pad(s.getUTCMonth() + 1)}`, start: s };
    }
    case 'quarter': {
      const q = Math.floor(m / 3) + 1;
      return { key: `${y}-Q${q}`, label: `רבעון ${q}/${y}`, start: startOfQuarter(x) };
    }
    case 'half': {
      const h = m < 6 ? 1 : 2;
      return { key: `${y}-H${h}`, label: `חצי ${h}/${y}`, start: startOfHalf(x) };
    }
    case 'year':
      return { key: `${y}`, label: `${y}`, start: startOfYear(x) };
    case 'month':
    default:
      return { key: `${y}-${pad(m + 1)}`, label: `${pad(m + 1)}/${y}`, start: startOfMonth(x) };
  }
};

/** Parse ?from/?to query params into a Mongo date filter (inclusive from, exclusive to). */
export const parseDateQuery = ({ from, to, period }, refDate = new Date()) => {
  if (from || to) {
    const filter = {};
    if (from) filter.$gte = new Date(from);
    if (to) filter.$lt = new Date(to);
    return filter;
  }
  if (period && GRANULARITIES.includes(period)) {
    const r = rangeFor(period, refDate);
    return { $gte: r.from, $lt: r.to };
  }
  return null; // no date constraint
};
