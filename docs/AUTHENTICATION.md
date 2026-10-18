# Authentication & Access Control

How identity works in Bahirjee — who can do what, how it is enforced, what production
should look like, and how it actually behaves today while we are testing.

> **Read this first if** you are changing sign-in, roles, RLS policies, brief sharing, or
> anything under `lib/handlers/auth-link.js`, `lib/_auth.js`, or `src/context/AuthContext.jsx`.

**No credentials appear in this document.** Test logins are set by the seed scripts in
`sql/`; see [Testing setup](#testing-setup) for how to set or reset one.

---

## 1. At a glance

| | Production target | Today (testing) |
|---|---|---|
| **Admin sign-in** | Individual account per admin, password | One shared `admin@bahirjee.in`, password set by SQL seed |
| **Admin MFA** | Planned, not scoped | None |
| **Invited user sign-in** | Magic link (email click) | ✅ Same — already correct |
| **Client-domain visitor** | Magic link (proves they own the address) | ⚠️ **Instant session, no verification** |
| **Brief access** | Identity-based (email decides) | ✅ Same — already correct |
| **Dev bypass** | Impossible in prod | Guarded by `NODE_ENV` **and** `VERCEL_ENV` |
| **Internal service auth** | Dedicated `INTERNAL_API_KEY` | Falls back to service-role key if unset |

Two rows are deliberate testing shortcuts that **must change before production** — see
[§6 Gap register](#6-gap-register).

---

## 2. Functional model

### 2.1 Roles

Three roles, constrained in the database (`profiles.role`, `email_allowlist.role`):

| Role | Who they are | Can do | Cannot do |
|---|---|---|---|
| `admin` | Bahirjee staff | Everything: all clients, all briefs, user management, run analyses | — |
| `client_user` | A founder/teammate **invited by an admin** | Run analyses, view their org's briefs, ask questions, add notes | Admin console |
| `brief_viewer` | Someone who arrived because their **email domain matches a client** | **Read** their org's briefs only | Run analyses (costs money), admin console |

The `client_user` / `brief_viewer` split is the cost control: a run costs real money and
consumes freemium credits, so *self-arrived* users are read-only. Being able to run an
analysis requires a deliberate admin invite.

### 2.2 The three ways in

**Admin →** `/admin/login`, email + password. Admins are *explicitly barred* from the
magic-link path: `auth-link` detects an admin address and returns without sending
anything, so an admin cannot bootstrap themselves through the founder door.

**Invited user →** `/`, enters email, receives a magic link by email, clicks it. Their
invite created an `email_allowlist` row, which is what admits them and sets their role.

**Client-domain visitor →** `/` or a shared brief link, enters email. If the domain
belongs to an **active** client they are signed in and provisioned `brief_viewer`.
*(Today this is instant with no verification — see [§6](#6-gap-register).)*

Anyone else gets no access, and on a brief page is offered **Request access**, which
queues a request for an admin to approve or deny.

### 2.3 Who can open a shared brief

A share link (`/report/:shareToken`) is **identity-based**: the token says *which* brief,
the viewer's email decides *whether* they may see it. Evaluated in `can_access_report()`:

1. **Blocked** for this client → **deny** (a block always wins, overriding everything below)
2. Platform admin → allow
3. Member of the owning client (`profiles.client_id` matches) → allow
4. Email domain matches the owning client's **active** domain → allow
5. Active `email_allowlist` grant for that client → allow
6. Otherwise → **deny** → the page offers *Request access*

Every successful open is written to `report_access_log` (report, client, user, **email**,
route, timestamp). Email is denormalised on purpose: `profiles` has no email column,
`auth.users` is not readable from the browser, and the record should survive user deletion.

> **History note.** This used to be *capability*-based — possession of the token let **any**
> authenticated user read the brief, including users from other clients. That cross-org leak
> is closed; `get_shared_report()` now enforces the list above.

### 2.4 Admin controls

In `/admin/clients/:clientId`:

- **Team Members** — invite (creates auth user + profile + allowlist row as `client_user`), activate/suspend, delete
- **Email Exceptions** — grant a named outside address access to this client's briefs
- **Blocked Emails** — revoke a specific person, even one whose domain matches
- **Access Requests** — approve (creates an allowlist grant) or deny
- **Brief access log** — per brief: which emails opened it, how many times, first/last seen

---

## 3. Technical implementation

### 3.1 Tools

| Concern | Tool / method |
|---|---|
| Identity provider | **Supabase Auth** (GoTrue) — `@supabase/supabase-js` |
| Password sign-in | `supabase.auth.signInWithPassword()` |
| Magic link (email sent) | `supabase.auth.signInWithOtp()` — anon client |
| Instant session (no email) | `auth.admin.generateLink()` server-side → `verifyOtp({ token_hash })` in browser |
| Password reset | `resetPasswordForEmail()` → `updateUser({ password })` |
| Session storage | supabase-js default (browser localStorage), JWT |
| Server-side verification | `auth.getUser(token)` with the service-role client |
| Authorisation | Postgres **RLS** + `SECURITY DEFINER` functions |
| Rate limiting | Upstash Redis, in-memory fallback (`lib/_security.js`) |

### 3.2 Where identity is enforced — three layers

**Layer 1 — Browser (UX only, never trusted).**
`src/context/AuthContext.jsx` holds `user` + `profile`, and signs out immediately if a
loaded profile has `is_active = false`. `src/components/ProtectedRoute.jsx` gates `/admin`
by role and redirects anonymous visitors to `/admin/login`.

**Layer 2 — API.** `requireAuthenticatedUser()` in `lib/_auth.js` is the single entry
point for every authenticated route:

```
Bearer token → auth.getUser() → load profile → reject if is_active === false
             → reject if requireAdmin && role !== 'admin' → optional per-user rate limit
```

**Layer 3 — Database (the real boundary).** RLS is enabled on every table. Admins bypass
via the `is_admin()` `SECURITY DEFINER` helper. Brief access runs through
`can_access_report()` / `get_shared_report()`.

Layer 3 is what actually protects data — layers 1 and 2 are convenience and defence in
depth. A bug in the frontend cannot expose another client's briefs.

### 3.3 `/api/auth-link` — the routing brain

One endpoint decides how a given email gets in. Order matters:

| # | Condition | Outcome | Response |
|---|---|---|---|
| 1 | Address is an admin (`ADMIN_EMAILS` env or allowlist `role='admin'`) | **Nothing sent** — use `/admin/login` | `{ adminRedirect: true }` |
| 2 | Domain matches an **active** client, or is in `AUTO_ACCESS_DOMAINS` | Instant session | `{ autoAccess: true, tokenHash }` |
| 3 | Active `email_allowlist` row (domain isn't a client's) | Magic link **emailed** | `{ emailSent: true }` |
| 4 | Anything else | No access | `{ noAccess: true }` |

Step 1 must stay first — otherwise an admin whose address sits on a client domain would
fall into step 2 and get a passwordless session.

Step 2 returns a `tokenHash` the browser immediately redeems via `verifyOtp()`, which is
how sign-in happens with no email round-trip. Step 4 returns `noAccess` rather than a bare
success so the UI can offer *Request access* instead of falsely claiming an email was sent.

### 3.4 Provisioning — `handle_new_user()`

A trigger on `auth.users` insert creates the profile and decides the role:

```
allowlist row exists?          → use its role + client_id   (invited / approved)
else domain = active client?   → brief_viewer + that client (self-arrived, read-only)
else                           → client_user, no client
```

Existing users are never downgraded by this — it only runs on first creation.

### 3.5 Access requests

`POST /api/brief-access` deliberately **does not require a session**: a visitor whose
domain matches nothing is never signed in, so requiring auth would make the request path
unreachable for exactly the people who need it. It uses the service-role client and returns
a uniform `{ status: 'pending' }` for every outcome — unknown token, blocked email, or a
genuine new request — so it cannot be used to probe which briefs exist or who is blocked.

### 3.6 Machine-to-machine

The stepped pipeline re-triggers itself between steps. Those internal calls carry an
`x-bahirjee-internal-key` header, validated in `lib/_auth.js` against `INTERNAL_API_KEY`,
and are treated as an admin identity (`internal-job-runner`).

### 3.7 Rate limiting

`applyApiSecurity()` wraps every handler (Upstash Redis, in-memory fallback):

| Route | Limit / window |
|---|---|
| `/api/auth-link` | 20 |
| `/api/brief-access` | 10 |
| `/api/admin-users` | 20 |

`requireAuthenticatedUser()` adds an optional per-user limit keyed on user + client.

---

## 4. Configuration

**Frontend (Vite, `VITE_` prefix)**

```bash
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

**Server**

```bash
SUPABASE_URL
SUPABASE_ANON_KEY              # required by auth-link for signInWithOtp
SUPABASE_SERVICE_ROLE_KEY
ADMIN_EMAILS                   # comma-separated. ONLY admin addresses.
AUTO_ACCESS_DOMAINS            # instant-access domains; default: bahirjee.in
INTERNAL_API_KEY               # dedicated M2M secret; falls back to service-role key
ALLOWED_ORIGINS                # CORS allowlist
SITE_URL                       # magic-link redirect base (must not be localhost)
```

> ⚠️ **Never put a client or founder address in `ADMIN_EMAILS`.** Step 1 of §3.3 would
> suppress their sign-in entirely and they would be unable to log in.

**Supabase dashboard prerequisites**

- **Authentication → URL Configuration → Redirect URLs** must include your app origin
  (e.g. `https://<domain>/**` and `http://localhost:5173/**`), or magic links and password
  resets will not return correctly.
- **SMTP** — the built-in sender is rate-limited (~3–4/hour) and not production-grade.
  Magic links and password resets need custom SMTP configured before real use.
  *(Instant domain access sends no email and works without SMTP — which is part of why it
  is currently masking this dependency.)*

---

## 5. Testing setup

### How to get in today

**Admin:** `/admin/login` with `admin@bahirjee.in`. The password is set by
`sql/seed_admin_access.sql` — read that file, or reset it via `/admin/reset`.
**Change it before production; treat the seeded value as compromised.**

**Client-domain user:** open `/`, type any address at an active client's domain (e.g.
`anyone@bahirjee.in`) → signed in instantly as `brief_viewer`, no email.

**Local dev bypass:** set `DEV_AUTH_BYPASS=true` and `VITE_DEV_AUTH_BYPASS=true` in `.env`
to skip auth entirely with a mock identity. Role via `DEV_BYPASS_ROLE` /
`VITE_DEV_BYPASS_ROLE`. Guarded by **both** `NODE_ENV !== 'production'` and
`VERCEL_ENV !== 'production'`, so it cannot open on a production deploy even if the flag
leaks into the environment.

> The bypass does **not** create a real Supabase session. RLS-backed features (opening a
> shared brief, the `set_full_name` RPC) will deny under it — that is expected, not a bug.
> Real enforcement can only be exercised with a genuine login.

### Seed & repair scripts (`sql/`)

| File | Purpose |
|---|---|
| `seed_admin_access.sql` | Creates/repairs `admin@bahirjee.in` as an active admin with a known password |
| `seed_bahirjee_in_domain.sql` | Creates the `bahirjee.in` client so domain access provisions correctly |
| `seed_dev_bypass_user.sql` | Backing rows for the dev-bypass identity |
| `fix_orphaned_profile_clients.sql` | Diagnoses/repairs profiles pointing at a deleted client |

> **Postgres gotcha, encoded in these scripts:** hand-inserting into `auth.users` leaves
> GoTrue's token columns `NULL`, which makes password login fail with the opaque
> *"Database error querying schema"*. The seeds normalise those columns to `''`. Also,
> `confirmed_at` is a generated column and must never be inserted.

### Relevant test scripts

```bash
npm run test:security   # security regressions (each fix pinned here)
npm run test:origin     # CORS / origin policy
npm run test:router     # API route dispatch
```

---

## 6. Gap register

Ordered by risk. Items 1–2 are **testing-phase shortcuts that must change before
production**.

### 🔴 1. Instant domain access has no proof of address ownership

**Today:** anyone who *types* `anyone@<active-client-domain>` gets a real session. There
is no email click, no password, no verification. Someone who guesses `ceo@clientdomain.com`
gets in and can read that client's briefs.

**Why it exists:** it makes brief sharing frictionless during testing, and it removes the
SMTP dependency.

**Current mitigations:** such users are `brief_viewer` (read-only, cannot spend a run);
only **active** client domains qualify; any individual can be revoked via the block list;
every open is logged with the email.

**Production target:** require a magic-link click for **client domains** (step 2 of §3.3
routes to `signInWithOtp` instead of `generateLink`). Keep instant access **only** for
internal `AUTO_ACCESS_DOMAINS`. Requires custom SMTP to be configured first.

### 🔴 2. Single shared admin account, no MFA

**Today:** one `admin@bahirjee.in` login, password set by a SQL seed with a known default,
shared by whoever needs admin access. Admin actions are not attributable to a person.

**Production target:** an individual account per admin (`ADMIN_EMAILS` already accepts a
list; `email_allowlist` already carries `role='admin'`), the shared account retired, and
the seeded password rotated. MFA is a recognised follow-up, not yet scoped.

### 🟡 3. `INTERNAL_API_KEY` falls back to the service-role key

If unset, internal calls authenticate with `SUPABASE_SERVICE_ROLE_KEY` — using the database
master key as a routine request header. **Set `INTERNAL_API_KEY` in production.**

### 🟡 4. One email can belong to only one client

`email_allowlist.email` is a global primary key, so the same address cannot be granted
access to two different clients. Admin CRUD is scoped by `client_id` and refuses
cross-client collisions rather than silently reassigning. A composite `(email, client_id)`
key is the fuller fix if multi-client access is ever needed.

### 🟢 5. Redundant profile-name RPC

Two `SECURITY DEFINER` functions update the same column: `set_full_name()` (used by
`AuthContext`) and `update_own_profile_full_name()` (from migration `v11`, not called by
app code but pinned by `test:security`). Harmless; consolidate when convenient.

---

## 7. Verification checklist

Exercise these against a **real deploy** — the dev bypass cannot prove enforcement (§5).

1. **Admin** — `/admin/login` succeeds; `/admin` while logged out redirects to it; requesting a magic link for an admin address sends **no** email and says so.
2. **Invited user** — Team Members invite → allowlist row created → magic link arrives → lands as `client_user` → can run an analysis.
3. **Domain visitor** — types an address at an active client domain → signed in with no email → profile is `brief_viewer` → sees the briefs list, **no** intake form → a direct job submit returns the view-only error.
4. **Cross-org denial** — a user of a *different* client opens the share link → denied, offered *Request access*.
5. **Access log** — the client's brief row shows the accessing emails with correct counts and first/last seen.
6. **Block** — add an email to Blocked Emails → that user is denied on reload → remove it → access returns.
7. **Request → approve** — submit a request from the denied state → appears as pending → approve → that user can open the brief.
8. **Deactivation** — set `is_active = false` → the user is signed out client-side, not merely blocked at the API.

---

## 8. File map

| Path | Responsibility |
|---|---|
| `lib/handlers/auth-link.js` | Decides how each email signs in (§3.3) |
| `lib/handlers/brief-access.js` | Unauthenticated access requests (§3.5) |
| `lib/handlers/admin-users.js` | Admin user CRUD / invites |
| `lib/_auth.js` | `requireAuthenticatedUser()`, internal-key check, dev bypass |
| `lib/_security.js` | CORS, origin policy, rate limiting |
| `src/context/AuthContext.jsx` | Session + profile state, sign-in actions |
| `src/components/ProtectedRoute.jsx` | Route-level role/active gate |
| `src/pages/admin/AdminLogin.jsx` | Password sign-in |
| `src/pages/admin/AdminResetPassword.jsx` | Reset / set password |
| `src/components/ReportViewer.jsx` | Brief page: inline sign-in, denial, request access |
| `src/services/apiClient.js` | Attaches JWT; signs out + redirects on 401 |
| `schema.sql` §3, §4, §4b | RLS policies, `handle_new_user()`, brief-sharing model |

---

*Keep this document current when auth behaviour changes — particularly the
[gap register](#6-gap-register), which is the record of what we knowingly deferred.*
