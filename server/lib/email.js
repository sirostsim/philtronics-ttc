/**
 * lib/email.js
 *
 * Lightweight transactional email via the Resend HTTP API (no SMTP server, no new
 * dependency - uses Node 20's global fetch). Degrades gracefully when unconfigured
 * (logs instead of sending and returns { sent:false }), like server/r2.js, so the
 * app works fine before the env vars are set and a send failure never throws.
 *
 * Env (Railway app service, never committed):
 *   RESEND_API_KEY   - Resend API key
 *   EMAIL_FROM       - from address, e.g. "Philtronics Work Time <noreply@yourdomain>"
 *   EMAIL_REPLY_TO   - optional reply-to address
 */
'use strict';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const KEY   = process.env.RESEND_API_KEY || '';
const FROM  = process.env.EMAIL_FROM || 'Philtronics Work Time <onboarding@resend.dev>';
const REPLY = process.env.EMAIL_REPLY_TO || '';

function emailEnabled() { return !!KEY; }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Wrap body HTML in a simple, branded, email-client-safe layout (inline styles,
// table-free, light theme - emails are not the dark app). Optional call-to-action.
function layout({ title, bodyHtml, cta }) {
  const btn = cta && cta.url
    ? '<p style="margin:28px 0 8px"><a href="' + escapeHtml(cta.url) + '" style="display:inline-block;background:#e0a92e;color:#1a1400;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px">' + escapeHtml(cta.label || 'Open') + '</a></p>'
    : '';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>' +
    '<body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a2230;line-height:1.55">' +
    '<div style="max-width:560px;margin:0 auto;padding:24px 16px">' +
    '<div style="font-weight:800;letter-spacing:.12em;font-size:14px;color:#1e3a5f;margin-bottom:16px">PHILTRONICS <span style="color:#7a8694;font-weight:600;letter-spacing:.04em">Work Time</span></div>' +
    '<div style="background:#ffffff;border:1px solid #e3e8ee;border-radius:10px;padding:28px 30px">' +
    (title ? '<h1 style="margin:0 0 14px;font-size:19px;color:#141922">' + escapeHtml(title) + '</h1>' : '') +
    bodyHtml + btn +
    '</div>' +
    '<p style="color:#8a94a2;font-size:11.5px;margin:16px 4px 0">This is an automated message from Philtronics Work Time. Please do not reply directly.</p>' +
    '</div></body></html>';
}

// Strip tags for a plain-text fallback.
function toText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Send an email. Never throws on a provider/network failure: returns a result the
// caller can act on (e.g. warn an admin that the invite email could not be sent).
async function sendEmail({ to, subject, html, text }) {
  if (!to || !subject) throw new Error('sendEmail requires "to" and "subject".');
  const recipients = Array.isArray(to) ? to : [to];
  if (!emailEnabled()) {
    console.log('[email] not configured (RESEND_API_KEY unset); would send:', subject, '->', recipients.join(', '));
    return { sent: false, reason: 'email-not-configured' };
  }
  try {
    const payload = { from: FROM, to: recipients, subject, html };
    if (text) payload.text = text; else if (html) payload.text = toText(html);
    if (REPLY) payload.reply_to = REPLY;
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[email] send failed', res.status, body.slice(0, 300));
      return { sent: false, reason: 'provider-error', status: res.status };
    }
    const data = await res.json().catch(() => ({}));
    return { sent: true, id: data && data.id ? data.id : null };
  } catch (err) {
    console.error('[email] send error:', err.message);
    return { sent: false, reason: 'exception' };
  }
}

module.exports = { sendEmail, emailEnabled, layout, escapeHtml, toText };
