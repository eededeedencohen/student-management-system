/**
 * מרצי מחזור. `teachers` (מערך) הוא השדה הקנוני — מחזור יכול להיות מועבר בידי יותר
 * ממרצה אחד, כמו "עמר לוין + אביטל דניאל" באקסל של יקיר. מסמכים שנוצרו לפני השינוי
 * ולא נשמרו מאז מחזיקים רק את `teacher` הבודד, ולכן נופלים אליו במקום להציג מחזור
 * ללא מרצה. לשם כך יש לעשות populate לשני השדות.
 */
export const cohortTeachers = (c) =>
  c?.teachers?.length ? c.teachers : c?.teacher ? [c.teacher] : [];

/** שמות המרצים כמחרוזת אחת — "עמר לוין + אביטל דניאל", בדיוק כמו בקובץ המקור. */
export const teacherNamesOf = (c) =>
  cohortTeachers(c)
    .map((t) => t?.fullName || '')
    .filter(Boolean)
    .join(' + ');
