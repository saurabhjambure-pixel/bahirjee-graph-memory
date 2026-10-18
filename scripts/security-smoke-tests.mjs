import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const checks = [
    {
        name: 'auth-link does not return raw action links',
        run() {
            const src = read('lib/handlers/auth-link.js');
            assert(!/actionLink\s*[:}]/.test(src), 'lib/handlers/auth-link.js still returns actionLink');
            assert(src.includes('signInWithOtp'), 'lib/handlers/auth-link.js should use Supabase email delivery');
        }
    },
    {
        name: 'costly provider routes require authenticated users',
        run() {
            for (const file of ['lib/handlers/gemini.js', 'lib/handlers/search.js', 'lib/handlers/scrape.js', 'lib/handlers/exa.js', 'lib/handlers/groq.js', 'lib/handlers/claude.js', 'lib/handlers/sarvam.js', 'lib/handlers/jev.js', 'lib/handlers/upload.js']) {
                const src = read(file);
                assert(src.includes("requireAuthenticatedUser"), `${file} does not import/use requireAuthenticatedUser`);
            }
        }
    },
    {
        // Jev is billed per call and nothing in the browser needs a Jev decision. A signed-in
        // user's token must not be enough: only the pipeline's internal key reaches the vendor.
        // And the key itself must never be VITE_-prefixed — Vite inlines those into the bundle.
        name: 'Jev is pipeline-only and its key stays server-side',
        run() {
            const src = read('lib/handlers/jev.js');
            const gate = src.indexOf('hasValidInternalApiKey(req)');
            const send = src.indexOf('fetchWithTimeout(');
            assert(gate > -1, 'lib/handlers/jev.js no longer checks the internal key');
            assert(gate < send, 'lib/handlers/jev.js calls the vendor before checking the internal key');
            assert(/status\(403\)/.test(src), 'lib/handlers/jev.js must refuse non-pipeline callers with a 403');

            const offenders = [];
            const walk = (dir) => {
                for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
                    const rel = path.join(dir, entry.name);
                    if (entry.isDirectory()) walk(rel);
                    else if (/\.(m?js|jsx|ts|tsx)$/.test(entry.name) && /VITE_JEV|JEV_API_KEY/.test(read(rel))) offenders.push(rel);
                }
            };
            walk('src');
            assert(offenders.length === 0, `browser code references the Jev key: ${offenders.join(', ')}`);
            assert(!/VITE_JEV/.test(read('.env.example')), '.env.example documents a VITE_-prefixed Jev variable');
        }
    },
    {
        name: 'shared report policy uses exact email domain match',
        run() {
            const sql = read('schema.sql');
            assert(sql.includes("split_part(auth.jwt() ->> 'email', '@', 2)"), 'schema.sql does not parse exact email domain');
            assert(!sql.includes("right(auth.jwt() ->> 'email', length(target_domain))"), 'schema.sql still uses suffix domain matching');
        }
    },
    {
        name: 'profile self-update policy is removed',
        run() {
            const sql = read('schema.sql');
            assert(!/create policy "Users update own profile"/i.test(sql), 'schema.sql still creates broad profile self-update policy');
            assert(sql.includes('update_own_profile_full_name'), 'schema.sql missing narrow profile update RPC');
        }
    },
    {
        name: 'report run reservation is server-side and atomic',
        run() {
            const api = read('lib/handlers/intelligence.js');
            const sql = read('schema.sql');
            assert(api.includes("rpc('reserve_report_run'"), 'lib/handlers/intelligence.js does not call reserve_report_run');
            assert(/for\s+update/i.test(sql), 'reserve_report_run should lock profile row with FOR UPDATE');
        }
    },
    {
        // History: the queued admin route once wrote columns that did not exist on `reports`
        // (`company_name`, `status`). cf30611 disabled the whole route with a 501 carrying
        // code QUEUE_PROCESSOR_NOT_CONFIGURED, and this check pinned that sentinel. 63a3ad3
        // then built the real thing — intelligence_jobs plus a server-side worker — and the
        // sentinel was correctly deleted, but this check was not updated, so it has been
        // failing ever since against a route that is no longer broken.
        //
        // The bad-column assertions below are the part that still means something and are
        // kept verbatim. The sentinel assertion is replaced by the property the 501 was
        // standing in for: a caller must not be able to choose whose client a run is billed
        // to. Do not re-add the sentinel — its absence is now the correct state.
        name: 'queued intelligence route writes only supported columns and cannot be aimed at another tenant',
        run() {
            const src = read('lib/handlers/intelligence.js');
            assert(!src.includes('company_name: company.trim()'), 'lib/handlers/intelligence.js still inserts unsupported company_name column');
            assert(!src.includes("status: 'pending'"), 'lib/handlers/intelligence.js still inserts unsupported status column');

            // Tenant isolation: only an admin may pass a clientId. Every other role is
            // pinned to its own profile.client_id, so a forged body cannot bill or expose
            // another organization's run.
            assert(src.includes('ensureTargetClient'), 'lib/handlers/intelligence.js should resolve the target client server-side');
            assert(
                /if\s*\(\s*auth\.profile\.role\s*!==\s*'admin'\s*\)/.test(src),
                'ensureTargetClient must branch on role before honouring a requested clientId'
            );
            assert(
                src.includes('return auth.profile.client_id;'),
                'non-admin callers must be pinned to their own profile.client_id'
            );
            // The view-only `brief_viewer` role arrived with the main merge: those accounts
            // reached the product by domain match, not by invitation, so they must never be
            // able to spend a run.
            assert(
                /role\s*===\s*'brief_viewer'/.test(src),
                'ensureTargetClient must refuse runs from view-only brief_viewer accounts'
            );
        }
    },
    {
        // Vercel mints a new hostname per branch deployment, so a preview can never appear in
        // a hand-maintained ALLOWED_ORIGINS list. Before this, every preview 403'd on every
        // API call with "Origin not allowed" and the app could not be tested before
        // production. A deployment trusting its OWN origin is not a loosening — the browser
        // only sends that Origin when the page making the request is this deployment.
        name: 'a deployment trusts its own origin without loosening the allowlist',
        run() {
            const src = read('lib/_security.js');
            assert(src.includes('selfOrigins'), 'lib/_security.js must derive its own deployment origins');
            // The env-var derivation is best-effort: which system variables are exposed at
            // runtime is a project setting, and Vercel serves a deployment on several
            // hostnames (deployment URL, branch alias, custom domain). The check that
            // actually makes previews work compares Origin against the host the request
            // arrived on, which needs no configuration.
            assert(src.includes('isSameOrigin'), 'lib/_security.js must allow same-origin requests unconditionally');
            assert(
                /x-forwarded-host/.test(src),
                'same-origin detection must use the proxy host header, not just req.headers.host'
            );
            // CORS headers must be echoed in exactly the cases the check allows, or an
            // allowed request still fails in the browser.
            assert(
                /allowedOrigins\.includes\(origin\)\s*\|\|\s*isSameOrigin\(/.test(src),
                'setCorsHeaders must echo the origin for same-origin requests too'
            );
            for (const v of ['VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
                assert(src.includes(v), `lib/_security.js should consider ${v} when building the allowlist`);
            }
            // The wildcard escape hatch must stay opt-in via ALLOWED_ORIGINS, never implicit.
            assert(
                !/return\s*\[\s*'\*'\s*\]/.test(src),
                'lib/_security.js must not default to a wildcard origin'
            );
            // Exact-match semantics must survive: no substring/endsWith matching that would
            // let evil-bahirjee-poc.vercel.app through.
            assert(
                !/\.endsWith\(|\.includes\(origin\.|indexOf\(origin\)\s*>/.test(src),
                'origin checking must stay an exact match, not a suffix or substring test'
            );
        }
    },
    {
        // The founder login screen showed "Check your email for a secure sign-in link" for
        // an admin email (suppressed by design — admins use /admin/login) and for an email
        // with no access at all (noAccess). Neither ever sends anything, so the user was
        // told to wait for an email that would never arrive.
        name: 'the auth-link notice reflects what the server actually did',
        run() {
            const api = read('lib/handlers/auth-link.js');
            assert(api.includes('adminRedirect: true'), 'lib/handlers/auth-link.js must flag the admin-suppressed case distinctly from a real send');

            const dash = read('src/components/IntelligenceDashboard.jsx');
            assert(dash.includes('result?.adminRedirect'), 'IntelligenceDashboard must branch on the admin-suppressed response');
            assert(dash.includes('result?.noAccess'), 'IntelligenceDashboard must branch on the no-access response');
            // The generic notice must be the ELSE, not the default shown regardless of outcome.
            assert(
                /else \{\s*setAuthNotice\('Check your email/.test(dash),
                'the "check your email" notice must only fire when neither adminRedirect nor noAccess applies'
            );
        }
    },
    {
        // Self-serve users are provisioned `client_user`, so they can start runs that
        // spend real money. The instant-access path grants a session to anyone who merely
        // TYPES an address at a matching domain — safe only while those users are
        // read-only. These two must never converge.
        name: 'self-serve signup proves ownership and never gets an instant session',
        run() {
            const src = read('lib/handlers/auth-link.js');
            assert(/sendSelfServeLink[\s\S]{0,400}signInWithOtp/.test(src), 'self-serve path does not send an OTP link');
            const selfServeLink = src.slice(src.indexOf('async function sendSelfServeLink'), src.indexOf('export async function handler'));
            assert(!/autoAccess/.test(selfServeLink), 'sendSelfServeLink must never return an autoAccess token');
            assert(!/generateLink/.test(selfServeLink), 'sendSelfServeLink must not mint a magic-link token directly');
        }
    },
    {
        name: 'instant domain access excludes self-serve workspaces',
        run() {
            const src = read('lib/handlers/auth-link.js');
            assert(/lookupClient\('id, domain, status, self_serve'\)/.test(src), 'auth-link.js does not read clients.self_serve');
            assert(/if \(\(client && !client\.self_serve\) \|\| autoAccessDomains\.has\(domain\)\)/.test(src),
                'the instant-access condition no longer excludes self_serve clients');
        }
    },
    {
        // A self-serve workspace pools everyone at a domain into one client_id, and the
        // reports RLS policy lets workspace members read each other's briefs. Domains that
        // pool unrelated strangers must never get one.
        name: 'self-serve is refused for personal, disposable and shared-institution domains',
        run() {
            const list = read('lib/freeMailDomains.js');
            for (const needle of ['gmail.com', 'proton.me', 'mailinator.com', "'.edu'", "'.ac.uk'"]) {
                assert(list.includes(needle), `lib/freeMailDomains.js missing ${needle}`);
            }

            const src = read('lib/handlers/auth-link.js');
            assert(src.includes("from '../freeMailDomains.js'"), 'auth-link.js does not import the domain blocklist');

            // Order matters: the refusal has to come before any workspace is created, and
            // before an existing self-serve workspace hands out a link.
            const guard = src.indexOf('const verdict = classifySelfServeDomain(domain)');
            const joinExisting = src.indexOf('if (client?.self_serve)');
            // `await ...(` matches the call site, not the function definition above it.
            const createNew = src.indexOf('await ensureSelfServeWorkspace(');
            assert(guard > -1 && joinExisting > -1 && createNew > -1, 'self-serve branches not found in auth-link.js');
            assert(guard < joinExisting, 'blocklist runs after an existing workspace grants access');
            assert(guard < createNew, 'blocklist runs after the workspace insert');
        }
    },
    {
        // An upsert here would converge on a concurrent signup — and also overwrite a row
        // an admin created in the meantime, flipping self_serve true on an admin client and
        // promoting its whole domain from brief_viewer to client_user.
        name: 'self-serve cannot take over an admin-provisioned client',
        run() {
            const src = read('lib/handlers/auth-link.js');
            const fn = src.slice(src.indexOf('async function ensureSelfServeWorkspace'), src.indexOf('async function sendSelfServeLink'));
            assert(fn.includes(".from('clients')") && fn.includes('.insert({'), 'ensureSelfServeWorkspace should insert');
            assert(!/\.upsert\(/.test(fn), 'ensureSelfServeWorkspace must not upsert over an existing client row');
            assert(fn.includes('23505'), 'ensureSelfServeWorkspace does not recover from a unique violation');
            assert(/if \(!workspace\.selfServe\)/.test(src), 'auth-link.js does not refuse a client that came back non-self-serve');
        }
    },
    {
        // Not a security check — a referential one, in the file that pins regressions.
        // intelligence_jobs.decision_id is a FK to decision_briefs(id), and for a long time
        // the ONLY writer of that table was saveReport, at `persist`. So the job insert
        // pointed at a row that would not exist for several more minutes and died with
        // intelligence_jobs_decision_id_fkey. It never fired only because decision mode was
        // unreachable in the UI.
        name: 'a decision brief exists before a job references it',
        run() {
            const api = read('lib/handlers/intelligence.js');
            const ensure = api.indexOf('await ensureDecisionBrief(');
            const create = api.indexOf('await createIntelligenceJob(');
            assert(ensure > -1, 'lib/handlers/intelligence.js does not pre-create the decision brief');
            assert(create > -1, 'createIntelligenceJob call not found');
            assert(ensure < create, 'the decision brief is created AFTER the job that has a FK to it');

            const sql = read('schema.sql');
            assert(/decision_id uuid references public\.decision_briefs\(id\)/.test(sql),
                'the FK this check exists for is gone — if it was dropped deliberately, drop this check too');
        }
    },
    {
        // The run tier decides how much money a run spends on search and LLM calls. A
        // client-supplied tier would be a free upgrade to full depth for anyone who can
        // edit a request body.
        name: 'run tier is decided server-side, never from the request',
        run() {
            const api = read('lib/handlers/intelligence.js');
            assert(!/req\.body[^\n]*\b(runTier|run_tier|tier|depth)\b/.test(api),
                'lib/handlers/intelligence.js reads a tier from the request body');
            assert(/runTier: row\.reason === 'unlimited' \? 'full' : 'shallow'/.test(api),
                'the run tier is no longer derived from the reservation result');

            // The worker must take the tier from the persisted row, not from anything the
            // caller passed along with the trigger.
            const worker = read('lib/_intelligenceWorker.js');
            assert(/runTier: job\.run_tier \|\| 'full'/.test(worker), 'worker does not read run_tier from the job row');
            assert(/budget: claimedJob\.run_tier \|\| 'full'/.test(worker), 'worker does not apply the tier to the runtime budget');

            // Unknown tiers must resolve to full: cron and admin runs carry none, and
            // silently downgrading them would thin the scheduled runs.
            const tiers = read('src/services/runTiers.js');
            assert(/RUN_TIERS\[name\] \|\| RUN_TIERS\[DEFAULT_RUN_TIER\]/.test(tiers), 'resolveRunTier does not fall back to the default tier');
        }
    },
    {
        // clients.self_serve arrives with v24, and this read is on the path every sign-in
        // takes. Without the fallback, deploying the code before running the migration
        // would 500 every existing user out of the product.
        name: 'auth-link survives a pre-v24 schema instead of locking everyone out',
        run() {
            const src = read('lib/handlers/auth-link.js');
            assert(src.includes("'42703'"), 'auth-link.js does not detect the missing-column error code');
            assert(/lookupClient\('id, domain, status'\)/.test(src), 'auth-link.js has no pre-v24 column fallback');
            assert(/selfServeEnabled\(\) && !selfServeColumnMissing/.test(src),
                'self-serve signup is not disabled when the v24 column is absent');
        }
    },
    {
        name: 'handle_new_user stays read-only for admin-provisioned domains',
        run() {
            const sql = read('schema.sql');
            const fn = sql.slice(sql.indexOf('function public.handle_new_user()'), sql.indexOf('drop trigger if exists on_auth_user_created'));
            assert(fn.includes('self_serve'), 'handle_new_user does not branch on clients.self_serve');
            assert(fn.includes('member_cap'), 'handle_new_user does not enforce a member cap');
            // The strict default must survive: a domain match on an admin-created client
            // is still view-only.
            assert(/else\s+--[\s\S]{0,400}assigned_role := 'brief_viewer';/.test(fn),
                'handle_new_user no longer assigns brief_viewer to admin-provisioned domain matches');
        }
    },
    {
        // Not a security check, but the same class of regression: a rule that is only
        // enforced by remembering it. The decision-mode UI was written against the old dark
        // theme and kept raw slate/white scales after the app moved to the light
        // claymorphism palette — `bg-bah-bg` on an input painted the page's aurora base onto
        // the field, so it was invisible against the page. These scales bypass the token
        // layer and become contrast bugs, per the engineering notes.
        name: 'intelligence components use theme tokens, not raw colour scales',
        run() {
            const dir = 'src/components/intelligence';
            const banned = /text-slate-|text-white\b|placeholder-slate-|bg-white\/\[|border-white\/|bg-black\//;
            const field = /<(?:input|textarea|select)\b/;
            const offenders = [];

            for (const file of fs.readdirSync(path.join(root, dir))) {
                if (!file.endsWith('.jsx')) continue;
                read(`${dir}/${file}`).split('\n').forEach((line, i) => {
                    // `bg-black/NN` on a full-bleed scrim is deliberate — a modal wash is a
                    // black veil over the page, not a themed surface.
                    if (line.includes('inset-0')) return;
                    // The page's aurora base painted onto a field makes it invisible against
                    // the page. Checked per line rather than by proximity: the element tag can
                    // sit on either side of the class string.
                    const auroraOnField = field.test(line) && /\bbg-bah-bg\b/.test(line);
                    if (banned.test(line) || auroraOnField) offenders.push(`${dir}/${file}:${i + 1}`);
                });
            }

            assert(offenders.length === 0, `raw colour scales outside the token layer:\n    ${offenders.join('\n    ')}`);
        }
    },
];

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

let passed = 0;
for (const check of checks) {
    try {
        check.run();
        passed += 1;
        console.log(`✓ ${check.name}`);
    } catch (error) {
        console.error(`✗ ${check.name}`);
        console.error(`  ${error.message}`);
        process.exitCode = 1;
    }
}

if (!process.exitCode) {
    console.log(`\n${passed}/${checks.length} security smoke checks passed.`);
}
