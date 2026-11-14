# TeamForge Build Status

Last updated: 2026-11-14 UTC
Current phase: 4 — local gate passed; stopped for user review/commit
Repository/branch: `team-forge`, `main`
Base commit: `f2dec78` (`feat: add idempotent team lifecycle`)
Phase 4 changes: uncommitted and unstaged, as requested. No push or remote workflow run.

| Phase | Status | Evidence | Remaining blocker |
|---|---|---|---|
| 0 | passed | [Phase 0 record](milestones/PHASE_0.md), `a2f2995` | Docker verification deferred |
| 1 | passed (local) | [Phase 1 record](milestones/PHASE_1.md), `fa7e715` | Remote CI unverified |
| 2 | passed (local) | [Phase 2 record](milestones/PHASE_2.md), `846ea99` | Previously documented dependency findings |
| 3 | passed (local) | [Phase 3 record](milestones/PHASE_3.md), `f2dec78` | Remote CI unverified |
| 4 | passed (local) | Gate and commands below | Host clock instability; remote CI unverified |
| 5 | not-started | — | User's next milestone instruction |
| 6 | not-started | — | Phase 5 |
| 7 | not-started | — | Phase 6 |
| 8 | not-started | — | Phase 7 and hosting access |
| 9 | not-started | — | Phase 8 |
| 10 | not-started | Optional | All required phases |

## Completed work and changed paths

- `apps/api/test/helpers/concurrency.ts`: simultaneous HTTP start gate that drains all requests before teardown; bounded condition polling; PostgreSQL blocker verification.
- `apps/api/test/helpers/observePool.ts`: test-only observation of real queries on checked-out connections, with explicit barriers, checkout/release tracking and real SQL fault injection. No fabricated database results or application test switches.
- `apps/api/test/helpers/raceFixture.ts`: isolated migrated schemas, registered participants, signed established sessions verified by normal authentication, real HTTP server, actual per-user loopback source addresses, normal rate limits, application pool capped at 20 and post-commit notification capture. Fixtures close their servers/pools and drop only their own schemas.
- `apps/api/test/race/lastSeat.race.test.ts`: 20 fresh last-seat races, plus two-seat and no-seat variants; exact outcome, membership, audit, idempotency, publication, invariant and connection checks. Sanitized headline evidence is written to ignored `.cache/phase4/last-seat.json`. Read-only clock diagnostics do not skip tests or weaken assertions.
- `apps/api/test/race/interleavings.race.test.ts`: duplicate create/join requests, one actor joining 10 teams, both orders of two-member leaves and last-member leave versus join. Barriers pause the first transaction after its team lock; `pg_blocking_pids` proves the second transaction is waiting before release.
- `apps/api/test/race/retries.race.test.ts`: real PostgreSQL deadlock after domain writes, exhausted 40001/40P01 retries, non-retried 57014/55P03 failures, a genuine normal 2-second lock timeout and failed post-commit publication.
- `vitest.race.config.ts`, existing Vitest/tools configs, `package.json`: separate `npm run test:race` release suite, serial files with concurrent requests inside cases. The regular suite excludes race files.
- `.github/workflows/ci.yml`: race gate after the regular suite, JSON evidence upload even on failure. README explains commands, topology and limits; the Phase 3 handoff is archived.
- No application implementation, database migration, dependency or lockfile changes were needed.

## Commands actually run

Environment: Node 22.19.0, npm 10.9.3, native PostgreSQL 16.15, WSL/Linux, application pool size 20. Local socket access was explicitly allowed.

| Command / check | Actual result |
|---|---|
| Native `pg_ctl` start | Restarted the dedicated test cluster on loopback 54330 |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed for shared, API/tests, web and tools |
| `npm run test:race` | Final full run: **3 files, 36 tests passed**, about 20 seconds |
| `npm test` | **12 files, 105 tests passed**, no unhandled errors |
| `npm run build` | Passed; compiled API/migrations and Vite client |
| Clock diagnostic | 2,197 database/system clock samples over 15 monotonic seconds; eight large discontinuities recorded |
| Evidence inspection | 20/20 headline iterations passed; every iteration reached pool peak 20, exact 1/49 outcomes and zero invariant violations |
| Git/index/architecture checks | Nothing staged; architecture unchanged and ignored; final whitespace check passed |

Total across the separate suites: **141 tests in 15 files**. Browser smoke, deployment, performance and remote CI runs were not repeated: this milestone changes tests and automation, with Phase 3 browser evidence retained in its archived record.

## Gate evidence

| Scenario | Verified result |
|---|---|
| 50 users, one remaining seat, repeated 20 times | Each iteration: 1 HTTP 200, 49 HTTP 409 `TEAM_FULL`; exactly the initial three members plus the winner; stored count 4; one new audit, retained key and notification |
| 50 users, two seats | 2 successes and 48 `TEAM_FULL`; exactly the two winning memberships/effects |
| 50 users, no seats | 50 `TEAM_FULL`; no new memberships, audits, keys or notifications |
| One user joining 10 different teams | 1 success, 9 `ALREADY_IN_TEAM`; exactly one membership and committed join effect |
| 20 identical creates, one key | 20 identical 201 responses, 19 replay headers; one team/member/audit/key/notification |
| 10 identical joins, one key | 10 identical 200 responses, 9 replay headers; one new membership/audit/key/notification |
| Two members leave, either lock order | Both succeed; one deletes the team; promotion occurs only when the leader leaves first |
| Last member leaves versus new join, join first | Both succeed; team survives with the joiner as its sole member and leader |
| Last member leaves versus new join, leave first | Leave succeeds, join returns 404 `INVALID_OR_EXPIRED_CODE`; team is deleted; no join effect/key/notification |
| Real deadlock | One genuine 40P01 victim retries; both HTTP creates succeed; three total attempts, two committed effects/audits/keys/notifications |
| Exhausted 40001/40P01 faults after domain writes | Three total attempts, then 503 `BUSY` with `Retry-After: 1`; no effects or retained keys; retrying that intent after removing the fault succeeds |
| 57014/55P03 faults and real team lock timeout | One server attempt, 503 `BUSY`; rollback preserves state and the same key can succeed later |
| Post-commit publication failure | Committed response succeeds; replay is identical and causes neither a second mutation nor another publication attempt |

B.1–B.8 are checked after every case. Application connections return to the pool, with zero waiting clients; retry instrumentation verifies the failed checkout was released before the next attempt. Test instrumentation also verifies the transaction connection is released before publication.

The headline uses the normal application pool without query instrumentation. Contenders are 50 distinct authenticated registered users, each bound to a distinct real loopback IP; socket addresses are checked, and proxy headers are not used. Fresh limiter state prevents unrelated tests from consuming quotas. The per-IP in-flight code limit remains 40: this result does **not** promise the same outcome for 50 simultaneous clients sharing one IP. Same-user code cases stay within the 10-attempt in-flight limit.

Runtime acquisition/lock/statement/idle transaction timeouts remain 2s/2s/5s/10s, with three total retry attempts and normal jitter. Only the injected real-deadlock case shortens PostgreSQL's deadlock detector to 50 ms; it does not extend the lock timeout or retry budget.

## Verification findings

The initial sandbox run could not open local PostgreSQL sockets (EPERM); it was rerun with the required socket permission.

The first database run passed 32 of 36 cases. Two headline iterations and the no-seat variant returned unexpected 503 responses with PostgreSQL 57014 statement timeouts, despite those complete tests taking less than a second. A separate clock probe then measured simultaneous Node/PostgreSQL wall-clock jumps of approximately +7.9–8.3 seconds and subsequent -8.4 seconds while adjacent monotonic samples advanced only 6–8 ms. The PostgreSQL log also moved backward. This is evidence of local host clock instability, which can prematurely expire database deadlines; it is not a reason to disable them.

The fourth failure was an incorrect test assertion: a deadlock victim's diagnostic counter increments roll back and are not reinjected on retry. The assertion now checks only the surviving first attempt's increments. Domain effect, audit, key and notification assertions were already passing.

After that assertion correction and addition of passive clock reporting, the full race suite passed 36/36, including all 20 headline iterations. The final evidence still records clock discontinuities; **the host clock problem is not fixed**, and another local run can encounter it. No timeout was raised, no 503 was accepted in a healthy race, no test was skipped and no automatic suite retry was introduced. A run on a stable-clock CI host remains valuable; no remote success is claimed. Local diagnostic output is retained in ignored `.cache/phase4/clock-probe.json`, and final race output in `.cache/phase4/race.log`.

## Decisions and remaining gaps

- Stop at Phase 4. No staging, commit or push. Suggested commit: `test: prove team concurrency and retry guarantees`.
- `ARCHITECTURE.md` remains ignored and unchanged. SHA-256: `0f0e98f4202195b5c8883126aa22e651ecf4313418e62d1d113cd3a885039d80`.
- Existing dependency findings remain unaddressed, as last checked in [Phase 2](milestones/PHASE_2.md#dependency-findings-and-exposure-assessment). No new dependency installation or audit-clean claim.
- Accept-versus-code, removal-versus-leave and invitation-rotation endpoint races depend on Phase 5 controls and are not claimed here. Pending-request cancellation and expiry/rotation replay behavior already have Phase 3 coverage.
- No live SSE delivery yet: notifications here exercise the existing after-commit publication seam.
- Docker/Compose execution, hosted deployment, throughput benchmarks and remote GitHub Actions remain unverified. Rate limits still assume one application instance.

## Handoff and next step

Owned HTTP servers and the native test database are stopped at handoff. Fixtures are cleaned up; the scratch cluster and local evidence remain ignored. Restart on this workspace with:

```sh
/usr/lib/postgresql/16/bin/pg_ctl -D .cache/phase1/pg-data -l .cache/phase1/postgres.log -o "-h 127.0.0.1 -p 54330 -k $PWD/.cache/phase1/pg-socket" -w start
nvm use
npm test
npm run test:race
```

Fresh clones use the README's Compose test service and environment setup.

After the user's next instruction, begin **Phase 5: requests and leader controls**, with its own review/commit boundary. Include the deterministic mixed-operation races that become possible when acceptance, removal and rotation endpoints exist.
