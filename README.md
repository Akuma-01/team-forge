# TeamForge

Team formation for hackathons, built with Node 22, Express 5, PostgreSQL 16, React 18 and TypeScript.

The foundation, identity flow, team lifecycle, application/leader-control APIs, discovery APIs and live updates are implemented. The browser supports account/profile setup, registration, team creation, invite sharing, joining and leaving. The API also supports applications, decisions, member removal, team edits, invite rotation, audit history, filtered team discovery and ranked teammate suggestions; their remaining browser controls arrive in Phase 7. Mutations use transactions, idempotency keys and audit records; leadership transfers automatically when needed. Deployment remains a future milestone.

## Run locally

Use Node **22.19.0** (`nvm use`) and npm 10. Docker Compose is the recommended local database setup; an existing PostgreSQL 16 server also works.

```sh
nvm use
npm ci
npm run env:setup
docker compose up -d db
npm run db:check
npm run migrate
npm run dev
```

Open **http://localhost:5173**. Vite forwards `/api`, `/health` and `/ready` to Express on port 8080, keeping browser requests on one origin. The API and shared package rebuild when edited. Change `PORT` in `.env` if needed; Vite reads the same setting.

The database binds only to loopback on port **54329**. Local example credentials are disposable development values. `env:setup` creates a private, gitignored `.env` with a random 32-byte JWT secret; existing non-placeholder secrets and other settings are preserved. Startup refuses missing/short/placeholder secrets. Use fresh secrets for a hosted service. In WSL, Docker Desktop integration must be enabled for Docker commands to work. Alternatively, point the database URLs in `.env` at a dedicated local PostgreSQL 16 database.

Sign up at `/signup`, complete `/onboarding`, and revisit `/profile` to make changes. A fresh database has no hackathons: the UI shows an empty state, and the full demo seed is scheduled for Phase 8. To review registration manually, run this SQL in your **development** database using your PostgreSQL client:

```sql
INSERT INTO hackathons (name, min_team_size, max_team_size)
VALUES ('Local builders weekend', 2, 4);
```

After registration, open **My team** (`/me`) or **Manage your team** on the workspace. Create a team and copy its invite code. Sign up with a second account in a separate browser/private window, register for the same hackathon, and join with the code. Team views update automatically; **Live** or **Reconnecting** reports connection state, and **Refresh team** remains available. The leave dialog explains whether leaving transfers leadership or deletes the team.

```sh
docker compose --profile test up -d db-test
```

The test database has its own port **54330**, database name and temporary storage. `npm test` requires `TEST_DATABASE_URL` pointing to a loopback PostgreSQL database whose name ends in `_test`. It refuses production mode and URL query overrides. Each database suite creates/migrates its own temporary schema and drops that schema afterward; existing schemas and data are not reset. The deadlock test uses the supplied test role's permission to set `deadlock_timeout` locally.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run test:race
npm run build
npm run db:check
```

`npm test` runs shared validation, configuration, identity/team HTTP tests, independent rate-limit tests, and real PostgreSQL migration, constraint, transaction and idempotency tests. Team tests cover lifecycle, private-field permissions, 20 concurrent duplicate creates, replay after code rotation, failed-effect rollback, cleanup races and code expiry during a verified lock wait. Every team test finishes with B.1–B.8 invariant checks. The database suite also exercises a real deadlock and post-commit hooks. Seeding, load testing and chaos testing still exit nonzero with their planned phase.

Phase 5 adds 40 API cases for applications and leader controls, including the authorization matrix, hackathon isolation, pending limits, inbox/audit pagination, atomic acceptance and removal, and replay for all seven new mutation types. The mixed race file covers both lock orders for accept/code, competing accepts, removal/leave, rotation/join, leadership transfer, opposing decisions, withdrawal and automatic cancellation. Ordered races also check that only successful contenders retain idempotency records.

`npm run test:race` runs the separate release concurrency suite against the same dedicated test database. It repeats the simultaneous 50-user last-seat HTTP race **20 times**, each with fresh users, hackathon, schema and server. The required result is one 200, 49 `TEAM_FULL`, the exact four final members and zero B.1–B.8 violations. Other cases cover two/no seats, same-user competing joins, duplicate creates and joins, both lock orders for concurrent leaves and leave/join, real PostgreSQL deadlock recovery, retry limits and publication failures. Test barriers verify blocking with `pg_blocking_pids`; requests and SQL execute normally. Files run serially; requests within each case run concurrently.

The application pool stays capped at **20**, with normal authentication, rate limits and database timeouts. Participants use actual distinct loopback source addresses (`127.0.0.2` onward), requiring a host that supports binding the IPv4 loopback range, as Linux does. No forwarded-IP header or limiter bypass is used. The same-user join/replay cases use 10 attempts within the in-flight code limit; the duplicate-create case uses 20. This topology does not promise that 50 concurrent joins behind one shared IP bypass the normal 40/IP in-flight limit. It is a correctness check, not a throughput benchmark.

The last-seat suite writes sanitized results, final member IDs, invariant counts, pool usage and observed clock changes to gitignored `.cache/phase4/last-seat.json`; CI uploads the JSON evidence. Some local WSL runs exposed eight-to-nine-second wall-clock jumps that caused premature PostgreSQL timeouts. Clock diagnostics never skip tests, change timeouts or excuse failed assertions; use a stable-clock host for reproducible timing checks.

`npm run migrate` prefers `DATABASE_URL_DIRECT`, applies all pending migrations in one advisory-locked transaction, and verifies checksums on later runs. Applied SQL files must not be edited; add another numbered migration. Server startup also runs migrations and stops on failure. The API build copies SQL alongside the compiled runner.

`npm run invariants` checks the configured `DATABASE_URL` without changing data; it exits nonzero if any check fails. To scope it: `npm run invariants -- <hackathon-uuid>`. The CI workflow runs the full local gate with PostgreSQL and a pool of 20; its remote execution remains pending until the changes are pushed.

To verify identity and team flows in Chromium:

```sh
npx playwright install chromium
npm run build
npm run smoke:auth
npm run smoke:teams
npm run smoke:live
```

`smoke:auth` needs the local test database. It starts its own server, creates a temporary schema and real hackathon fixture, and checks signup, keyboard onboarding, profile persistence, registration/preference, logout/login, expiry and account isolation at 375px and 1280px. It removes its schema and closes the server/browser afterward. Screenshots are written to gitignored `.cache/phase2/`. `CHROMIUM_EXECUTABLE_PATH` can point to an existing compatible Chromium. The lighter `smoke:web` still checks rendering, keyboard access, health/readiness and API routing against a running dev app; `BASE_URL` overrides its default URL.

`smoke:teams` uses the same isolated test-database guard with two real browser accounts at both widths. It deliberately drops a response **after** the create request commits and checks that the retry reuses the key and creates only one team. It also covers copy/join, leader-only invite visibility, leave-dialog keyboard behavior, promotion, deletion and invariants. Its screenshots are under `.cache/phase3/`.

`smoke:live` opens three authenticated browser contexts against a real database and stream server. It checks join/accept/leave updates, an event during an initial fetch, recovery when notifications are deliberately dropped, focus/reconnect reconciliation, leadership transfer, removal and logout. The missing-event case waits for the normal 30-second visible-page reconciliation interval.

## Identity and request boundaries

Passwords use Argon2id. Sessions use a seven-day HS256 JWT in the `sid` cookie, with HttpOnly, SameSite=Lax and Path=/; Secure is enabled in production. Tokens are never stored in browser storage. Logout clears the browser cookie; it does **not** revoke an independently retained token. Email verification and password reset remain outside the planned scope.

Unsafe `/api` methods require an `Origin` exactly matching `APP_ORIGIN`, including requests from HTTP test clients. Bodies must be JSON where present and are capped at 10 kB. Unknown fields are rejected, and only `/me` returns the caller's email; password hashes never leave the API. Self-assignment of organizer status is prohibited.

Limits are in-process and require one app instance: signup 20 attempts/IP/hour, login 10 failures/15 minutes independently per IP and normalized email, authenticated mutations 60/user/minute and reads 600/user/minute. In-flight logins reserve quota; successful attempts refund only their own reservation. A 429 includes `Retry-After`. `TRUSTED_PROXY_CIDRS` defaults to empty (forwarded addresses ignored); configure only the verified proxy addresses/CIDRs at deployment.

Invalid/expired invite attempts additionally allow 10/user and 40/IP per 15 minutes. In-flight attempts reserve quota, and successful joins, replays and other domain conflicts refund that reservation.

Application submissions additionally allow 20/user/minute, including duplicate attempts.

## Teams and retry contract

All paths below are relative to `/api` and require authentication and hackathon registration. Team IDs are scoped to the hackathon.

| Method | Path | Result |
|---|---|---|
| GET | `/hackathons/:hid/me/team` | `{ team, pendingRequests }`; team is null before joining |
| GET | `/hackathons/:hid/teams/:tid` | Team detail; only the current leader receives invite fields |
| POST | `/hackathons/:hid/teams` | 201 `{ team }`; body: `name`, optional `description`, `lookingFor`, `isOpen` |
| POST | `/hackathons/:hid/teams/join-by-code` | 200 `{ team, alreadyMember }`; body: `{ code }` |
| POST | `/hackathons/:hid/teams/:tid/leave` | 200 `{ left: true, teamDeleted }`; empty body |
| POST | `/hackathons/:hid/teams/:tid/requests` | 201 `{ request }`, or 200 for an existing pending application; optional `message` |
| DELETE | `/hackathons/:hid/requests/:rid` | Applicant only; 200 `{ request }` after withdrawal |
| GET | `/hackathons/:hid/teams/:tid/requests` | Leader only; paginated pending inbox with applicant display profile |
| POST | `/hackathons/:hid/requests/:rid/accept` | Leader only; 200 `{ request }`, atomically joining the applicant |
| POST | `/hackathons/:hid/requests/:rid/decline` | Leader only; 200 `{ request }` |
| PATCH | `/hackathons/:hid/teams/:tid` | Leader only; 200 `{ team }`; `name`, `description`, `lookingFor`, `isOpen` |
| GET | `/hackathons/:hid/teams/:tid/invite` | Leader only; `{ inviteCode, inviteExpiresAt }` |
| POST | `/hackathons/:hid/teams/:tid/invite` | Leader only; rotate and return `{ inviteCode, inviteExpiresAt }` |
| DELETE | `/hackathons/:hid/teams/:tid/members/:uid` | Leader only; 200 `{ removed: true }`; rotates invite atomically |
| GET | `/hackathons/:hid/teams/:tid/audit` | Current members only; paginated history |
| GET | `/hackathons/:hid/teams` | Public board DTOs for registered participants; `needs`, `q`, `limit`, `cursor` |
| GET | `/hackathons/:hid/teams/:tid/suggestions` | Current members only; top 20 eligible people with scoring breakdowns |
| GET | `/hackathons/:hid/stream` | Registered participants; public SSE invalidations |

Board, inbox and audit accept `limit` (1–50, default 30) and an opaque `cursor`, returning `{ items, nextCursor }`. The board also accepts a catalogue skill in `needs` and a literal team-name search in `q` (up to 100 characters; SQL wildcards are escaped). Other current routes reject query parameters. Audit IDs remain decimal strings to preserve PostgreSQL bigint precision. Deleted teams retain database history, but their history cannot be fetched through the member API.

Applicants must be registered and have no team in the hackathon, with at most five pending applications. Closed/full teams reject new applications; closing a team does not prevent approval of an existing request. A failed full-team acceptance leaves the request pending and rolls back all effects. Successful acceptance cancels the applicant's other pending requests and records the deciding leader as actor. Leaders cannot remove themselves; leaving transfers leadership instead. A removed member can apply again or join using a newly shared code.

Team capacity comes from the hackathon, and a person can belong to one team per hackathon. Minimum size determines readiness but does not prevent creating a smaller team. Private codes are 10 Crockford-base32 characters, default to 48-hour expiry (`INVITE_TTL_HOURS`, 1–720 hours), and can admit a member to a closed team. Unknown and expired codes return the same error. Code validation happens in a new SQL statement after the team lock is acquired.

Leaving transfers leadership to the earliest-joined remaining member, with UUID as the tie-break. The last member's departure deletes the team; audit history remains. Creation and joining cancel the actor's pending requests in the same transaction.

Authenticated domain mutations, including profile/registration/preferences, accept an optional UUID `Idempotency-Key`. The browser sends one per intent. Same user/key/method/path/canonical JSON body replays the stored successful status/body with `Idempotent-Replay: true`; a different fingerprint returns 422 `IDEMPOTENCY_KEY_REUSED`. Only 2xx results are retained. Failed actions roll back their key, so the same intent can be retried after conditions change. Login/signup/logout are excluded.

The browser retries connection failures and 503 once with the same key. It retains that key for a manual retry of an unchanged intent after an uncertain result and prevents retrying under a different account. Buttons are disabled while pending. Response and effect commit together before HTTP success is sent. Keys are retained for at least 24 hours; the server runs a bounded hourly sweep of up to 500 older successful rows using `SKIP LOCKED`. Older rows can remain longer, and replay is guaranteed while the row is retained. Expired-key cleanup races retry acquisition within the existing transaction.

## Discovery and live state

The board returns open teams with free seats, ordered by creation time and ID, with exact keyset cursors. A bounded 500-entry cache stores only public board JSON, gzip and ETags for one second. Identical requests share a load; commit invalidations advance the hackathon generation so an older load cannot restore an invalidated cache entry. Authentication and registration are checked before every response, including cache hits and 304s. Capacity remains advisory until a join/accept transaction commits.

Suggestions score all eligible registered, opted-in, solo participants within the 10,000-person challenge ceiling and return the top 20, breaking equal scores by user ID. The response explains requested-skill coverage, complementary skills and timezone overlap using the team's median offset. Skill/timezone weights are 0.65/0.35; empty needs use complementary skills alone, and timezone distance wraps over 24 hours.

One cookie-authenticated EventSource per tab receives `hello`, `state.changed` (only `{ hackathonId }`) and shutdown `bye` events. No invite codes, user IDs, applications or private DTOs travel over this wire. The server publishes after commit, coalesces changes over 250 ms and sends a heartbeat every 20 seconds. Limits are three concurrent streams and 30 connection attempts per minute per user, 5,000 streams per process, and five seconds of sustained backpressure. Streams close on session expiry and server shutdown.

Clients refetch active authorized queries on connect/reconnect, focus, events, and every 30 seconds while visible. Changes during a fetch trigger another fetch; protected data is discarded on 403/404, and logout closes the stream and clears account caches. Delivery is best effort with no replay log; periodic reconciliation recovers missed events. The hub/cache remain single-process components.

## Production build

```sh
npm run build
NODE_ENV=production HOST=0.0.0.0 APP_ORIGIN=https://your-host.example npm start
```

Express serves `apps/web/dist` and the API from one process. `APP_ORIGIN` must be an HTTPS origin in production. `/health` checks process liveness without querying PostgreSQL; `/ready` queries the database and returns 503 if it cannot be reached. Configuration and database failures do not print connection strings.

`Dockerfile` and `render.yaml` prepare the later deployment milestone. Docker image building and hosted deployment still need verification; no service, live URL, benchmark or remote CI result is claimed. Current hosting prerequisites are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Layout

```text
apps/api/          Express app factory, server, configuration, PostgreSQL pool
apps/web/          React identity/team screens, session queries and CSS modules
packages/shared/  Browser-safe schemas, DTO types, error codes, skill catalogue
scripts/          Connectivity and browser checks; explicit pending commands
docs/             Build status and deployment prerequisites
```

Shared code compiles before its consumers and exports JavaScript from `dist`; browser code must not import API or database modules. Password hashes never belong in response DTOs, including the current user's profile.

`ARCHITECTURE.md` is a local planning reference excluded from Git at the owner's request. Phase 6 is the current review/commit boundary; the remaining browser flows follow in Phase 7. Progress notes are kept locally and excluded from Git.
