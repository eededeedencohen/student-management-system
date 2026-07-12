/**
 * מוד "מ-2026 בלבד": כשהלקוח שולח ?since2026=1 (מוזרק אוטומטית ע"י ה-apiClient כשהמוד
 * דלוק), כל שאילתות הנתונים מתעלמות לחלוטין מעסקאות שתאריכן לפני 1.1.2026 —
 * כאילו ההיסטוריה הישנה לא קיימת (כולל יתרות/חובות של עסקאות ישנות).
 */
export const SINCE_2026 = new Date(Date.UTC(2026, 0, 1));

/** Date גבול או null כשהמוד כבוי. */
export const sinceOf = (req) =>
  req?.query?.since2026 === '1' || req?.headers?.['x-since-2026'] === '1' ? SINCE_2026 : null;

/** מוסיף את הגבול לשדה תאריך בתוך אובייקט match של מונגו (משמר תנאים קיימים). */
export const applySince = (req, match, field = 'dealDate') => {
  const since = sinceOf(req);
  if (!since) return match;
  const existing = match[field];
  if (existing instanceof Date) return match; // תאריך נקודתי — לא נוגעים
  match[field] = { ...(existing || {}), $gte: existing?.$gte && existing.$gte > since ? existing.$gte : since };
  return match;
};
