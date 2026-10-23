# Railway security incident - October 2026 - secret rotation runbook

## What happened

Railway disclosed a security breach on **21 October 2026**. An unauthorised
party accessed the systems that store customer **environment variables**, and
for some accounts obtained the **decrypted values**. This is a platform breach,
not a bug in our code: there is no CVE and nothing to patch. Railway paused all
builds/deploys, rotated its own storage-bucket credentials, and invalidated all
Public API tokens and OAuth sessions.

Railway's guidance to every customer: **assume every secret stored in Railway is
compromised and rotate it.**

## Code-side audit (done 22 Oct 2026)

Verified before rotating - nothing to fix in the app:

- No `.env` was ever committed to git history (only `.env.example`, placeholders
  only).
- `JWT_SECRET` has no hardcoded fallback; `jwt.sign/verify` read the env var
  directly, so the app fails closed if it is missing. Rotation is clean.
- No secret values are logged anywhere (only presence / subject / recipients).
- No CI pipeline or Railway API token in the repo (deploys are git-push
  auto-deploy), so there is no pipeline token to rotate.

Conclusion: this is purely a secret-rotation exercise in the Railway dashboard
and the two external provider consoles (Cloudflare R2, Resend).

## The secrets this app stores in Railway

Derived from every `process.env.*` the app reads. Rotate in this order.

| # | Secret | Where to rotate | Notes / impact |
|---|--------|-----------------|----------------|
| 1 | `JWT_SECRET` | Railway -> Variables. Generate: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` | Most urgent. If leaked, an attacker can forge a session cookie for any user incl. superuser, bypassing password AND 2FA. Rotating logs out every staff user and every portal customer (expected). |
| 2 | `DATABASE_URL` | Railway -> Postgres service -> Config -> Connection -> Regenerate (do not hand-edit) | Regenerate restarts Postgres, then redeploy the app. See "Database exposure" below. |
| 3 | `SU_PASSWORD` | Railway -> Variables | Superuser bootstrap password. Set a new value and redeploy; `seedSuperuser()` updates the live superuser hash from env on boot. |
| 4 | `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` | Cloudflare R2 console | Create a new API token, update both in Railway, redeploy, then delete the old token. |
| 5 | `RESEND_API_KEY` | Resend dashboard | Create a new key, update Railway, redeploy, delete the old key. |

### Not secret - leave as-is

`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`, `SU_USERNAME`,
`SU_FULL_NAME`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_INTERNAL_TO`,
`PUBLIC_BASE_URL`, `PORT`, `NODE_ENV`, `BCRYPT_ROUNDS`, `JWT_EXPIRES_IN`,
`LOGIN_RATE_LIMIT`.

### Platform-level

- Re-log in to Railway (OAuth sessions were invalidated).
- Reconnect GitHub in Railway so auto-deploy keeps working (Railway invalidated
  the tokens it held).
- No Railway Public API token is used by this project, so none to recreate.

## Rotation method (per secret)

Containers read environment variables only at startup, so a value change has no
effect until a redeploy.

1. Create the new credential at the provider.
2. Update the variable in Railway.
3. Redeploy the app and wait for it to come up.
4. Verify the app works with the new credential (see below).
5. Revoke / delete the old credential.

If a provider forces revoke-before-create, run steps 1-5 as one short window.

## Database exposure - the key judgement call

`DATABASE_URL` was itself stored in Railway env, so anyone who obtained it could
in principle have read the whole database - which includes bcrypt password
hashes (hard to crack) and **plaintext TOTP secrets** (2FA shared secrets). The
deciding factor is whether our Postgres was publicly reachable:

- If `DATABASE_URL` points at an internal host (`*.railway.internal`), the
  leaked string alone grants no outside access. Lower risk, but still rotate.
- If it uses a public proxy host, treat the DB contents as potentially exposed.

If public (or if in doubt), after rotating the DB credentials:

- Check `pg_stat_activity` for unknown clients and the DB connection logs for
  access you did not make.
- Consider forcing a password reset for staff and 2FA re-enrolment (TOTP secrets
  are plaintext in the DB and would be compromised if the DB was read).

## Verification checklist

- [ ] Old keys are dead: deploy logs show no "authentication failed" against new
      values; old provider keys show revoked/inactive.
- [ ] New keys work: successful DB connection on boot, an avatar loads from R2,
      a test portal invite email sends via Resend.
- [ ] All staff and portal users can log in again (expected after `JWT_SECRET`
      rotation).
- [ ] Superuser can log in with the new `SU_PASSWORD`.
- [ ] Reviewed R2, Resend, GitHub and (if applicable) Postgres audit/usage logs
      for anomalous activity.
- [ ] Recorded each rotation (what, when, who, what was checked).

## Sources

- Railway status page: https://status.railway.com/
- Railway security disclosure (21 Oct 2026), linked from the status page.
