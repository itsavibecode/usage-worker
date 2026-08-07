// usage-worker — Cloudflare Worker that runs a daily cron to email reorder
// reminders for products approaching their average lifespan. Mirrors the
// stocks-worker's auth + Firestore patterns; adapted for the usage-tracker
// data model.
//
// Cron → scheduled handler runs daily, reads OWNER_UID's products from
// Firestore (via service account), computes which actives are at or past
// their type's mean finished lifespan, and sends a digest email via Resend
// when at least one reminder applies — gated to at most one email per
// MIN_DAYS_BETWEEN_EMAILS days so the user isn't spammed daily.

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
const IDENTITY_BASE = 'https://identitytoolkit.googleapis.com/v1';
const RESEND_BASE = 'https://api.resend.com';

// Same threshold as the in-app reorder reminders panel (computeReorderReminders
// in app.js, v0.10.0). Keeps the email and the in-app behavior consistent.
const REMINDER_THRESHOLD = 0.85;
const REMINDER_MAX = 10;
const MIN_FINISHED_PER_TYPE = 2;
const MIN_DAYS_BETWEEN_EMAILS = 7;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runDailyReminders(env)
        .then((r) => console.log('Cron run result:', JSON.stringify(r)))
        .catch((err) => console.error('Cron run failed:', err))
    );
  },

  // Optional manual-trigger endpoint. Useful for verifying wiring after
  // deployment without waiting for 13:00 UTC. Auth via x-trigger-key header
  // matching MANUAL_TRIGGER_KEY secret. If the secret isn't set, endpoint
  // is disabled.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger' && request.method === 'POST') {
      if (!env.MANUAL_TRIGGER_KEY) {
        return json({ error: 'manual trigger disabled (set MANUAL_TRIGGER_KEY secret to enable)' }, 503);
      }
      if (request.headers.get('x-trigger-key') !== env.MANUAL_TRIGGER_KEY) {
        return json({ error: 'unauthorized' }, 401);
      }
      try {
        const result = await runDailyReminders(env);
        return json(result);
      } catch (e) {
        return json({ error: e.message, stack: e.stack }, 500);
      }
    }
    // v0.3.4: deliverability test — sends a clearly-labelled sample email
    // regardless of thresholds/cooldown. Same auth as /trigger.
    if (url.pathname === '/test-email' && request.method === 'POST') {
      if (!env.MANUAL_TRIGGER_KEY) {
        return json({ error: 'manual trigger disabled (set MANUAL_TRIGGER_KEY secret to enable)' }, 503);
      }
      if (request.headers.get('x-trigger-key') !== env.MANUAL_TRIGGER_KEY) {
        return json({ error: 'unauthorized' }, 401);
      }
      try {
        return json(await sendTestEmail(env));
      } catch (e) {
        return json({ error: e.message, stack: e.stack }, 500);
      }
    }
    if (url.pathname === '/' || url.pathname === '') {
      return json({
        worker: 'usage-worker',
        purpose: 'Daily reorder-reminder emails for the usage-tracker app',
        cron: 'daily at 13:00 UTC',
        endpoints: ['POST /trigger', 'POST /test-email'],
      });
    }
    return json({ error: 'not found' }, 404);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ═════════════════════════════════════════════════════════════════════
// MAIN — fetch products, compute reminders, send digest if applicable.
// ═════════════════════════════════════════════════════════════════════

async function runDailyReminders(env) {
  const uid = env.OWNER_UID;
  if (!uid || uid === 'REPLACE_WITH_YOUR_UID') {
    return { ok: false, reason: 'OWNER_UID not configured in wrangler.toml' };
  }

  const accessToken = await getServiceAccountToken(env);

  // 1. Read user prefs to check opt-in + last-sent gate.
  const prefsDoc = await firestoreGetDoc(env, accessToken, `users/${uid}/meta/emailPrefs`);
  const prefs = prefsDoc && prefsDoc.fields ? fsFieldsToJs(prefsDoc.fields) : {};
  if (!prefs.reorderEmailsEnabled) {
    return { ok: false, reason: 'reorderEmailsEnabled is false in user prefs (or prefs doc missing)' };
  }
  if (prefs.lastReorderEmailSentAt) {
    const lastSentMs = new Date(prefs.lastReorderEmailSentAt).getTime();
    if (Number.isFinite(lastSentMs)) {
      const hoursSince = (Date.now() - lastSentMs) / 3600000;
      if (hoursSince < MIN_DAYS_BETWEEN_EMAILS * 24) {
        return {
          ok: false,
          reason: `last email sent ${hoursSince.toFixed(1)}h ago — within ${MIN_DAYS_BETWEEN_EMAILS}-day cooldown`,
        };
      }
    }
  }

  // 2. List all products for this user.
  const products = await firestoreListDocs(env, accessToken, `users/${uid}/products`);
  if (products.length === 0) {
    return { ok: false, reason: 'no products in Firestore for this user' };
  }

  // 3. Compute reminders (same algorithm as the in-app panel).
  const reminders = computeReminders(products);
  if (reminders.length === 0) {
    return { ok: true, sent: false, reason: 'no products meet the reorder threshold today', productCount: products.length };
  }

  // 4. Resolve recipient email — prefs override > Identity Toolkit lookup.
  const email = prefs.notifyEmail || (await getUserEmail(env, accessToken, uid));
  if (!email) {
    return { ok: false, reason: 'no email available for user (set notifyEmail in prefs or ensure Firebase Auth has one)' };
  }

  // 5. Build + send the digest.
  const { subject, html, text } = buildReminderEmail(reminders);
  const sendResult = await sendReminderEmail(env, { to: email, subject, html, text });

  // 6. Stamp last-sent so we don't re-send within the cooldown window.
  await firestorePatchFields(env, accessToken, `users/${uid}/meta/emailPrefs`, {
    lastReorderEmailSentAt: new Date().toISOString(),
    lastReorderEmailRecipientCount: reminders.length,
    lastResendId: (sendResult && sendResult.id) || '',
  });

  return {
    ok: true,
    sent: true,
    to: email,
    reminderCount: reminders.length,
    resendId: sendResult && sendResult.id,
  };
}

/* v0.3.4 — deliverability test.
 *
 * runDailyReminders only sends when something actually crosses the reorder
 * threshold, so it can't answer "does email from this sender reach me?" on a
 * day when nothing qualifies. This does: it resolves the same recipient, uses
 * the same Resend path and the same template, and sends regardless of
 * thresholds.
 *
 * Deliberate differences from the real run:
 *   - Bypasses the reorderEmailsEnabled opt-in (but REPORTS it, so a disabled
 *     opt-in is visible as the reason the cron would stay silent).
 *   - Bypasses the 7-day cooldown.
 *   - Does NOT stamp lastReorderEmailSentAt, so testing can't accidentally
 *     suppress a genuine reminder for the next week.
 *   - Subject is [TEST]-prefixed and the body carries an explanatory banner.
 */
async function sendTestEmail(env) {
  const uid = env.OWNER_UID;
  if (!uid || uid === 'REPLACE_WITH_YOUR_UID') {
    return { ok: false, reason: 'OWNER_UID not configured in wrangler.toml' };
  }
  const accessToken = await getServiceAccountToken(env);

  const prefsDoc = await firestoreGetDoc(env, accessToken, `users/${uid}/meta/emailPrefs`);
  const prefs = prefsDoc && prefsDoc.fields ? fsFieldsToJs(prefsDoc.fields) : {};

  const email = prefs.notifyEmail || (await getUserEmail(env, accessToken, uid));
  if (!email) {
    return { ok: false, reason: 'no email available for user (set notifyEmail in prefs or ensure Firebase Auth has one)' };
  }

  const products = await firestoreListDocs(env, accessToken, `users/${uid}/products`);

  // Prefer real reminders so the test reflects actual data. If nothing
  // qualifies today, fall back to the closest-to-due actives so the email
  // still shows the user's own products rather than invented ones.
  let reminders = computeReminders(products);
  let source = 'real reminders';
  if (reminders.length === 0) {
    reminders = closestActives(products, 3);
    source = reminders.length ? 'sample (nothing currently qualifies)' : 'none';
  }
  if (reminders.length === 0) {
    return { ok: false, reason: 'no active products to build a sample email from', productCount: products.length };
  }

  const { subject, html, text } = buildReminderEmail(reminders, { test: true });
  const sendResult = await sendReminderEmail(env, { to: email, subject, html, text });

  return {
    ok: true,
    sent: true,
    test: true,
    to: email,
    from: env.SENDER_FROM,
    itemsShown: reminders.length,
    source,
    resendId: sendResult && sendResult.id,
    productCount: products.length,
    // Surfaced so a silent cron is diagnosable from this one call.
    reorderEmailsEnabled: !!prefs.reorderEmailsEnabled,
    noteIfDisabled: prefs.reorderEmailsEnabled
      ? undefined
      : 'Test sent, but reorderEmailsEnabled is FALSE — the daily cron will not send. Turn on email reminders in the app Settings.',
    cooldownUntouched: true,
  };
}

// Actives ranked by how far through their type's mean lifespan they are, so a
// sample email shows the most relevant products. Falls back to raw duration
// for types without enough finished history to have a mean.
function closestActives(products, limit) {
  const lifespans = new Map();
  for (const p of products) {
    if (!isFinished(p)) continue;
    const d = calcDuration(p);
    if (d == null || !Number.isFinite(d) || d <= 0) continue;
    const k = p.productType || '';
    if (!k) continue;
    if (!lifespans.has(k)) lifespans.set(k, []);
    lifespans.get(k).push(d);
  }
  const meanByType = new Map();
  for (const [k, arr] of lifespans) {
    meanByType.set(k, arr.reduce((s, v) => s + v, 0) / arr.length);
  }
  const out = [];
  for (const p of products) {
    if (!isActive(p)) continue;
    const dur = calcDuration(p);
    if (dur == null) continue;
    const mean = meanByType.get(p.productType || '') ?? dur;
    out.push({
      product: p,
      currentDays: dur,
      meanDays: Math.round(mean),
      ratio: mean > 0 ? dur / mean : 0,
      pastDue: dur > mean,
    });
  }
  out.sort((a, b) => b.ratio - a.ratio);
  return out.slice(0, limit);
}

// ═════════════════════════════════════════════════════════════════════
// REMINDER MATH — mirrors computeReorderReminders in app.js (v0.10.0).
// Filters favorites + inventory; computes mean finished lifespan per type;
// surfaces actives at >= REMINDER_THRESHOLD of that mean.
// ═════════════════════════════════════════════════════════════════════

function isFavorite(p) { return p && p.favorite === true; }
function isInventory(p) { return !isFavorite(p) && !p.startDate; }
function isActive(p) { return !isFavorite(p) && !!p.startDate && !p.endDate; }
function isFinished(p) { return !isFavorite(p) && !!p.endDate; }

function parseLocalDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function calcDuration(p) {
  const start = parseLocalDate(p.startDate);
  if (!start) return null;
  const end = p.endDate ? parseLocalDate(p.endDate) : new Date();
  if (!end) return null;
  return Math.max(1, Math.round((end - start) / 86400000));
}

function computeReminders(products) {
  // Per-type mean finished lifespan, only types with >= MIN_FINISHED_PER_TYPE.
  const lifespans = new Map();
  for (const p of products) {
    if (!isFinished(p)) continue;
    const d = calcDuration(p);
    if (d == null || !Number.isFinite(d) || d <= 0) continue;
    const k = p.productType || '';
    if (!k) continue;
    if (!lifespans.has(k)) lifespans.set(k, []);
    lifespans.get(k).push(d);
  }
  const meanLifespan = new Map();
  for (const [k, arr] of lifespans) {
    if (arr.length < MIN_FINISHED_PER_TYPE) continue;
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    meanLifespan.set(k, mean);
  }

  // v0.3.3: suppress a reorder reminder only while there's a spare beyond the
  // unit running low — i.e. 2+ on-hand units of the type (active + inventory;
  // finished don't count). Once you're down to your last unit (on-hand == 1),
  // the reminder fires so you know to restock before you're empty.
  //
  // This refines v0.3.1, which suppressed whenever ANY inventory of the type
  // existed. That silenced every type the user keeps a rolling backup of —
  // permanently — so no reminder ever fired for their highest-turnover items.
  // Counting on-hand units instead means the reminder returns as soon as the
  // backup becomes the active one with nothing left behind it. Matched by
  // productType (the category), consistent with how the whole reminder system
  // groups.
  const onHandByType = new Map();
  for (const p of products) {
    if ((isActive(p) || isInventory(p)) && p.productType) {
      onHandByType.set(p.productType, (onHandByType.get(p.productType) || 0) + 1);
    }
  }

  // For each active, check ratio against its type's mean.
  const out = [];
  for (const p of products) {
    if (!isActive(p)) continue;
    const k = p.productType || '';
    // v0.3.3: only suppress while a spare exists beyond this unit (>=2 on hand).
    if ((onHandByType.get(k) || 0) >= 2) continue;
    const mean = meanLifespan.get(k);
    if (mean == null) continue;
    const dur = calcDuration(p);
    if (dur == null) continue;
    const ratio = dur / mean;
    if (ratio < REMINDER_THRESHOLD) continue;
    out.push({
      product: p,
      currentDays: dur,
      meanDays: Math.round(mean),
      ratio,
      pastDue: ratio >= 1,
    });
  }
  out.sort((a, b) => b.ratio - a.ratio);
  return out.slice(0, REMINDER_MAX);
}

// ═════════════════════════════════════════════════════════════════════
// EMAIL — build a clean digest. Both HTML and plain-text bodies so any
// client renders something reasonable.
// ═════════════════════════════════════════════════════════════════════

// v0.3.0: exported so scripts/generate-previews.mjs can render a static
// HTML preview file without needing the cron / Firestore stack.
// v0.3.4: `opts.test` renders the same email with a [TEST] subject prefix and
// an explanatory banner, so a deliverability check is unmistakable in the
// inbox and can never be mistaken for a real reorder nudge.
export function buildReminderEmail(reminders, opts = {}) {
  const n = reminders.length;
  const isTest = !!opts.test;
  const baseSubject = n === 1
    ? `Reorder reminder: ${reminders[0].product.productName || 'a product'}`
    : `Reorder reminders: ${n} products running low`;
  const subject = isTest ? `[TEST] ${baseSubject}` : baseSubject;

  // v0.2.0: app URL points at the canonical dev.rizzo.cc deployment
  // (the github.io URL still works but dev.rizzo.cc is now the source-
  // of-truth front-end).
  const appUrl = 'https://dev.rizzo.cc/usage/';

  // v0.2.0: short-date formatter for the estimated finish date column.
  // "May 18" (current year) or "May 18, 2027" if not current year.
  const formatFinishDate = (d) => {
    if (!d || !Number.isFinite(d.getTime())) return null;
    const now = new Date();
    const opts = d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
    return d.toLocaleDateString('en-US', opts);
  };

  const rows = reminders.map((r) => {
    const remaining = r.meanDays - r.currentDays;
    const status = r.pastDue
      ? `${Math.abs(remaining)}d past avg`
      : `~${remaining}d left`;
    const name = r.product.productName || '(unnamed)';
    const type = r.product.productType || '';

    // v0.2.0: estimated completion date — start date + this product type's
    // mean lifespan. Past-due items show as "Expected to finish: <date>"
    // even though that date is already in the past, which signals exactly
    // how overdue the item is in plain calendar terms.
    let finishLabel = null;
    const start = parseLocalDate(r.product.startDate);
    if (start && r.meanDays > 0) {
      const finish = new Date(start.getTime() + r.meanDays * 86400000);
      finishLabel = formatFinishDate(finish);
    }

    return { name, type, currentDays: r.currentDays, meanDays: r.meanDays, status, pastDue: r.pastDue, finishLabel };
  });

  const text = [
    ...(isTest
      ? ['*** THIS IS A TEST EMAIL ***',
         'Sent manually to confirm reminder delivery is working. The items below',
         'are examples — no action needed.',
         '']
      : []),
    n === 1
      ? `One product is running low based on your average lifespan history:`
      : `${n} products are running low based on your average lifespan history:`,
    '',
    ...rows.map((r) => {
      const finishPart = r.finishLabel ? ` · expected ${r.finishLabel}` : '';
      return `• ${r.name}${r.type ? ' (' + r.type + ')' : ''}: ${r.currentDays}d of ~${r.meanDays}d avg — ${r.status}${finishPart}`;
    }),
    '',
    'Open the app to mark them finished or start a new bundle:',
    appUrl,
    '',
    'Manage your reminder email preference under Settings in the app.',
    '',
    '— Usage Tracker',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f5f7fb;margin:0;padding:24px;color:#1a2238">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e7ef;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(20,30,60,0.08)">
    ${isTest ? `<div style="padding:12px 24px;background:#eef3ff;border-bottom:1px solid #cfdcff;color:#2b5fd9;font-size:13px;line-height:1.5">
      <strong>This is a test email.</strong> It was sent manually to confirm reminder delivery is working. The items below are examples — no action needed.
    </div>` : ''}
    <div style="padding:20px 24px;border-bottom:1px solid #e3e7ef;background:linear-gradient(135deg,#fff8e6 0%,#fffaf0 100%)">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#d98f2b;font-weight:700;margin-bottom:4px">Reorder soon</div>
      <h1 style="margin:0;font-size:18px;font-weight:600;letter-spacing:-0.01em">
        ${escapeHtml(n === 1 ? 'One product is running low' : `${n} products are running low`)}
      </h1>
    </div>
    <div style="padding:16px 24px">
      <p style="margin:0 0 14px;font-size:14px;color:#6b7390;line-height:1.5">
        Based on your average lifespan history for these product types, here's what to keep an eye on:
      </p>
      <div style="display:grid;gap:8px">
        ${rows.map((r) => `
          <div style="border:1px solid #ecd9a9;border-radius:6px;padding:10px 14px;background:#fffdf6">
            <div style="font-weight:600;font-size:14px;margin-bottom:2px">${escapeHtml(r.name)}</div>
            <div style="font-size:12px;color:#6b7390;margin-bottom:6px">
              ${escapeHtml(r.type)}${r.type ? ' · ' : ''}${r.currentDays}d of ~${r.meanDays}d avg
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
              <span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;
                ${r.pastDue
                  ? 'background:#fbeaea;color:#c23b3b'
                  : 'background:#fff3d6;color:#8a5a00'}">
                ${escapeHtml(r.status)}
              </span>
              ${r.finishLabel ? `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;background:#eef3ff;color:#2b5fd9">${escapeHtml(r.pastDue ? 'was due ' + r.finishLabel : 'expected ' + r.finishLabel)}</span>` : ''}
            </div>
          </div>`).join('')}
      </div>
      <p style="margin:18px 0 0;font-size:13px;line-height:1.5">
        <a href="${appUrl}" style="display:inline-block;background:#2b5fd9;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px">
          Open Usage Tracker
        </a>
      </p>
    </div>
    <!-- v0.2.0: footer rebuilt as a stacked vertical block with a clear
         brand line, a one-sentence rationale, and a settings hint. Inline
         styles only since email clients strip class-based CSS. Center-
         aligned so it reads as a quiet sign-off rather than a status bar. -->
    <div style="padding:18px 24px;border-top:1px solid #e3e7ef;background:#f8fafe;text-align:center">
      <div style="font-size:13px;font-weight:600;color:#1a2238;letter-spacing:-0.005em;margin-bottom:6px">
        Usage Tracker
      </div>
      <div style="font-size:11px;color:#6b7390;line-height:1.55;max-width:380px;margin:0 auto">
        You're getting this because you opted in to reorder reminders.
        Open the app and visit <strong style="color:#1a2238;font-weight:600">Settings</strong> to change your preferences or turn this off.
      </div>
      <div style="font-size:11px;color:#9ba5bf;margin-top:10px">
        <a href="${appUrl}" style="color:#9ba5bf;text-decoration:none">${escapeHtml(appUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>
      </div>
    </div>
  </div>
</body></html>`;

  return { subject, html, text };
}

// v0.3.0: recall-alerts email template. NOT YET WIRED INTO A CRON —
// this is the deferred Full v2 of the recall feature documented in
// project_usage_tracker.md "Planned features". Available here as an
// exported function so the upcoming weekly recall-check cron can call
// it once that's built, and so the preview generator can render a
// pixel-accurate static HTML file for visual review.
//
// Input shape mirrors what checkRecalls() returns in the in-app
// banner (app.js v0.21.0):
//   reminderNumber, brand, productDescription, reason, date (YYYYMMDD),
//   classification ('Class I' | 'Class II' | 'Class III'), recallingFirm,
//   fdaUrl.
export function buildRecallEmail(recalls) {
  const n = recalls.length;
  const subject = n === 1
    ? `Recall alert: ${recalls[0].brand || 'a tracked brand'}`
    : `Recall alerts: ${n} of your brands have open FDA recalls`;

  // Same canonical app URL as the reminder email — both point at
  // dev.rizzo.cc/usage since v0.2.0.
  const appUrl = 'https://dev.rizzo.cc/usage/';

  // Parse FDA's YYYYMMDD date format → human-readable. Re-derived
  // inline so we don't import the helper used by computeReminders.
  const parseFdaDate = (s) => {
    if (!s) return null;
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s).trim());
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  const formatDate = (d) => {
    if (!d || !Number.isFinite(d.getTime())) return null;
    const now = new Date();
    const opts = d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
    return d.toLocaleDateString('en-US', opts);
  };

  // Severity → tier label + CSS color triplet for the card stripe + pill.
  const sevInfo = (classification) => {
    const c = String(classification || '').toLowerCase();
    if (c.includes('class i') && !c.includes('class ii') && !c.includes('class iii')) {
      return {
        label: 'Class I · severe',
        // Most serious — red.
        stripe: '#c23b3b',
        pillBg: '#fbeaea',
        pillColor: '#c23b3b',
      };
    }
    if (c.includes('class ii')) {
      return {
        label: 'Class II · moderate',
        stripe: '#d98f2b',
        pillBg: '#fff3d6',
        pillColor: '#8a5a00',
      };
    }
    if (c.includes('class iii')) {
      return {
        label: 'Class III · low',
        stripe: '#2b5fd9',
        pillBg: '#e3edff',
        pillColor: '#2b5fd9',
      };
    }
    return {
      label: 'Recall',
      stripe: '#d98f2b',
      pillBg: '#fff3d6',
      pillColor: '#8a5a00',
    };
  };

  const rows = recalls.map((r) => {
    const sev = sevInfo(r.classification);
    const dateStr = formatDate(parseFdaDate(r.date));
    // Truncate the product description so the card stays scannable.
    const desc = String(r.productDescription || '');
    const truncDesc = desc.length > 160 ? desc.slice(0, 160) + '…' : desc;
    return {
      brand: r.brand || '',
      productDescription: truncDesc,
      reason: r.reason || '',
      dateStr,
      sev,
      fdaUrl: r.fdaUrl || '',
    };
  });

  const text = [
    n === 1
      ? `One of your tracked brands has an open FDA recall:`
      : `${n} of your tracked brands have open FDA recalls:`,
    '',
    ...rows.map((r) => {
      const datePart = r.dateStr ? ` · issued ${r.dateStr}` : '';
      const sevPart = r.sev.label ? ` [${r.sev.label}]` : '';
      const linkPart = r.fdaUrl ? `\n  ${r.fdaUrl}` : '';
      return `• ${r.brand}${sevPart}${datePart}\n  ${r.productDescription}\n  Reason: ${r.reason}${linkPart}`;
    }),
    '',
    'Brand-only matches are imprecise — always verify on the FDA page',
    'before assuming a specific product is affected.',
    '',
    'Open the app to dismiss alerts or change your preferences:',
    appUrl,
    '',
    '— Usage Tracker',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f5f7fb;margin:0;padding:24px;color:#1a2238">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e7ef;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(20,30,60,0.08)">
    <div style="padding:20px 24px;border-bottom:1px solid #e3e7ef;background:linear-gradient(135deg,#fdf4f4 0%,#fff8f8 100%)">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#c23b3b;font-weight:700;margin-bottom:4px">Open FDA recalls</div>
      <h1 style="margin:0;font-size:18px;font-weight:600;letter-spacing:-0.01em">
        ${escapeHtml(n === 1 ? 'A brand in your tracker has an open recall' : `${n} brands in your tracker have open recalls`)}
      </h1>
    </div>
    <div style="padding:16px 24px">
      <p style="margin:0 0 14px;font-size:14px;color:#6b7390;line-height:1.5">
        Brand-only matches are imprecise — these recalls were issued for one of your tracked brands, but the specific product affected may not be the one on your shelf. Always verify on the FDA page before acting.
      </p>
      <div style="display:grid;gap:8px">
        ${rows.map((r) => `
          <div style="border:1px solid #e3e7ef;border-left:4px solid ${r.sev.stripe};border-radius:6px;padding:10px 14px;background:#fff">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px">
              <span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;background:${r.sev.pillBg};color:${r.sev.pillColor}">
                ${escapeHtml(r.sev.label)}
              </span>
              ${r.dateStr ? `<span style="font-size:11px;color:#6b7390">Issued ${escapeHtml(r.dateStr)}</span>` : ''}
            </div>
            <div style="font-weight:600;font-size:14px;margin-bottom:4px">${escapeHtml(r.brand)}</div>
            <div style="font-size:12px;color:#6b7390;line-height:1.45;margin-bottom:6px">${escapeHtml(r.productDescription)}</div>
            <div style="font-size:12px;color:#1a2238;line-height:1.5;margin-bottom:8px">${escapeHtml(r.reason)}</div>
            ${r.fdaUrl ? `<a href="${escapeHtml(r.fdaUrl)}" style="font-size:12px;color:#2b5fd9;text-decoration:none;font-weight:500">View FDA details &rarr;</a>` : ''}
          </div>`).join('')}
      </div>
      <p style="margin:18px 0 0;font-size:13px;line-height:1.5">
        <a href="${appUrl}" style="display:inline-block;background:#2b5fd9;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px">
          Open Usage Tracker
        </a>
      </p>
    </div>
    <div style="padding:18px 24px;border-top:1px solid #e3e7ef;background:#f8fafe;text-align:center">
      <div style="font-size:13px;font-weight:600;color:#1a2238;letter-spacing:-0.005em;margin-bottom:6px">
        Usage Tracker
      </div>
      <div style="font-size:11px;color:#6b7390;line-height:1.55;max-width:380px;margin:0 auto">
        You're getting this because you opted in to recall alerts.
        Open the app and visit <strong style="color:#1a2238;font-weight:600">Settings</strong> to change your preferences or turn this off.
      </div>
      <div style="font-size:11px;color:#9ba5bf;margin-top:10px">
        <a href="${appUrl}" style="color:#9ba5bf;text-decoration:none">${escapeHtml(appUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>
      </div>
    </div>
  </div>
</body></html>`;

  return { subject, html, text };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// ═════════════════════════════════════════════════════════════════════
// SERVICE ACCOUNT AUTH (Google OAuth2 JWT exchange) — mirrors stocks-worker.
// Used to call Firestore REST and Identity Toolkit on behalf of the project.
// ═════════════════════════════════════════════════════════════════════

let _accessTokenCache = null;

async function getServiceAccountToken(env) {
  if (_accessTokenCache && _accessTokenCache.expiresAt > Date.now() + 60_000) {
    return _accessTokenCache.token;
  }

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const enc = new TextEncoder();
  const headerB64 = b64url(btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claimB64 = b64url(btoa(JSON.stringify(claim)));
  const unsigned = `${headerB64}.${claimB64}`;

  const privateKey = await pemToCryptoKey(sa.private_key);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(unsigned));
  const sigB64 = b64url(arrayBufferToBase64(sigBuf));

  const jwt = `${unsigned}.${sigB64}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Service account token exchange failed: ${resp.status} ${errTxt}`);
  }
  const data = await resp.json();
  _accessTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 120) * 1000,
  };
  return data.access_token;
}

function b64url(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function pemToCryptoKey(pem) {
  const stripped = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const der = Uint8Array.from(atob(stripped), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8', der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
}

// ═════════════════════════════════════════════════════════════════════
// FIRESTORE REST helpers — get a doc, list a collection, patch fields.
// ═════════════════════════════════════════════════════════════════════

async function firestoreGetDoc(env, accessToken, path) {
  const url = `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Firestore GET ${path} failed: ${resp.status} ${errTxt}`);
  }
  return resp.json();
}

async function firestoreListDocs(env, accessToken, collectionPath) {
  // Paginate just in case (50+ products would still be one page since
  // pageSize defaults are generous, but be safe).
  const docs = [];
  let pageToken = null;
  for (let i = 0; i < 10; i++) {
    const url = new URL(
      `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collectionPath}`
    );
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) {
      const errTxt = await resp.text();
      throw new Error(`Firestore LIST ${collectionPath} failed: ${resp.status} ${errTxt}`);
    }
    const data = await resp.json();
    if (Array.isArray(data.documents)) {
      for (const d of data.documents) {
        if (d.fields) docs.push(fsFieldsToJs(d.fields));
      }
    }
    if (data.nextPageToken) pageToken = data.nextPageToken;
    else break;
  }
  return docs;
}

async function firestorePatchFields(env, accessToken, path, fieldPathsToValues) {
  const fields = {};
  const masks = [];
  for (const [fp, value] of Object.entries(fieldPathsToValues)) {
    masks.push(fp);
    setNestedFsValue(fields, fp.split('.'), value);
  }
  const mask = masks.map((m) => `updateMask.fieldPaths=${encodeURIComponent(m)}`).join('&');
  const url = `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}?${mask}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Firestore PATCH ${path} failed: ${resp.status} ${errTxt}`);
  }
  return resp.json();
}

function setNestedFsValue(target, parts, jsValue) {
  if (parts.length === 1) {
    target[parts[0]] = jsToFsValue(jsValue);
    return;
  }
  if (!target[parts[0]]) target[parts[0]] = { mapValue: { fields: {} } };
  setNestedFsValue(target[parts[0]].mapValue.fields, parts.slice(1), jsValue);
}

function fsFieldsToJs(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fsValueToJs(v);
  return out;
}

function fsValueToJs(v) {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsValueToJs);
  if ('mapValue' in v) return fsFieldsToJs(v.mapValue.fields || {});
  return undefined;
}

function jsToFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(jsToFsValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = jsToFsValue(val);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

// ═════════════════════════════════════════════════════════════════════
// IDENTITY TOOLKIT — look up a Firebase user's email by UID.
// ═════════════════════════════════════════════════════════════════════

async function getUserEmail(env, accessToken, uid) {
  const url = `${IDENTITY_BASE}/projects/${env.FIREBASE_PROJECT_ID}/accounts:lookup`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ localId: [uid] }),
  });
  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Identity Toolkit lookup failed: ${resp.status} ${errTxt}`);
  }
  const data = await resp.json();
  return data.users && data.users[0] && data.users[0].email;
}

// ═════════════════════════════════════════════════════════════════════
// RESEND — send a single rolled-up reminder email per cron run.
// ═════════════════════════════════════════════════════════════════════

async function sendReminderEmail(env, { to, subject, html, text }) {
  const resp = await fetch(`${RESEND_BASE}/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.SENDER_FROM, to, subject, html, text }),
  });
  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Resend send failed: ${resp.status} ${errTxt}`);
  }
  return resp.json();
}
