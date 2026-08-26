/**
 * תצוגה מקדימה של קישורים (Open Graph) לוואטסאפ ודומיו.
 *
 * וואטסאפ קורא את ה-HTML של הקישור בלי להריץ JS, ולכן ה-SPA לבדו מציג רק את
 * ה-<title> הכללי. כאן מזריקים ל-index.html תגי og:* לפי הנתיב שנשלח: כותרת
 * ייעודית לחתימה דיגיטלית / טופס פרטים / טופס עסקה / הצעת מחיר, וכותרת כללית
 * לכל השאר. התמונה (server/public/og-image.png, 1200x630) משותפת לכולם.
 */

const SITE = "מכללת ספרא";

const PAGES = [
  {
    test: (p) => p.startsWith("/sign/"),
    title: `תקנון וחתימה דיגיטלית | ${SITE}`,
    description: "תקנון ההרשמה לחתימה דיגיטלית - מכללת ספרא, הבית למקצועות הטיפול והייעוץ",
  },
  {
    test: (p) => p.startsWith("/details/"),
    title: `טופס השלמת פרטים | ${SITE}`,
    description: "השלמת פרטים אישיים לנרשמים - מכללת ספרא, הבית למקצועות הטיפול והייעוץ",
  },
  {
    test: (p) => p.startsWith("/external/deal"),
    title: `טופס הרשמה | ${SITE}`,
    description: "טופס הרשמה לקורס - מכללת ספרא, הבית למקצועות הטיפול והייעוץ",
  },
  {
    test: (p) => p.startsWith("/quote/"),
    title: `הצעת מחיר | ${SITE}`,
    description: "הצעת מחיר אישית - מכללת ספרא, הבית למקצועות הטיפול והייעוץ",
  },
];

const GENERAL = {
  title: `${SITE} | מערכת ניהול`,
  description: "מערכת הרישום של מכללת ספרא - הבית למקצועות הטיפול והייעוץ",
};

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** כתובת הבסיס הציבורית של הבקשה (מכבד proxy כמו ב-Render). */
export function publicOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

export function ogMetaFor(reqPath) {
  const p = String(reqPath || "/");
  return PAGES.find((x) => x.test(p)) || GENERAL;
}

/** מחזיר את index.html עם <title> ותגי og:* מותאמים לנתיב. */
export function injectOgMeta(html, req) {
  const meta = ogMetaFor(req.path);
  const origin = publicOrigin(req);
  const url = `${origin}${req.originalUrl || req.path}`;
  // JPEG < 300KB, 1200x480 (יחס 2.5:1 - הבעלים ביקש כרטיס נמוך יותר) - וואטסאפ מציג כרטיס גדול (תמונה למעלה)
  const image = `${origin}/og-image.jpg`;
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(SITE)}" />`,
    `<meta property="og:title" content="${esc(meta.title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    // תמונה גדולה (1200x630 + secure_url/type) - וואטסאפ מציג אותה מעל הטקסט, לא כתמונה ממוזערת בצד
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:image:secure_url" content="${esc(image.replace(/^http:/, "https:"))}" />`,
    `<meta property="og:image:type" content="image/jpeg" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="480" />`,
    `<meta property="og:image:alt" content="${esc(SITE)}" />`,
    `<meta property="og:locale" content="he_IL" />`,
    `<meta name="description" content="${esc(meta.description)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(meta.title)}" />`,
    `<meta name="twitter:description" content="${esc(meta.description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
  ].join("\n    ");
  // התגים נכנסים מיד אחרי <meta charset> (בתחילת ה-head) - וואטסאפ קורא רק את
  // תחילת המסמך, ולפני קישורי הפונטים והסקריפטים
  let out = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(meta.title)}</title>`);
  const charset = /<meta charset="[^"]*" \/>/i.exec(out);
  out = charset
    ? out.replace(charset[0], `${charset[0]}\n    ${tags}`)
    : out.replace("</head>", `    ${tags}\n  </head>`);
  return out;
}
