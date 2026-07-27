/** בריחת HTML לערכים שמקורם בקלט משתמש (שם/קורס מהטופס הציבורי). */
const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** גוף המייל (HTML, RTL) שנשלח ללקוח יחד עם עותק ה-PDF החתום של החוזה. */
export function contractEmailHtml({ name, courseName } = {}) {
  const safeName = escapeHtml(name);
  const safeCourse = escapeHtml(courseName);
  const greet = safeName ? `שלום ${safeName},` : 'שלום,';
  const course = safeCourse ? ` עבור <b>${safeCourse}</b>` : '';
  return (
    `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;text-align:right;color:#1a2430;">` +
    `${greet}<br><br>` +
    `תודה שנרשמת למכללת ספרא. מצורף עותק חתום של תקנון הלימודים${course}.<br>` +
    `מומלץ לשמור את הקובץ לרשומותיך.<br><br>` +
    `לכל שאלה ניתן להשיב למייל זה או לפנות למשרדי המכללה.<br><br>` +
    `בברכה,<br>מכללת ספרא` +
    `</div>`
  );
}
