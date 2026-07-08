/**
 * Normalisation helpers shared by the Excel import and the API layer.
 * The source data is messy and inconsistent ("בשפה שלה"), so these functions
 * map raw text to canonical values without ever losing the original.
 */

/**
 * Parse a money/number cell. Takes the FIRST numeric token only, so a free-text
 * note that happens to contain several numbers ("נשאר 750 ... 6900") does NOT get
 * concatenated into a giant bogus number.
 *   "5,900.00" -> 5900 ; "" -> 0 ; "1400 ש"ח" -> 1400 ; "נשאר 750 לשלם" -> 750
 */
export const parseNumber = (val) => {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  const s = String(val);
  // first number token: 1,234.56 | 1234.56 | 1234
  const m = s.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/);
  if (!m) return 0;
  let n = parseFloat(m[0].replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  // Accounting-style negatives: "(5,900.00)" means -5900.
  if (n > 0 && /\(\s*[\d.,]+\s*\)/.test(s)) n = -n;
  return n;
};

/** True if the cell holds prose (letters) or a date rather than a clean money number. */
export const isNoisyNumber = (val) => {
  const s = val === null || val === undefined ? '' : String(val).trim();
  if (!s) return false;
  if (/[A-Za-z֐-׿]/.test(s)) return true; // contains letters -> prose
  if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(s)) return true; // a date (e.g. 30.7.25), not money
  return false;
};

/**
 * Parse Hebrew-style dates appearing in the sheets:
 *   "3.9.24" "15.9.2024" "1/2" "5/2/25" "9/2/2026"
 * Returns { date: Date|null, raw: string, assumedYear: boolean }.
 * When the year is missing (Moran uses "d/m"), we fill it with `fallbackYear`
 * and flag assumedYear = true so the UI can warn / let the user fix it.
 */
export const parseDate = (val, fallbackYear = 2026) => {
  const raw = val === null || val === undefined ? '' : String(val).trim();
  if (!raw) return { date: null, raw: '', assumedYear: false };

  const m = raw.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  if (!m) return { date: null, raw, assumedYear: false };

  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  let year;
  let assumedYear = false;
  if (m[3]) {
    year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
  } else {
    year = fallbackYear;
    assumedYear = true;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { date: null, raw, assumedYear: false };
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return { date, raw, assumedYear };
};

/**
 * Canonical course families. Each entry: keywords (any match) -> canonical field name.
 * Order matters – more specific families ("NLP מאסטר") are checked before generic ("נלפ").
 */
const COURSE_FAMILIES = [
  { field: 'NLP מאסטר', keys: ['nlp מאסטר', 'נלפ מאסטר', 'נל"פ מאסטר', 'מאסטר nlp'] },
  { field: 'מאסטר בטראומה וחרדה', keys: ['מאסטר בטראומה', 'מאסטר טראומה'] },
  { field: 'מאסטר תרפי', keys: ['מאסטר תרפי'] },
  { field: 'טראומה וחרדה', keys: ['טראומה', 'חרדה', 'חדרה'] },
  { field: 'הדרכת הורים', keys: ['הדרכת הורים', 'הדרכת הורי', 'הדרכת מאי', 'הדרכה מאי', 'הורים', 'הדרכה', 'הדרכת'] },
  { field: 'ייעוץ זוגי', keys: ['ייעוץ זוגי', 'יעוץ זוגי', 'יועצת זוגית', 'זוגיות', 'זוגי'] },
  { field: 'טראנס וסוגסטיה', keys: ['טראנס', 'סוגסטיה'] },
  { field: 'מרצים בכירים', keys: ['מרצים בכירים', 'מרצים'] },
  { field: 'אורח חיים בריא', keys: ['אורח חיים', 'אורח חים'] },
  { field: 'הום סטיילינג', keys: ['הום סטיילינג', 'סטיילינג'] },
  { field: 'נל"פ פרקטישינר', keys: ['פרקטיש', 'פרקט', 'נל"פ', 'נלפ', 'nlp'] },
];

const ADVERTISING_KEYS = ['פרסום', 'מגזין', 'מודעה', 'קמפיין'];
const COLLECTION_KEYS = ['המשך גבייה', 'המשך גביה', 'גבייה', 'גביה'];

/** Extract a cohort label like "9/25", "5/26", "11/24" from the raw course string. */
const extractCohort = (raw) => {
  const m = String(raw).match(/(\d{1,2})\s*\/\s*(\d{2,4})/);
  if (!m) return '';
  return `${parseInt(m[1], 10)}/${m[2]}`;
};

/**
 * Classify a raw course cell.
 * Returns { field, cohortLabel, recordType, needsReview }.
 *   recordType: 'registration' | 'advertising' | 'collection_followup' | 'other'
 */
export const normalizeCourse = (rawVal) => {
  const raw = (rawVal === null || rawVal === undefined ? '' : String(rawVal)).trim();
  const low = raw.toLowerCase();

  if (!raw) {
    return { field: '', cohortLabel: '', recordType: 'registration', needsReview: true };
  }
  if (ADVERTISING_KEYS.some((k) => raw.includes(k))) {
    return { field: 'פרסום', cohortLabel: '', recordType: 'advertising', needsReview: false };
  }
  if (COLLECTION_KEYS.some((k) => raw.includes(k))) {
    return {
      field: 'המשך גבייה',
      cohortLabel: extractCohort(raw),
      recordType: 'collection_followup',
      needsReview: false,
    };
  }
  for (const fam of COURSE_FAMILIES) {
    if (fam.keys.some((k) => low.includes(k))) {
      return {
        field: fam.field,
        cohortLabel: extractCohort(raw),
        recordType: 'registration',
        needsReview: false,
      };
    }
  }
  // Bare cohort markers like "1/6", "4/6", or unknown text -> keep but flag.
  return {
    field: raw,
    cohortLabel: extractCohort(raw),
    recordType: /^\s*\d{1,2}\s*\/\s*\d{1,2}\s*$/.test(raw) ? 'other' : 'registration',
    needsReview: true,
  };
};

/**
 * Parse a payment-method cell, e.g.:
 *   "כ.א. 12 תשלומים" -> { category:'credit', installments:12 }
 *   "העברה בנקאית"     -> { category:'transfer' }
 *   "מזומן"            -> { category:'cash' }
 *   "ERN 6 תשלומים"    -> { category:'ern', installments:6 }
 *   "העברה + כ.א."     -> { category:'combined' }
 */
export const parsePaymentMethod = (rawVal) => {
  const raw = (rawVal === null || rawVal === undefined ? '' : String(rawVal)).trim();
  if (!raw) return { raw: '', category: '', installments: undefined };
  const low = raw.toLowerCase();

  const hasCredit = /כ\.?\s*א|כרטיס|אשראי|דיירקט|דירקט/.test(raw);
  const hasTransfer = /העברה/.test(raw);
  const hasCash = /מזומן/.test(raw);
  const hasErn = /ern/.test(low);
  const hasFinancing = /מימון|חוץ בנקאי|חוץ-בנקאי/.test(raw);

  const methodsPresent = [hasCredit, hasTransfer, hasCash, hasErn, hasFinancing].filter(
    Boolean
  ).length;
  const combined = methodsPresent > 1 || /\+/.test(raw);

  let category = 'other';
  if (combined) category = 'combined';
  else if (hasCredit) category = 'credit';
  else if (hasErn) category = 'ern';
  else if (hasTransfer) category = 'transfer';
  else if (hasCash) category = 'cash';
  else if (hasFinancing) category = 'financing';

  const im = raw.match(/(\d{1,2})\s*תשלומ/);
  const installments = im ? parseInt(im[1], 10) : undefined;

  return { raw, category, installments };
};

/** Split a Hebrew full name into first / last (best effort). */
export const splitName = (fullName) => {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
};

export const isYes = (val) => {
  const s = String(val || '').trim();
  return /^(כן|yes|v|✓|true|1)$/i.test(s);
};

export const cleanStr = (val) =>
  val === null || val === undefined ? '' : String(val).trim();

/**
 * Parse a free-text installment plan written by the reps, e.g.:
 *   "6 תשלומים ERN של 985 ש"ח כל 15 לחודש החל מ-15.6.26"
 *   "נותרו עוד 5 העברות של 657 ש"ח ב-9 לכל חודש"
 *   "4900 שולמו ב-6 תשלומים ב-ERN החל מ-15.4.25, כל תשלום 820"
 *   "3900 ש"ח שולמו ב 6 תשלומים ERN, תשלום ראשון ב-15.4 כל תשלום 650 ש"ח"
 * Returns { count, amount|null, dayOfMonth|null, startRaw|null, method } or null.
 * `count` prefers the "remaining" number ("נותרו N") when present.
 */
export const parseInstallmentPlan = (rawText) => {
  const text = cleanStr(rawText);
  if (!text) return null;

  const remainM = text.match(/נותר[ו]?(?:\s*עוד)?\s*(\d{1,2})/);
  const countM = text.match(/(\d{1,2})\s*(?:תשלומים|העברות|פעמים)/);
  const count = remainM ? parseInt(remainM[1], 10) : countM ? parseInt(countM[1], 10) : null;
  if (!count || count < 2 || count > 36) return null;

  // amount per installment: "של 985 ש"ח" OR "כל תשלום 833"
  const amtM = text.match(/(?:של|כל\s*תשלום)\s*([\d,]+(?:\.\d+)?)/);
  const amount = amtM ? parseFloat(amtM[1].replace(/,/g, '')) : null;

  // day of month: "כל 15 לחודש" / "ב-9 לכל חודש"
  const dayM = text.match(/(?:כל|ב-?|ה-?)\s*(\d{1,2})\s*ל(?:כל\s*)?חודש/);
  let dayOfMonth = dayM ? parseInt(dayM[1], 10) : null;
  // "בתחילת כל חודש" / "תחילת החודש" → the 1st of the month
  if (dayOfMonth == null && /תחיל[הת]\s*(?:כל\s*ה?|ה)?חודש/.test(text)) dayOfMonth = 1;

  // start date: "החל מ-15.6.26" / "תשלום ראשון ב-15.4" / "ראשון ב-15.4"
  const startM = text.match(
    /(?:החל\s*מ-?|תשלום\s*ראשון\s*ב-?|ראשון\s*ב-?)\s*(\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?)/
  );
  const startRaw = startM ? startM[1] : null;
  if (dayOfMonth == null && startRaw) {
    const d = startRaw.match(/^(\d{1,2})/);
    dayOfMonth = d ? parseInt(d[1], 10) : null;
  }

  let method = 'ern';
  if (/ERN|הוראת קבע/i.test(text)) method = 'ern';
  else if (/העברות|העברה/.test(text)) method = 'transfer';
  else if (/אשראי|כ\.?\s*א|כרטיס/.test(text)) method = 'credit';

  return { count, amount: amount && amount > 0 ? amount : null, dayOfMonth, startRaw, method };
};

/**
 * Detect an installment-marker row → { indices, count } or null.
 * Handles "1/6", "ERN 2/6", and combined markers like "1+2+3/6" (indices [1,2,3], count 6).
 */
export const parseInstallmentMarker = (rawCourse) => {
  const s = cleanStr(rawCourse);
  const m = s.match(/^(?:ern\s*)?([\d+\s]+?)\s*\/\s*(\d{1,2})\s*$/i);
  if (!m) return null;
  const count = parseInt(m[2], 10);
  const indices = m[1]
    .split('+')
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => n >= 1 && n <= count);
  if (!indices.length || !count || count > 36) return null;
  return { indices, count };
};
