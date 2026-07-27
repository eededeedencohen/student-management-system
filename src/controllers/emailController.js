import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import EmailAccount from '../models/EmailAccount.js';
import Student from '../models/Student.js';
import Registration from '../models/Registration.js';
import ContractPdf from '../models/ContractPdf.js';
import { contractEmailHtml } from '../utils/contractEmailHtml.js';
import {
  isGoogleConfigured,
  redirectUri,
  buildConsentUrl,
  signOAuthState,
  verifyOAuthState,
  exchangeCodeForTokens,
  buildRawMessage,
  sendGmailMessage,
} from '../utils/google.js';
import { ensureAccessToken, sendOneEmail } from '../utils/mailer.js';

const ACCOUNT_KEY = 'primary';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 300;
const fromName = () => process.env.EMAIL_FROM_NAME || 'מכללת ספרא';

/** The real signed-in user (עדן), even while "viewing as" someone else. */
const realUser = (req) => req.impersonator || req.user;

/**
 * GET /api/emails/status
 * Whether Google OAuth is configured on the server and whether an account is connected.
 * Never returns tokens.
 */
export const status = asyncHandler(async (req, res) => {
  const acct = await EmailAccount.findOne({ key: ACCOUNT_KEY }).lean();
  res.json({
    success: true,
    data: {
      configured: isGoogleConfigured(),
      connected: Boolean(acct),
      email: acct?.email || null,
      connectedAt: acct?.connectedAt || null,
      connectedByName: acct?.connectedByName || null,
    },
  });
});

/**
 * GET /api/emails/oauth/url
 * Returns the Google consent URL to redirect the browser to. The `state` is a signed,
 * short-lived token proving this flow was started by an authenticated super-admin.
 */
export const oauthUrl = asyncHandler(async (req, res) => {
  if (!isGoogleConfigured()) {
    throw ApiError.badRequest(
      'חיבור Google לא מוגדר בשרת. יש להגדיר GOOGLE_CLIENT_ID ו-GOOGLE_CLIENT_SECRET בקובץ .env',
    );
  }
  const u = realUser(req);
  const redirect = redirectUri(req);
  const state = signOAuthState({ uid: String(u?._id || ''), name: u?.name || '', sa: true });
  const url = buildConsentUrl({ redirect, state, loginHint: u?.email });
  res.json({ success: true, data: { url } });
});

/**
 * GET /api/emails/oauth/callback   (PUBLIC — Google redirects the browser here)
 * Cannot carry a Bearer token, so it is authenticated by the signed `state` instead.
 * Exchanges the code for tokens, stores them, and redirects back into the SPA.
 */
export const oauthCallback = asyncHandler(async (req, res) => {
  const backTo = (params) => res.redirect(`/emails?${new URLSearchParams(params)}`);

  // The user denied consent, or Google returned an error.
  if (req.query.error) return backTo({ google: 'error', reason: String(req.query.error) });

  const { code, state } = req.query;
  if (!code || !state) return backTo({ google: 'error', reason: 'missing_code' });

  let claims;
  try {
    claims = verifyOAuthState(String(state));
  } catch {
    return backTo({ google: 'error', reason: 'bad_state' });
  }
  if (claims.sa !== true) return backTo({ google: 'error', reason: 'forbidden' });

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({ code: String(code), redirect: redirectUri(req) });
  } catch (err) {
    return backTo({ google: 'error', reason: err.message || 'exchange_failed' });
  }

  // On re-consent Google may omit the refresh token; keep the previously stored one.
  const existing = await EmailAccount.findOne({ key: ACCOUNT_KEY }).select('+refreshToken');
  const refreshToken = tokens.refreshToken || existing?.refreshToken || null;
  if (!refreshToken) {
    return backTo({ google: 'error', reason: 'no_refresh_token' });
  }

  // Google's granular consent lets the user uncheck the (restricted) gmail.send scope
  // while still granting sign-in. Without it every send fails 403, so reject here rather
  // than store a "connected" account that can't send.
  const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
  const grantedScope = tokens.scope || existing?.scope || '';
  if (!grantedScope.split(' ').includes(SEND_SCOPE)) {
    return backTo({ google: 'error', reason: 'missing_scope' });
  }

  await EmailAccount.findOneAndUpdate(
    { key: ACCOUNT_KEY },
    {
      key: ACCOUNT_KEY,
      email: tokens.email || existing?.email || '',
      accessToken: tokens.accessToken,
      refreshToken,
      expiryDate: tokens.expiryDate,
      scope: tokens.scope,
      connectedById: claims.uid || '',
      connectedByName: claims.name || '',
      connectedAt: new Date(),
    },
    { upsert: true, new: true },
  );

  return backTo({ google: 'connected' });
});

/**
 * POST /api/emails/disconnect
 * Forget the stored Google account. (Does not revoke server-side at Google; the user
 * can revoke from their Google account settings.)
 */
export const disconnect = asyncHandler(async (req, res) => {
  await EmailAccount.deleteOne({ key: ACCOUNT_KEY });
  res.json({ success: true, data: { connected: false } });
});

/**
 * GET /api/emails/recipients
 * Students that have an email address, with their outstanding balance — feeds the
 * recipient picker and the payment-reminder template. Sorted by debt (desc).
 */
export const recipients = asyncHandler(async (req, res) => {
  const rows = await Student.aggregate([
    { $match: { email: { $type: 'string', $ne: '' } } },
    {
      $lookup: {
        from: 'registrations',
        localField: '_id',
        foreignField: 'student',
        as: 'regs',
      },
    },
    {
      $addFields: {
        deals: {
          $filter: {
            input: '$regs',
            as: 'r',
            cond: { $eq: ['$$r.recordType', 'registration'] },
          },
        },
      },
    },
    {
      $addFields: {
        totalPaid: { $sum: '$deals.totalPaid' },
        totalOutstanding: { $sum: '$deals.outstanding' },
        totalDeals: { $sum: '$deals.totalAmount' },
        dealsCount: { $size: '$deals' },
      },
    },
    {
      $project: {
        _id: 1,
        studentNumber: 1,
        fullName: 1,
        firstName: 1,
        email: 1,
        mobile: 1,
        totalPaid: 1,
        totalOutstanding: 1,
        totalDeals: 1,
        dealsCount: 1,
      },
    },
    { $sort: { totalOutstanding: -1, fullName: 1 } },
  ]).collation({ locale: 'he' });

  res.json({
    success: true,
    data: rows.map((r) => ({
      id: String(r._id),
      studentNumber: r.studentNumber || null,
      fullName: r.fullName,
      firstName: r.firstName || '',
      email: r.email,
      mobile: r.mobile || '',
      totalPaid: r.totalPaid || 0,
      totalOutstanding: r.totalOutstanding || 0,
      totalDeals: r.totalDeals || 0,
      dealsCount: r.dealsCount || 0,
    })),
  });
});

/**
 * POST /api/emails/send
 * body: {
 *   subject?, html?,                              // shared defaults
 *   replyTo?,
 *   recipients: [{ email, name?, subject?, html? }]  // per-recipient overrides allowed
 * }
 * Sends one individual message per recipient (no address leaks between recipients).
 * Returns a per-recipient result; a single failure does not abort the rest.
 */
export const send = asyncHandler(async (req, res) => {
  const { subject: defSubject = '', html: defHtml = '', replyTo, recipients } = req.body || {};
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw ApiError.badRequest('יש לבחור לפחות נמען אחד');
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw ApiError.badRequest(`ניתן לשלוח עד ${MAX_RECIPIENTS} נמענים בבת אחת`);
  }
  if (replyTo && !EMAIL_RE.test(String(replyTo).trim())) {
    throw ApiError.badRequest('כתובת "השב אל" אינה תקינה');
  }

  // Normalise + validate every recipient BEFORE sending anything.
  const jobs = recipients.map((r, i) => {
    const email = String(r?.email || '').trim();
    const subject = String(r?.subject ?? defSubject).trim();
    const html = String(r?.html ?? defHtml);
    if (!EMAIL_RE.test(email)) throw ApiError.badRequest(`כתובת מייל לא תקינה בשורה ${i + 1}: "${email}"`);
    if (!subject) throw ApiError.badRequest(`נושא חסר בשורה ${i + 1}`);
    if (!html.trim()) throw ApiError.badRequest(`תוכן חסר בשורה ${i + 1}`);
    return { email, name: (r?.name || '').trim(), subject, html };
  });

  const acct = await EmailAccount.findOne({ key: ACCOUNT_KEY }).select('+accessToken +refreshToken');
  if (!acct || !acct.refreshToken) {
    throw ApiError.badRequest('לא מחובר חשבון Google. יש להתחבר תחילה.');
  }

  const from = acct.email || undefined;
  const results = [];
  let aborted = false;
  let abortReason = '';

  for (const job of jobs) {
    let forcedRefresh = false; // once per recipient: a 401 → force a refresh and retry
    for (;;) {
      try {
        const accessToken = await ensureAccessToken(acct, { force: forcedRefresh });
        const raw = buildRawMessage({
          from,
          fromName: fromName(),
          to: job.email,
          toName: job.name,
          subject: job.subject,
          html: job.html,
          replyTo: replyTo?.trim() || undefined,
        });
        const id = await sendGmailMessage({ accessToken, raw });
        results.push({ email: job.email, ok: true, id });
        break;
      } catch (err) {
        // Gmail rejected a not-yet-expired token → refresh once and retry this recipient.
        if (err.status === 401 && !forcedRefresh) {
          forcedRefresh = true;
          continue;
        }
        // A hard auth failure (bad/revoked refresh token) recurs for every recipient —
        // stop the batch, but KEEP the results already collected so the operator sees
        // exactly what was delivered (and doesn't resend the whole list → duplicates).
        results.push({ email: job.email, ok: false, error: err.message || 'שגיאה בשליחה' });
        if (err.fatalAuth) {
          aborted = true;
          abortReason = err.message || 'החיבור ל-Google נכשל';
        }
        break;
      }
    }
    if (aborted) break;
  }

  const sent = results.filter((r) => r.ok).length;
  res.json({
    success: true,
    data: {
      sent,
      failed: results.length - sent,
      total: jobs.length,
      attempted: results.length,
      aborted,
      abortReason: aborted ? abortReason : undefined,
      results,
    },
  });
});

/**
 * GET /api/emails/signed-contracts
 * All signed contracts, so the super-admin can re-send the signed-PDF copy. `hasPdf`
 * marks whether a stored PDF exists (contracts signed before this feature won't have one).
 */
export const signedContracts = asyncHandler(async (req, res) => {
  const regs = await Registration.find({ 'contract.status': 'signed' })
    .sort({ 'contract.signedAt': -1 })
    .select('studentName student courseRaw contract.signedAt contract.emailedAt contract.emailedTo')
    .lean();

  const ids = regs.map((r) => r._id);
  const studentIds = regs.map((r) => r.student).filter(Boolean);
  const [pdfs, students] = await Promise.all([
    ContractPdf.find({ registration: { $in: ids } }).select('registration').lean(),
    Student.find({ _id: { $in: studentIds } }).select('email').lean(),
  ]);
  const hasPdf = new Set(pdfs.map((p) => String(p.registration)));
  const emailById = new Map(students.map((s) => [String(s._id), s.email || '']));

  res.json({
    success: true,
    data: regs.map((r) => ({
      id: String(r._id),
      studentName: r.studentName || '',
      email: r.student ? emailById.get(String(r.student)) || '' : '',
      courseName: r.courseRaw || '',
      signedAt: r.contract?.signedAt || null,
      emailedAt: r.contract?.emailedAt || null,
      emailedTo: r.contract?.emailedTo || null,
      hasPdf: hasPdf.has(String(r._id)),
    })),
  });
});

/**
 * POST /api/emails/signed-contracts/resend
 * body: { registrationIds?: string[], all?: boolean }
 * Re-send the stored signed-PDF copy to signers (selected or all). Uses the stored PDF;
 * a contract with no stored copy is reported 'no_pdf'. Updates emailedAt on each success.
 */
export const resendSignedContracts = asyncHandler(async (req, res) => {
  const all = Boolean(req.body?.all);
  const ids = Array.isArray(req.body?.registrationIds) ? req.body.registrationIds : [];
  if (!all && ids.length === 0) throw ApiError.badRequest('יש לבחור לפחות חוזה אחד');

  const filter = { 'contract.status': 'signed' };
  if (!all) filter._id = { $in: ids };
  const regs = await Registration.find(filter)
    .sort({ 'contract.signedAt': -1 })
    .select('studentName student courseRaw contract');
  if (regs.length > 300) throw ApiError.badRequest('יותר מדי חוזים בבת אחת (עד 300)');

  const results = [];
  let aborted = false;
  for (const reg of regs) {
    const label = { id: String(reg._id), name: reg.studentName || '' };
    const pdfDoc = await ContractPdf.findOne({ registration: reg._id }).lean();
    if (!pdfDoc?.pdfBase64) {
      results.push({ ...label, ok: false, reason: 'no_pdf' });
      continue;
    }
    const student = reg.student
      ? await Student.findById(reg.student).select('email firstName').lean()
      : null;
    const to = String(student?.email || '').trim().toLowerCase();
    if (!to) {
      results.push({ ...label, ok: false, reason: 'no_email' });
      continue;
    }
    try {
      await sendOneEmail({
        to,
        toName: reg.studentName || '',
        subject: 'עותק חתום — תקנון מכללת ספרא',
        html: contractEmailHtml({
          name: student?.firstName || reg.studentName,
          courseName: reg.courseRaw,
        }),
        attachments: [
          { filename: pdfDoc.filename || 'contract.pdf', mimeType: 'application/pdf', base64: pdfDoc.pdfBase64 },
        ],
      });
      reg.contract.emailedAt = new Date();
      reg.contract.emailedTo = to;
      reg.markModified('contract');
      await reg.save();
      results.push({ ...label, ok: true, to });
    } catch (err) {
      results.push({ ...label, ok: false, reason: err.notConnected ? 'not_connected' : err.message });
      // account-level failure recurs for everyone — stop, keep collected results
      if (err.notConnected || err.fatalAuth) {
        aborted = true;
        break;
      }
    }
  }

  const sent = results.filter((r) => r.ok).length;
  res.json({
    success: true,
    data: { sent, failed: results.length - sent, total: regs.length, attempted: results.length, aborted, results },
  });
});
