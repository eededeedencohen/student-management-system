import Registration from '../models/Registration.js';

/**
 * אישור אוטומטי לתשלומי ERN שהגיע מועדם.
 *
 * חוק עסקי (מהגדרת הנתונים המתוקנת): "ברגע ש-ERN בתמונה, כשמגיע היום בחודש הכסף נכנס" —
 * הנציגות לא סימנו מעקב באופן אמין, ולכן תשלום ERN שמועדו עבר נחשב כנגבה גם בלי ✓ ידני.
 * (פריסת אשראי אינה רלוונטית כאן — בחיוב אשראי כל הכסף נכנס מיידית ביום העסקה.)
 *
 * חריג: הוראה שהופסקה (ההערה מסומנת "הופסק") אינה נגבית — נשארת פתוחה לטיפול ידני.
 *
 * רץ בעליית השרת + פעם ביום (ראו server.js), וניתן להריץ ידנית:
 *   node src/scripts/ernAutoConfirm.js
 */
export async function autoConfirmDueErn(now = new Date()) {
  const regs = await Registration.find({
    payments: { $elemMatch: { method: 'ern', paid: false, dueDate: { $lte: now } } },
  });

  let flipped = 0;
  const touched = [];
  for (const reg of regs) {
    let changed = false;
    for (const p of reg.payments) {
      if (p.method !== 'ern' || p.paid) continue;
      if (!p.dueDate || new Date(p.dueDate) > now) continue;
      if (/הופסק/.test(p.note || '')) continue; // הוראה שבוטלה — לא נכנס כסף
      p.paid = true;
      p.confirmedByName = 'אוטומטי — ERN נכנס במועד';
      p.confirmedAt = new Date(p.dueDate); // הכסף נכנס ביום החיוב עצמו
      changed = true;
      flipped += 1;
    }
    if (changed) {
      reg.recompute();
      await reg.save();
      touched.push(`${reg.externalId || reg._id} (${reg.studentName})`);
    }
  }
  return { flipped, deals: touched };
}
