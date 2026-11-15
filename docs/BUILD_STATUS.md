# TeamForge Build Status

Last updated: 2026-11-15 UTC
Current phase: **5 — implementation complete; full release race gate pending**
Repository/branch: `team-forge`, `main`
Base commit: `21276c5` (`test: prove team concurrency and retry guarantee`)
Phase 5 changes are unstaged and uncommitted. No push or remote workflow result is claimed.

| Phase | Status | Evidence / remaining work |
|---|---|---|
| 0 | passed | `a2f2995`; Docker deferred |
| 1 | passed locally | `fa7e715` |
| 2 | passed locally | `846ea99`; dependency findings retained |
| 3 | passed locally | `f2dec78` |
| 4 | committed; prior local gate passed | `21276c5`; host clock instability persists |
| 5 | implemented; final gate pending | full race suite needs a stable-clock host |
| 6 | not started | Discovery and live state; follows Phase 5 review/gate |
| 7 | not started | Complete React flows; follows Phase 6 |
| 8 | not started | Seed, measure, deploy and verify |
| 9 | not started | Submission and final evidence |
| 10 | optional, not started | Chaos verification |

## Completed in Phase 5

Application creation/withdrawal, leader inbox and accept/decline APIs; leader team edits, invite retrieval/rotation and member removal; member-only audit pagination. Acceptance and removal commit membership, request transitions, audit and idempotency atomically. Reads enforce current permissions; records are scoped to the hackathon. Shared schemas/DTOs, application rate limits and cursor validation are included.

The new API suite has 40 cases (33 individually named behaviors plus seven replay cases), exceeding the requirement of 20 distinct API behaviors. The 20 new mixed-operation race cases cover both lock orders and verify domain effects, invariants, publication and retained idempotency keys. All new mixed races passed in both full runs. README documents the endpoints; UI controls for these APIs remain Phase 7.

## Verification

| Check | Result |
|---|---|
| Lint, typecheck, production build | Passed |
| Regular suite, Node 22.19.0 | **145/145 tests passed**, 13 files |
| Final strengthened cross-hackathon withdrawal test | Passed separately after the full regular run |
| Full concurrency suite, first run | **55 passed, 1 failed**; all 20 Phase 5 mixed races passed |
| Full concurrency suite, unchanged recheck | **54 passed, 2 failed**; all 20 Phase 5 mixed races passed |
| Whitespace and architecture checks | Passed; architecture remains ignored and unchanged |

Use Node 22.19.0 (`nvm use`): the shell default is Node 20, which caused a Vitest reporting error in an initial run. The required runtime passed the full regular suite.

The full race gate is **not green**. Existing last-seat and timeout cases failed while diagnostics recorded roughly nine-second forward/backward clock jumps. PostgreSQL statement timeouts occurred in a case completing in about one monotonic second. One recheck also exceeded the HTTP deadline while waiting for a database lock timeout. A separate probe collected 2,493 samples in 15 monotonic seconds and confirmed simultaneous database/system jumps of approximately -9.30, +9.20 and -9.22 seconds. No timeout, success assertion or retry budget was relaxed.

## Handoff

Implementation and documentation are ready for review. The remaining gate is `npm run test:race` on a stable-clock host or after fixing this host clock. Do not advance to Phase 6 or report a full release pass until that succeeds.

Local evidence is in ignored `.cache/phase5/`; fixtures and owned HTTP servers are cleaned up, and the dedicated local test cluster is stopped. Suggested eventual commit: `feat: add applications and leader controls`.

Remote CI, Docker execution, hosted deployment and benchmarks remain unverified. Browser smoke was not repeated for this API milestone. The prior dependency audit reported nine moderate affected packages: two production Router packages and seven development-tool packages. Those findings remain unaddressed; no fresh audit was run. `ARCHITECTURE.md` remains ignored with SHA-256 `0f0e98f4202195b5c8883126aa22e651ecf4313418e62d1d113cd3a885039d80`.
