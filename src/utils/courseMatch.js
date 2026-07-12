/**
 * Best-effort matching of a deal (Registration) to one of the EXISTING courses.
 * The reps named courses loosely ("נלפ", "הדרכת הורים מאי", "נל"פ 1/25"…), so we resolve
 * the cohort with a priority chain and never invent a course:
 *   1. explicit course FK (already linked)
 *   2. explicit cohort label on the deal that matches a course cohort
 *   3. Hebrew-month hint in the raw text ("מאי" → month 5) → cohort of that month
 *   4. deal date closest to a cohort's start date (within a sane window)
 *   5. the field has exactly one cohort
 * Otherwise the deal is left UNASSIGNED (e.g. an older 2025 cohort not in the list).
 */

const HEB_MONTHS = {
  ינואר: 1,
  פברואר: 2,
  מרץ: 3,
  אפריל: 4,
  מאי: 5,
  יוני: 6,
  יולי: 7,
  אוגוסט: 8,
  ספטמבר: 9,
  אוקטובר: 10,
  נובמבר: 11,
  דצמבר: 12,
};

const DAY = 86400000;
const MAX_GAP_DAYS = 150; // beyond this, "nearest cohort" is really a different/older cohort

const norm = (s) => (s || "").replace(/["'׳״\s.]/g, "").toLowerCase();
const cohortMonth = (label) => {
  const m = /(\d{1,2})\s*\/\s*\d/.exec(label || "");
  return m ? parseInt(m[1], 10) : null;
};
const hintMonth = (raw) => {
  for (const [k, v] of Object.entries(HEB_MONTHS))
    if ((raw || "").includes(k)) return v;
  return null;
};
const nearest = (courses, dd) => {
  let best = null;
  let bestGap = Infinity;
  for (const c of courses) {
    if (!c.startDate) continue;
    const gap = Math.abs(+new Date(c.startDate) - dd);
    if (gap < bestGap) {
      bestGap = gap;
      best = c;
    }
  }
  return { best, bestGap };
};

/** Group courses by normalized field for fast lookup. */
export function buildCourseIndex(courses) {
  const byId = new Map(courses.map((c) => [String(c._id), c]));
  const byField = new Map();
  for (const c of courses) {
    const f = norm(c.field);
    if (!byField.has(f)) byField.set(f, []);
    byField.get(f).push(c);
  }
  return { byId, byField };
}

/** Returns { courseId, how } or null (unassigned). */
export function matchDealToCourse(deal, index) {
  if (deal.course && index.byId.has(String(deal.course))) {
    return { courseId: String(deal.course), how: "fk" };
  }
  const pool = index.byField.get(norm(deal.courseField)) || [];
  if (!pool.length) return null; // no course exists for this field → unassigned

  // The field has exactly one cohort → the only possible course (default assignment).
  if (pool.length === 1)
    return { courseId: String(pool[0]._id), how: "field-unique" };

  // Explicit cohort label that matches a real cohort.
  if (deal.cohortLabel) {
    const hit = pool.find(
      (c) => norm(c.cohortLabel) === norm(deal.cohortLabel),
    );
    if (hit) return { courseId: String(hit._id), how: "cohort" };
    // else fall through - a named cohort not in the list (e.g. old 1/25) is caught below
    // by the date window, which will leave genuinely-old deals unassigned.
  }

  const dd = deal.dealDate ? +new Date(deal.dealDate) : null;

  // Hebrew-month hint in the raw text ("נלפ מאי" → month 5) beats raw date proximity.
  const hm = hintMonth(deal.courseRaw);
  if (hm) {
    const cands = pool.filter((c) => cohortMonth(c.cohortLabel) === hm);
    if (cands.length === 1)
      return { courseId: String(cands[0]._id), how: "month-hint" };
    if (cands.length > 1) {
      const { best } = dd ? nearest(cands, dd) : { best: cands[0] };
      if (best) return { courseId: String(best._id), how: "month-hint+date" };
    }
  }

  // Deal date closest to a cohort start, within a sane window (older deals stay unassigned).
  if (dd) {
    const { best, bestGap } = nearest(pool, dd);
    if (best && bestGap / DAY <= MAX_GAP_DAYS)
      return { courseId: String(best._id), how: "date" };
  }

  return null; // ambiguous / older cohort not in the list → unassigned
}
