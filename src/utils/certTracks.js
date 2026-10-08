/**
 * המגמות המקצועיות של NLP פרקטישינר - הרשימה הקבועה שמופיעה על תעודת המגמה.
 * חייבת להישאר זהה ל-TRACK_EN ב-client/src/lib/certs/gen/nlpBase.js (שם גם
 * התרגום לאנגלית שמודפס על התעודה).
 */
export const CERT_TRACKS = [
  "אימון ממוקד תוצאות",
  "טראומה וחרדה",
  "ילדים ונוער",
  "מערכות יחסים וזוגיות",
];

export const MAX_TRACKS = 4;

/** מנקה רשימת מגמות מהבקשה: רק ערכים מהרשימה, בלי כפילויות, בסדר הרשימה. */
export const cleanTracks = (raw) => {
  const set = new Set((Array.isArray(raw) ? raw : []).map((t) => String(t || "").trim()));
  return CERT_TRACKS.filter((t) => set.has(t));
};
