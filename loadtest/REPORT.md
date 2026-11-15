# Performance summary

**Status: historical local measurements; current performance gate remains open.** The load harness has since been corrected. Clock anomalies affected the earlier results, so they do not certify the current code or hosted performance.

## Workload and environment

Local Ubuntu 24.04/WSL2; Node 22.19.0, PostgreSQL 16.15, k6 0.54.0; pool of 20 connections and a one-second board cache. Dataset: **10,000 registered users, 2,000 teams, 4,900 memberships**. Team sizes 1/2/3/4 occur 400/600/700/300 times, leaving 1,700 teams with seats and 5,100 solo participants. The original seed was recorded at **4.88 seconds**.

The benchmark specifies a 10-second warm-up at 20 VUs, followed by 60 seconds at **100 VUs**. Traffic is 70% first page, 20% skill filter and 10% second page. Realistic load uses one-second think time; stress has none. The target is **successful HTTP p95 < 200 ms and errors < 1%**. Warm-up is excluded from those thresholds.

## Historical observations

Latencies are milliseconds. These are retained observations, **not a current pass**.

| Scenario | Measured requests | p50 | p95 | p99 | Errors |
|---|---:|---:|---:|---:|---:|
| Realistic | 6,000 | 6.62 | 28.54 | 137.83 | 0% |
| Stress | 68,148 | 83.76 | 123.05 | 8,777.01 | 0% |
| Stress rerun | 57,385 | 96.44 | 163.54 | 9,193.21 | 0% |

The saved artifacts include negative HTTP durations and wall-clock steps. A stable-clock rerun is required; iteration-duration p99 cannot replace HTTP p99. Whole-run request rates include warm-up/setup, while request count divided by the configured 60 seconds is only a nominal rate. No corrected throughput or hosted latency is claimed.

The three captured query plans used `teams_board_idx` without a sort, with execution times of **0.557 / 0.371 / 0.187 ms** for first-page, skill-filtered and cursor queries. These are warm-cache observations; the full [query plans](QUERY_PLANS.md) retain the SQL and buffers. Historical invariant checks reported zero violations. Cache-hit percentage was not measured.

## Reproduce and retain evidence

Against an explicitly selected demo database, with Node 22 and k6 installed:

```sh
npm run migrate
SEED_DEMO=true npm run seed
npm run build
npm run loadtest -- realistic
npm run loadtest -- stress
```

New artifacts go to `loadtest/runs/<run-id>/`: raw samples, summaries, clock probe, invariants and metadata including revision, dirty-tree status, environment and dataset. Earlier `raw-*.json` and `summary-*.json` files remain local, ignored artifacts; they are not bundled with this document. Never publish `tokens.json`.

The updated harness requires valid setup data, distributes user tokens, uses a real first-page cursor, preserves failed k6 exits and rejects detected invalid timing evidence. Its results still need verification on a stable-clock host. The separate **10-VU CI smoke** allows p95 < 500 ms; it does not satisfy the full benchmark. Hosted measurements remain outstanding. [Testing guide](../docs/TESTING.md#performance-checks).
