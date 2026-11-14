# Deployment preparation

Checked against provider documentation on 2026-11-13. This is preparation only: no account, project, region or hosting plan has been selected or provisioned.

- [Render free web services](https://render.com/docs/free) support this one-process app, but spin down after 15 idle minutes and use an ephemeral filesystem. Cold starts must be measured separately from warm benchmarks.
- [Neon plans](https://neon.com/docs/introduction/plans) list a free PostgreSQL plan with 100 CU-hours per project per month, 1 GB storage per project and scale-to-zero after five idle minutes. These are documentation figures, not verified account quotas.
- At Phase 8, choose nearby regions actually available in both accounts, verify PostgreSQL 16 support and the chosen compute's connection limit, and reassess `PG_POOL_MAX=20`. Configure both pooled and direct database URLs; migrations will use the direct URL.
- Configure a production HTTPS `APP_ORIGIN` and fresh secrets. `render.yaml` deliberately leaves region selection and credentials to that phase. No production token belongs in a build argument, repository or report.
- Docker/Compose runtime checks are pending until Docker is available. Native Node and PostgreSQL checks are tracked separately in build status.
- Migration-on-start and authentication/onboarding are implemented and verified locally, including packaged SQL in the compiled build. Team formation, SSE and deployed smoke tests remain prerequisites for calling the app deployed and usable.
- `JWT_SECRET` is required and must contain at least 32 random bytes. Production requires HTTPS `APP_ORIGIN` and uses Secure session cookies. Set `TRUSTED_PROXY_CIDRS` only after verifying the actual proxy chain and ingress restrictions; the default ignores forwarded addresses. Rate limits and session caching currently assume one app instance. Logout clears a browser cookie without server-side JWT revocation.

Compatibility references: [Vite requirements](https://vite.dev/guide/) and [Express installation](https://expressjs.com/en/starter/installing/). Direct dependencies are pinned and the npm lockfile is committed. The local installed Node 22.19.0 satisfies the selected Vite and Vitest engine ranges.
