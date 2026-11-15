# Local query-plan evidence

These plans were recorded with the original seeded local benchmark. They are historical warm-cache observations, not deployed measurements or proof of the revised load harness. See the [performance summary](REPORT.md).

## Board query and captured plans

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
- **Index usage**: all three captured plans use `teams_board_idx`.
- **Sorting**: Zero sort operations (`Sort` node is absent) because `teams_board_idx` provides the pre-ordered index key `(hackathon_id, created_at DESC, id DESC)`.
- **Sequential Scans**: Zero table scans.
- **Buffers**: Zero disk reads; all reads are shared memory hits (`shared hit=100..116`).
- **Join**: Fast index lookup on `users_pkey` taking ~2 microseconds per row.

---
