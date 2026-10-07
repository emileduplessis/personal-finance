# Public Launch Plan

Goal: make the app usable by **new and average users**, not just its builder.
Each phase ends with a verification pass and a commit. Resume from the first
unchecked item. `[user]` = needs an action only the account owner can do.

## ⚠ Go-public blockers (as of 2026-07-13) — all `[user]`, Supabase-side

- [x] **Lock down `public.rls_auto_enable()`** — DONE 2026-07-13: revoke ran in
      prod; verified anon + authenticated RPC calls now return 42501 "permission
      denied for function rls_auto_enable" (was executable before).
- [x] **Enforce email confirmation** — confirmed ON in Supabase (2026-10-07).
- [ ] **Paid tier + backups** — free tier pauses on inactivity and has no PITR;
      upgrade + enable backups before real users depend on their data.
- Nice-to-have next: raise min password length; add a CSP header (needs testing
      against Supabase/CDN/CoinGecko/Blockstream origins). Done in code 2026-07-13:
      dashboard at `/`, HSTS + nosniff + frame-DENY + referrer + permissions headers.

## Phase 1 — Multi-tenant hardening

- [x] RLS policies exist for all tables in `supabase-schema.sql` (accounts,
      transactions, user_settings, subscriptions, crypto_wallets, shifts,
      shift_payouts, jobs — all `auth.uid() = user_id`)
- [x] RLS **live-audit script** written: `supabase-verify-rls.sql`
- [x] `[user]` Ran `supabase-verify-rls.sql` in prod (2026-07-11): **9/9 tables**
      `rls_enabled=true`, each with one `own …` policy — accounts, crypto_wallets,
      jobs, recurring_rules, shift_payouts, shifts, subscriptions, transactions,
      user_settings. Clean pass (failure/non-uid scans empty)
- [x] `[user]` Security Advisor: `public.rls_auto_enable()` EXECUTE revoked from
      anon/authenticated (2026-07-13, see blockers above)
- [x] Auth lifecycle complete in `login.html`: signup confirmation, resend,
      forgot password, recovery view (verified 2026-07-11)
- [x] CoinGecko proxy (`api/crypto.js`) has in-memory + CDN cache → shared
      upstream calls, survives 429s with stale fallback
- [x] No secrets committed (grep audit 2026-07-11; anon key is public by design)
- [x] `[user]` Supabase email confirmation ON (paid tier + backups tracked
      in the blockers above)
- Note: BTC/SOL balance lookups are client-side per-address (Blockstream /
  publicnode) — per-user, uncacheable server-side, acceptable at launch scale.

## Phase 2 — First-run UX (new-user experience)

- [x] De-personalize Hours Tracker: `$17/h` fallback removed from
      `scripts/pages/shifts.js` (`jobRate()`, `quickLog()`, quick-log meta) —
      a missing rate now prompts "Set an hourly rate for this job" and opens
      the job modal instead of inventing a number
- [x] First-run onboarding: dashboard "Welcome to Flow" card (`#firstRunCard`)
      shown only with 0 accounts + 0 transactions, dismissable, 3 linked steps
      (account → transaction → currency); auto-hides once data exists
- [x] Empty-state audit: dashboard widgets, insights, budget onboarding,
      shifts, spending, transactions, accounts, crypto all have empty states
- [x] Verify (2026-07-11): card rendered desktop + mobile in preview (Flow
      style holds), 142/142 tests green

## Phase 3 — Legal & trust

- [x] `pages/privacy.html` + `pages/terms.html` (Flow style, unauthenticated),
      linked from login footer + Settings → About
- [x] Crypto page trust copy: existing read-only/never-keys note extended with
      "holds nothing and can never move your funds"
- [x] Contact: mailto rows in Settings → About (feedback + security) and in
      both legal pages
- Note: contact address is the personal Gmail — consider a dedicated
      support address before wide launch

## Phase 4 — Ops & reliability

- [x] GitHub Actions CI: `.github/workflows/ci.yml` — `npm test` on push/PR
- [x] Client error reporting: uncaught errors/rejections POST to
      `api/log-error.js` → Vercel function logs (throttled, no user data,
      localhost excluded). Debug overlay flipped to OPT-IN (`pf_debug=1`)
      so public users never see dev toasts
- [x] Feedback link in Settings (About section, done in Phase 3)
- [x] `[user]` Vercel Analytics enabled on the project

## Phase 5 — Public face

- [x] Landing page `welcome.html`: hero, 6 feature blocks, trust section,
      legal footer, sign-up CTA; linked from login ("What is Flow?")
- [x] OG/social meta + meta description on the landing page
- [x] PRODUCT.md Users section rewritten for a public audience (no hardcoded
      personal defaults rule added)
- [x] Custom domain: flownetworth.com
- [ ] Optional: screenshots on the landing page, swap `/` to the landing
      for logged-out visitors
