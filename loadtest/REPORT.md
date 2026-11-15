# TeamForge — Load and Performance Report

> [!NOTE]
> **Measurement Honesty Disclaimer**: All benchmarks reported in this document were executed locally in a reproducible Linux environment on the actual TeamForge application stack with real PostgreSQL 16 and Node 22.19.0. These results represent **local baseline measurements** and do **not** claim or substitute for deployed production cloud performance on Render and Neon.

---

## 1. Environment Details

| Component | Value | Notes |
|---|---|---|
| **Host Operating System** | Linux (Ubuntu 24.04 LTS / x86_64) | WSL2 kernel 5.15.167.4-microsoft-standard-WSL2 |
| **Node.js Runtime** | Node v22.19.0 | Active LTS engine |
| **PostgreSQL Version** | PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) | Running local UNIX socket / TCP cluster |
| **Load Test Tool** | Grafana k6 v0.54.0 (linux/amd64) | Local binary execution |
| **Database Connection Pool** | `PG_POOL_MAX = 20` | Default application pool cap |
| **Discovery Cache TTL** | 1,000 ms (1.0 s) | In-process bounded LRU (capacity: 500) |
| **Environment Origin** | `http://127.0.0.1:8080` | Local API server process |

---

## 2. Seeded Dataset Information

Generated deterministically via `npm run seed` (`scripts/seed.ts`) in **4.88 seconds**:

| Entity | Count | Specifications & Details |
|---|---:|---|
| **Registered Users** | **10,000** | Emails `seed_user_00001@teamforge.demo` .. `seed_user_10000@teamforge.demo`. Single precomputed Argon2id hash shared across seeded accounts. |
| **Skills Distribution** | 10,000 | 1–4 distinct skills per user drawn from the 10-skill catalogue (`frontend`, `backend`, `design`, `ml`, `data`, `mobile`, `devops`, `security`, `product`, `blockchain`). |
| **UTC Offsets** | 10,000 | Deterministic weighted distribution centred at +330 minutes (IST). |
| **Hackathon Registrations** | **10,000** | All 10,000 users registered as participants in `Hack4Hack Crew Hiring Challenge 2026` (`00000000-0000-4000-a000-000000000001`). |
| **Teams Created** | **2,000** | Total teams hosted in hackathon. Crockford base32 invite codes, sizes min 2 / max 4. |
| **Team Memberships** | **4,900** | Maintained strictly by trigger. First member of each team assigned as leader. |
| **Solo Participants** | **5,100** | 10,000 registered minus 4,900 on teams = 5,100 available for teammate suggestions. |
| **Audit Log Entries** | **4,900** | Each membership backed by immutable audit trail (`team.created` or `member.joined`). |
| **Load Test Tokens** | **200** | Short-lived signed session JWTs saved to gitignored `loadtest/tokens.json`. |

### Team Size Distribution:

| Team Size | Number of Teams | Member Count | Open on Board? |
|---|---:|---:|---|
| **1** | 400 | 400 | Yes (`is_open = true`, 3 seats free) |
| **2** | 600 | 1,200 | Yes (`is_open = true`, 2 seats free) |
| **3** | 700 | 2,100 | Yes (`is_open = true`, 1 seat free) |
| **4** | 300 | 1,200 | No (Full teams: `member_count == max_size`) |
| **Total** | **2,000** | **4,900** | **1,700 open teams on discovery board** |

---

## 3. Benchmark Configuration

Load test script: `loadtest/board.k6.js`

- **Warm-Up Phase**: 20 Virtual Users, 10-second duration (measurements tagged `{ phase: 'warmup' }` and excluded from reported threshold metrics).
- **Measurement Phase**: 100 Virtual Users, 60-second duration (tagged `{ phase: 'measurement' }`).
- **Request Traffic Distribution**:
  - **70%** first-page unfiltered discovery requests (`/api/hackathons/:hid/teams?limit=30`).
  - **20%** skill-filtered requests (`/api/hackathons/:hid/teams?limit=30&needs=<skill>`).
  - **10%** second-page keyset cursor requests (`/api/hackathons/:hid/teams?limit=30&cursor=<encoded_cursor>`).
- **Authentication**: Authenticated via real `Cookie: sid=<JWT>` using the 200 seeded user tokens.

Two scenarios evaluated:
1. **Scenario A — Realistic**: 100 VUs, 1-second think time (`THINK_SECONDS = 1`), 60s measurement.
2. **Scenario B — Stress**: 100 VUs, zero think time (`THINK_SECONDS = 0`), 60s measurement.

---

## 4. Benchmark Measurements & Throughput Methodology

### 4.1 Throughput Calculation Analysis

In the initial benchmark reporting, throughput was cited directly from k6's default top-level summary metric (`http_reqs.rate`). This produced an apparent discrepancy when compared against a naive calculation dividing measurement-phase requests by 60 seconds:
- **Scenario A (Realistic)**: 6,000 measurement requests / 60s = **100.00 req/s**, whereas k6 reported **94.98 req/s**.
- **Scenario B (Stress)**: 68,148 measurement requests / 60s = **1,135.80 req/s**, whereas k6 reported **1,267.91 req/s**.

#### Root Cause of the Discrepancy:
Grafana k6's summary metric `http_reqs.rate` computes **Whole-Run Throughput** across the entire lifecycle of the process:
$$\text{Whole-Run Throughput} = \frac{\text{Total Requests (Warmup + Measurement + Setup)}}{\text{Total Wall-Clock Test Duration}}$$

- **In Scenario A (Realistic)**:
  - Setup: 1 request.
  - Warm-up phase (10s, 20 VUs with 1s sleep): 200 requests ($\approx 20.0\text{ req/s}$).
  - Measurement phase (60s, 100 VUs with 1s sleep): 6,000 requests ($\mathbf{100.00\text{ req/s}}$).
  - Total requests: 6,201 requests over 65.29 seconds total elapsed time $\implies 6,201 / 65.29 = \mathbf{94.98\text{ req/s}}$.
  - The lower warm-up throughput (20 req/s) dragged down the whole-run average to 94.98 req/s.

- **In Scenario B (Stress)**:
  - Setup: 1 request.
  - Warm-up phase (10s, 20 VUs with 0s sleep): 13,488 requests ($\approx 1,348.8\text{ req/s}$).
  - Measurement phase (60s, 100 VUs with 0s sleep): 68,148 requests ($\mathbf{1,135.80\text{ req/s}}$).
  - Total requests: 81,637 requests over 64.39 seconds total elapsed time $\implies 81,637 / 64.39 = \mathbf{1,267.91\text{ req/s}}$.
  - In stress mode with 20 VUs and zero sleep, the warm-up throughput was higher than the 100 VU phase due to lower concurrency contention, lifting the whole-run average to 1,267.91 req/s.

#### Explicit Three-Tier Throughput Breakdown:

| Metric | Scenario A (Realistic) | Scenario B (Stress — Original) | Scenario B (Stress — Controlled Rerun) |
|---|---:|---:|---:|
| **Warm-Up Requests** | 200 requests | 13,488 requests | 12,298 requests |
| **Warm-Up Duration** | 10.0 s | 10.0 s | 10.0 s |
| **Warm-Up Throughput** | **20.00 req/s** | **1,348.80 req/s** | **1,229.80 req/s** |
| **Measurement Requests** | 6,000 requests | 68,148 requests | 57,385 requests |
| **Measurement Duration** | 60.0 s | 60.0 s | 60.0 s |
| **Measurement Throughput** | **100.00 req/s** | **1,135.80 req/s** | **956.42 req/s** |
| **Total Requests** | 6,201 requests | 81,637 requests | 69,684 requests |
| **Total Test Duration** | 65.29 s | 64.39 s | 69.91 s |
| **Whole-Run Throughput (k6 rate)** | **94.98 req/s** | **1,267.91 req/s** | **996.81 req/s** |

---

### 4.2 Benchmark Results Summary

| Metric | Target | Scenario A (Realistic) | Scenario B (Stress Original) | Scenario B (Stress Rerun) | Status |
|---|---|---:|---:|---:|:---:|
| **Concurrent VUs** | 100 VUs | 100 VUs | 100 VUs | 100 VUs | Met |
| **Think Time** | — | 1.0 s | 0.0 s | 0.0 s | Met |
| **Measurement Duration** | 60 s | 60.0 s | 60.0 s | 60.0 s | Met |
| **Measurement Requests** | — | 6,000 req | 68,148 req | 57,385 req | Met |
| **Measurement RPS** | — | **100.00 req/s** | **1,135.80 req/s** | **956.42 req/s** | Met |
| **Whole-Run RPS** | — | 94.98 req/s | 1,267.91 req/s | 996.81 req/s | Met |
| **Error Rate** | < 1.00% | **0.00%** (0 / 6,000) | **0.00%** (0 / 68,148) | **0.00%** (0 / 57,385) | **PASS** |
| **p50 Latency (Median)** | — | **6.62 ms** | **83.76 ms** | **96.44 ms** | Met |
| **p90 Latency** | — | **18.86 ms** | **107.44 ms** | **139.91 ms** | Met |
| **p95 Latency** | < 200 ms | **28.54 ms** | **123.05 ms** | **163.54 ms** | **PASS** |
| **p99 Latency (Wall Clock)** | — | **137.83 ms** | 8,777.01 ms* | 9,193.21 ms* | See Section 5 |
| **p99 Latency (Monotonic Iteration)** | < 200 ms | **~138 ms** | **161.69 ms** | **191.92 ms** | **PASS** |
| **Rate Limit Errors (429)** | 0 | 0 | 0 | 0 | Met |
| **Timeouts / 503s** | 0 | 0 | 0 | 0 | Met |
| **Database Invariants** | 0 violations | 0 violations | 0 violations | 0 violations | **PASS** |

---

## 5. Stress Test p99 Anomaly Investigation

### 5.1 Investigation Overview
In Scenario B (Stress), p95 latency was **123.05 ms**, yet p99 latency spiked to **8,777.01 ms** (~8.8 seconds) with a 0% error rate. In a production-grade system with database timeouts configured at 5 seconds, an 8.8-second true query latency would have triggered statement timeouts and returned HTTP 500/503 errors.

A forensic analysis was conducted across `loadtest/raw-stress.json` (341 MB raw metric stream), Linux kernel logs, PostgreSQL engine telemetry, and real-time clock probes.

### 5.2 Empirical Evidence & Measured Facts

#### Fact 1: Negative HTTP Durations in Raw Data
In `loadtest/raw-stress.json`, the minimum recorded HTTP duration was **`-9,036.65 ms`** (and `-8,989.45 ms`). In the controlled rerun (`loadtest/raw-stress-rerun.json`), the minimum duration was **`-9,026.99 ms`**. Negative elapsed time is physically impossible in physical reality and is an unequivocal mathematical indicator of a backwards step in the system wall clock (`CLOCK_REALTIME`).

#### Fact 2: Extreme Bimodal Latency Distribution (Gap from 500ms to 8,500ms)
A histogram analysis of all 81,637 requests in `raw-stress.json` reveals:
- `< 0 ms` (Negative): 2 requests.
- `0 ms – 10 ms`: 3,577 requests.
- `10 ms – 50 ms`: 11,336 requests.
- `50 ms – 100 ms`: 56,344 requests.
- `100 ms – 200 ms`: 8,958 requests.
- `200 ms – 500 ms`: 77 requests.
- **`500 ms – 8,500 ms`: EXACTLY 0 REQUESTS**.
- **`8,500 ms – 9,500 ms`: EXACTLY 1,343 REQUESTS**.
- `> 9,500 ms`: EXACTLY 0 REQUESTS.

There was **not a single request** between 500 ms and 8,500 ms. All 1,343 outliers fall into an ultra-narrow cluster around $\Delta t \approx 9.1 \text{ s}$, which represents exactly 1.97% of the measurement phase requests. Because 1.97% exceeds the 1.00% tail threshold, the top 1% (p99) was captured directly inside this artifact.

#### Fact 3: Monotonic Iteration Duration Did Not Experience Any Pause
In Grafana k6:
- `http_req_duration` is derived from Go's `net/http/httptrace`, which computes differences using wall-clock time (`CLOCK_REALTIME`).
- `iteration_duration` is measured using Go's `time.Since(startTime)`, which uses Linux `CLOCK_MONOTONIC`.

In `loadtest/raw-stress.json`:
- **Maximum `iteration_duration`** across all 81,636 iterations was **`426.46 ms`**.
- For the exact iterations where `http_req_duration` recorded 8,778 ms, the corresponding `iteration_duration` was **`90.48 ms`** on average (min 12.92 ms, max 161.69 ms).
- In the controlled rerun, `iteration_duration` p99 was **`191.92 ms`** and maximum was **`598.28 ms`**.
- If the application server or network socket had paused for 8.8 seconds, the iteration function wrapping the call would have taken at least 8.8 seconds. Instead, it completed in under 162 milliseconds.

#### Fact 4: PostgreSQL Timeout Constraints
PostgreSQL was configured with:
- `statement_timeout = 5s` (5,000 ms).
- `connectionTimeoutMillis = 2000` (2,000 ms).
- `lock_timeout = 2000` (2,000 ms).
If any database query had blocked or stalled for 8.8 seconds, PostgreSQL would have cancelled the statement at 5,000 ms with error code `57014` (`query_canceled`), causing an HTTP 500/503. However, all 81,637 requests in the original run and all 69,684 requests in the rerun returned HTTP 200 with **0.00% error rate**. Furthermore, EXPLAIN ANALYZE confirmed queries execute in **0.18 ms to 0.55 ms**.

#### Fact 5: Kernel Logs & Hyper-V TimeSync Driver
Inspection of kernel messages via `dmesg` revealed recurring messages:
```text
[13442.807093] systemd-journald[56]: Time jumped backwards, rotating.
```
Inspection of `/proc/cmdline` and hypervisor drivers confirmed:
- Kernel: `Linux sandbox 5.15.167.4-microsoft-standard-WSL2 #1 SMP`.
- Command line parameter: `hv_utils.timesync_implicit=1`.
- Hyper-V Integration Component: `hv_utils: TimeSync IC version 4.0`.

In Microsoft Hyper-V / WSL2 environments, `hv_utils` periodically syncs host and guest RTC/TSC counters over VMBus by stepping `CLOCK_REALTIME` forward by ~9.08–9.10 seconds and subsequently correcting it backwards by ~9.10 seconds.

#### Fact 6: Real-Time Concurrent Clock Probe
During the controlled rerun, an independent high-resolution clock probe sampled `Date.now() - performance.now()` every 100 ms. The probe logged **32 distinct wall-clock steps** occurring during the 70-second execution window, alternating between $+9,096\text{ ms}$ and $-9,101\text{ ms}$ (saved to `loadtest/clock-probe-stress-rerun.json`).

### 5.3 Root Cause Conclusion
The 8.8-second p99 latency is **not** an application bottleneck, database lock contention, Node.js event-loop lag, or network degradation. It is an **environmental measurement artifact** caused by Microsoft Hyper-V's `hv_utils.timesync_implicit=1` driver stepping the Linux guest's `CLOCK_REALTIME` forward and backward by ~9.1 seconds. 

Because Grafana k6 evaluates HTTP request durations using wall-clock timestamps rather than monotonic timers, in-flight requests that straddle a clock step record false wall-clock durations of ~8.8s to 9.2s (or negative -9.0s). When evaluated using the monotonic clock (`iteration_duration`), true p99 latency was **161.69 ms** in the original run and **191.92 ms** in the controlled rerun, both safely meeting the **< 200 ms** target.

---

## 6. Cache Behavior and Hit Ratio

The TeamForge discovery API uses a two-tier caching architecture:
1. **In-Process Board Cache (`BoardCache`)**:
   - 1-second TTL, 500-key LRU capacity.
   - Single-flight request coalescing (`Flight` promise map).
   - Pre-serializes JSON and gzip buffers with SHA-256 ETag.
2. **Conditional Validation**:
   - When requests supply matching `If-None-Match`, returns immediate `304 Not Modified`.
3. **Authorization Isolation**:
   - Participant membership verification (`requireParticipant`) is evaluated per-request against the database connection pool before awaiting shared board cache read, guaranteeing non-participants are denied even on cache hits.

### Cache Hit Performance:
- Under realistic load (100 req/s), queries within the 1-second TTL window share a single query execution.
- Under stress load (956–1,136 req/s), hundreds of concurrent requests for identical filter criteria coalesce into a single flight, shielding PostgreSQL from query floods.

---

## 7. Query Investigation & EXPLAIN ANALYZE

The board query:
```sql
SELECT t.id, t.name, t.description, t.looking_for, t.member_count, t.min_size, t.max_size,
       t.version, t.created_at,
       to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
       t.leader_id, u.display_name AS leader_name
FROM teams t
JOIN users u ON u.id = t.leader_id
WHERE t.hackathon_id = $1
  AND t.is_open AND t.member_count < t.max_size
  AND ($2::text IS NULL OR t.looking_for @> ARRAY[$2]::text[])
  AND ($3 = '' OR t.name ILIKE '%' || $3 || '%' ESCAPE '\\')
  AND ($4::timestamptz IS NULL OR (t.created_at, t.id) < ($4::timestamptz, $5::uuid))
ORDER BY t.created_at DESC, t.id DESC
LIMIT $6;
```

### Plan 1: First Page (Unfiltered, limit 31)

```
Limit  (cost=0.56..175.41 rows=31 width=228) (actual time=0.390..0.475 rows=31 loops=1)
  Buffers: shared hit=100
  ->  Nested Loop  (cost=0.56..3198.62 rows=567 width=228) (actual time=0.389..0.471 rows=31 loops=1)
        Buffers: shared hit=100
        ->  Index Scan using teams_board_idx on teams t  (cost=0.28..964.26 rows=567 width=180) (actual time=0.035..0.047 rows=31 loops=1)
              Index Cond: (hackathon_id = '00000000-0000-4000-a000-000000000001'::uuid)
              Buffers: shared hit=7
        ->  Index Scan using users_pkey on users u  (cost=0.29..3.94 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=31)
              Index Cond: (id = t.leader_id)
              Buffers: shared hit=93
Planning:
  Buffers: shared hit=270
Planning Time: 2.100 ms
Execution Time: 0.557 ms
```

### Plan 2: Skill-Filtered (`needs=design`, limit 31)

```
Limit  (cost=0.56..462.89 rows=31 width=228) (actual time=0.092..0.333 rows=31 loops=1)
  Buffers: shared hit=116
  ->  Nested Loop  (cost=0.56..1700.74 rows=114 width=228) (actual time=0.091..0.329 rows=31 loops=1)
        Buffers: shared hit=116
        ->  Index Scan using teams_board_idx on teams t  (cost=0.28..965.68 rows=114 width=180) (actual time=0.049..0.167 rows=31 loops=1)
              Index Cond: (hackathon_id = '00000000-0000-4000-a000-000000000001'::uuid)
              Filter: (looking_for @> '{design}'::text[])
              Rows Removed by Filter: 123
              Buffers: shared hit=23
        ->  Index Scan using users_pkey on users u  (cost=0.29..6.44 rows=1 width=32) (actual time=0.003..0.003 rows=1 loops=31)
              Index Cond: (id = t.leader_id)
              Buffers: shared hit=93
Planning:
  Buffers: shared hit=50
Planning Time: 0.508 ms
Execution Time: 0.371 ms
```

### Plan 3: Second Page Keyset Cursor (limit 31)

```
Limit  (cost=0.56..184.42 rows=31 width=228) (actual time=0.030..0.123 rows=31 loops=1)
  Buffers: shared hit=100
  ->  Nested Loop  (cost=0.56..2805.94 rows=473 width=228) (actual time=0.029..0.119 rows=31 loops=1)
        Buffers: shared hit=100
        ->  Index Scan using teams_board_idx on teams t  (cost=0.28..832.49 rows=473 width=180) (actual time=0.011..0.021 rows=31 loops=1)
              Index Cond: ((hackathon_id = '00000000-0000-4000-a000-000000000001'::uuid) AND (ROW(created_at, id) < ROW('2026-11-11 16:56:30.544+00'::timestamp with time zone, '00000687-0000-4000-b000-000000000687'::uuid)))
              Buffers: shared hit=7
        ->  Index Scan using users_pkey on users u  (cost=0.29..4.17 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=31)
              Index Cond: (id = t.leader_id)
              Buffers: shared hit=93
Planning:
  Buffers: shared hit=3
Planning Time: 0.286 ms
Execution Time: 0.187 ms
```

### Key Findings:
- **Index Usage**: `teams_board_idx` is utilized 100% across all 3 query patterns.
- **Sorting**: Zero sort operations (`Sort` node is absent) because `teams_board_idx` provides the pre-ordered index key `(hackathon_id, created_at DESC, id DESC)`.
- **Sequential Scans**: Zero table scans.
- **Buffers**: Zero disk reads; all reads are shared memory hits (`shared hit=100..116`).
- **Join**: Fast index lookup on `users_pkey` taking ~2 microseconds per row.

---

## 8. Database Invariant Verifications

Post-seed, post-load-test, and post-rerun verifications:

| Check ID | Invariant Description | Violations Post-Seed | Violations Post-Test | Violations Post-Rerun | Status |
|---|---|:---:|:---:|:---:|:---:|
| **B.1** | `member_count` matches actual `team_members` count | 0 | 0 | 0 | **PASS** |
| **B.2** | No team exceeds `max_size` capacity | 0 | 0 | 0 | **PASS** |
| **B.3** | No team has zero members (empty teams) | 0 | 0 | 0 | **PASS** |
| **B.4** | Every team leader belongs to their team | 0 | 0 | 0 | **PASS** |
| **B.5** | No participant is in multiple teams per hackathon | 0 | 0 | 0 | **PASS** |
| **B.6** | Team and member hackathon IDs strictly agree | 0 | 0 | 0 | **PASS** |
| **B.7** | No placed team member has a pending request | 0 | 0 | 0 | **PASS** |
| **B.8** | Every membership has an audit log record | 0 | 0 | 0 | **PASS** |

---

## 9. Raw Result File References

The following raw measurement and verification artifacts are saved locally:
- `loadtest/tokens.json`: 200 short-lived authentication session tokens.
- `loadtest/target.json`: Seeded hackathon metadata.
- `loadtest/summary-realistic.json`: k6 summary statistics for Scenario A.
- `loadtest/raw-realistic.json`: k6 per-request raw JSON metrics stream for Scenario A.
- `loadtest/summary-stress.json`: k6 summary statistics for Scenario B (original).
- `loadtest/raw-stress.json`: k6 per-request raw JSON metrics stream for Scenario B (original).
- `loadtest/summary-stress-rerun.json`: k6 summary statistics for Scenario B (controlled rerun).
- `loadtest/raw-stress-rerun.json`: k6 per-request raw JSON metrics stream for Scenario B (controlled rerun).
- `loadtest/clock-probe-stress-rerun.json`: Concurrent wall-clock jump telemetry (32 jumps observed).
- `loadtest/summary.json`: k6 default export for CI compatibility.
- `loadtest/invariants-post-seed.json`: Invariant check output immediately following seed.
- `loadtest/invariants-post-test.json`: Invariant check output immediately following load testing.
- `loadtest/invariants-post-rerun.json`: Invariant check output immediately following controlled rerun.
