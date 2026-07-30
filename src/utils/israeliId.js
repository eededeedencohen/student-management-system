/**
 * ולידציית ת.ז. ישראלית — ספרת הביקורת מחושבת באלגוריתם לוהן (משקלים 1/2 לסירוגין,
 * ספרה>9 → מפחיתים 9), והסכום חייב להתחלק ב-10. מקבל 5-9 ספרות (משלימים אפסים).
 */
export function isValidIsraeliId(id) {
  const s = String(id || '').trim();
  if (!/^\d{5,9}$/.test(s)) return false;
  const p = s.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let d = Number(p[i]) * (i % 2 === 0 ? 1 : 2);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}
