# API and behavior reference

[Project overview](../README.md) · [Testing guide](TESTING.md)

## Identity and request boundaries

Passwords use Argon2id. Sessions use a seven-day HS256 JWT in the `sid` cookie, with HttpOnly, SameSite=Lax and Path=/; Secure is enabled in production. Tokens are never stored in browser storage. Logout clears the browser cookie; it does **not** revoke an independently retained token. Email verification and password reset remain outside the planned scope.

Unsafe `/api` methods require an `Origin` exactly matching `APP_ORIGIN`, including requests from HTTP test clients. Bodies must be JSON where present and are capped at 10 kB. Unknown fields are rejected, and only `/me` returns the caller's email; password hashes never leave the API. Self-assignment of organizer status is prohibited.

Limits are in-process and require one app instance: signup 20 attempts/IP/hour, login 10 failures/15 minutes independently per IP and normalized email, authenticated mutations 60/user/minute and reads 600/user/minute. In-flight logins reserve quota; successful attempts refund only their own reservation. A 429 includes `Retry-After`. `TRUSTED_PROXY_CIDRS` defaults to empty (forwarded addresses ignored); configure only the verified proxy addresses/CIDRs at deployment.

Invalid/expired invite attempts allow 10/user and 40/IP per 15 minutes. In-flight IP flood protection permits up to 100 concurrent attempts per IP with immediate in-flight slot release. Exhausted failure budgets reject attempts before database work; otherwise invalid/expired outcomes consume the failure quota after validation. Domain conflicts (such as `TEAM_FULL`, `ALREADY_IN_TEAM`, or idempotency replays) and successful joins never count against the invalid-code failure budget.

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

