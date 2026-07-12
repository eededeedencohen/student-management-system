import Registration from '../models/Registration.js';

/**
 * אישור אוטומטי לתשלומים מתוזמנים שהגיע מועדם.
 *
 * חוק עסקי: "אם נקבע שכל חודש יעביר X — זה מה שיהיה". סומכים על המילה של הסטודנטים:
 * תשלום מתוזמן (ERN, חיוב אשראי עתידי או העברה שהובטחה לתאריך) שהמועד שלו עבר —
 * נחשב שנגבה, גם בלי ✓ ידני. (במקור הוחל רק על ERN; הורחב לכל אמצעי לפי ההנחיה.)
 *
 * חריג: הוראה/תוכנית שהופסקה (ההערה מכילה "הופסק") — נשארת פתוחה לטיפול ידני.
 * תיקון ידני תמיד אפשרי דרך "בטל" בעמוד הסטודנט.
 *
 * רץ בעליית השרת + פעם ביום (server.js), והרצה ידנית:
 *   node src/scripts/ernAutoConfirm.js
 */
export async function autoConfirmDueErn(now = new Date()) {
  const regs = await Registration.find({
    payments: { $elemMatch: { paid: false, dueDate: { $lte: now } } },
  });

  let flipped = 0;
  const touched = [];
  for (const reg of regs) {
    let changed = false;
    for (const p of reg.payments) {
      if (p.paid) continue;
      if (!p.dueDate || new Date(p.dueDate) > now) continue;
      if (/הופסק/.test(p.note || '')) continue; // תוכנית שבוטלה — לא נכנס כסף
      p.paid = true;
      p.confirmedByName = 'אוטומטי — נגבה במועד שסוכם';
      p.confirmedAt = new Date(p.dueDate); // הכסף נכנס ביום שנקבע
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
