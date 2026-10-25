# CI/CD

How changes are checked before they reach `main`, and how a commit on `main` gets to production. The release flow is: short-lived feature branch, pull request, squash-merge to `main`, then a deliberate deploy. Local setup is in [development.md](development.md); tools for working with Cloudflare directly are in [cloudflare-tooling.md](cloudflare-tooling.md).

There is one environment, production. The only deployer is GitHub Actions. `scripts/deploy.ts`, `scripts/setup.ts` and `scripts/undeploy.ts` are bootstrap tools from the upstream template: they rewrite tracked files, mint secrets and run unpinned external code, so CI never runs them.

## Pull request checks

`.github/workflows/ci.yml` runs on every pull request and is also callable from other workflows. Four jobs run in parallel and feed one required check, `gate`.

| Job | Step | Blocks merge |
| --- | --- | --- |
| `check` | Typecheck, lint, Worker types are current (`cf-typegen:check`), tests, `space` typecheck | Yes |
| | Pull request title is a Conventional Commit | Yes |
| | Migration guard | Yes |
| | Knip | No (report only) |
| `build` | `bun run build` | Yes |
| | Wrangler config guard | Only when `enforce` is true in `.github/deploy.config.json` |
| | `wrangler deploy --dry-run` | Yes, but runs only when the config guard reports no findings |
| `sdk` | `sdk/` install, typecheck, tests, build, bundled types | Yes |
| `security` | gitleaks over the pull request commits | Yes |
| | actionlint and zizmor over `.github/` | Yes |
| | `bun audit --audit-level high` | No (report only) |
| `gate` | Succeeds only when all four jobs succeeded | The only required check |

Every job has a 15-minute timeout and read-only repository permissions. The pull request title is the squash commit subject, so it is linted again whenever it is edited. A new commit cancels the run in flight; editing the title, description or labels instead queues one more run for the same commit, because a run that skipped its checks could otherwise turn a failed commit green. PR titles and branch names reach scripts through `env:`, never interpolated into `run:`.

Run the blocking checks locally with `bun run verify` (see [development.md](development.md)).

### Report-only checks and how they ratchet

Three checks start non-blocking because the repository was not clean when CI was added. Each has one switch:

| Check | At adoption | Becomes blocking when |
| --- | --- | --- |
| Knip | 72 unused files, 24 unused dependencies, 83 unused exports, 111 unused exported types | Findings are cleared; remove `continue-on-error` on the Knip step |
| `bun audit` | 168 advisories (5 critical, 72 high); 125 in production dependencies | `bun audit --audit-level high` is clean; remove `continue-on-error` on the audit step |
| Wrangler config guard | The committed `wrangler.jsonc` still holds the upstream template's hostnames, resource ids and a Dockerfile container image | `wrangler.jsonc` is re-homed to this account's resources; set `"enforce": true` in `.github/deploy.config.json` in the same change |

The dry run is skipped, not failed, while the config guard has findings: with a `Dockerfile` image path wrangler would build the sandbox image on the runner. Once the image is pinned to a `registry.cloudflare.com/` reference the dry run needs no Docker and no credentials.

### Baseline at adoption

Measured from a clean checkout with Node 22.23 and Bun 1.3.14 on an Apple silicon laptop.

| Gate | Result | Time |
| --- | --- | --- |
| `bun install --frozen-lockfile` | Pass | 15 s |
| `bun run typecheck` | Pass | 8 s |
| `bun run lint` | Pass (2 warnings) | 2 s |
| `bun run --cwd space typecheck` | Pass | 1 s |
| `bun run test` | Pass: 40 files, 474 tests, 1 skipped | 6 s |
| `bun run build` | Pass | 2 s |
| `sdk/` install and `bun run package` | Pass | 8 s and 16 s |
| `bun run knip` | Fail | 2 s |
| `bun audit` | Fail | under 1 s |
| `wrangler deploy --dry-run` | Fails without Docker while `image` is a Dockerfile path | 2 s |

## Deploy

`.github/workflows/deploy.yml` is manual (`workflow_dispatch`) and runs from `main`:

```bash
gh workflow run deploy.yml -f ref=main
```

| Input | Meaning |
| --- | --- |
| `ref` | Commit to deploy. It must be an ancestor of `origin/main`. |
| `skip_migrations` | Do not apply D1 migrations. Only for migrations that were applied by hand. |
| `allow_missing_worker` | Allow the first deploy of a Worker that does not exist yet. |

Runs share one concurrency group (`deploy-production`) with `sync-secrets` and `rollback`, and are never cancelled midway. GitHub keeps one waiting run per group: if one run is active and one is already waiting, a third replaces the waiting one. After triggering a rollback during a deploy, check the Actions tab that it is still queued.

Every one of the three workflows first checks that the `production` environment has `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `WORKER_NAME` (and `WORKER_SECRETS` for the sync), and fails naming whatever is missing.

1. **resolve** pins the commit to a SHA, checks that it is on `main`, and refuses when another system is also building it: while Cloudflare Workers Builds is attached it posts a check run on every push (`scripts/ci/assert-no-foreign-builds.ts`).
2. **verify** runs `ci.yml` on that exact commit.
3. **deploy** (environment `production`, limited to `main` by the repository settings):
   1. Check `wrangler.jsonc` against `.github/deploy.config.json`, always enforced.
   2. Build, then check the generated `dist/<worker>/wrangler.json`, which is what gets uploaded.
   3. **Preflight** (`scripts/ci/preflight.ts`) compares that configuration with the live Worker and stops on drift: a binding that points at another resource, a live binding the config would remove, a secret that shares a name with a committed var, a Durable Object migration tag the config does not know (wrangler would replay migrations), or D1 migrations recorded in the database but missing from the repository. It also records the version serving traffic now, which is where an automatic rollback goes.
   4. Record a D1 Time Travel bookmark.
   5. Apply pending D1 migrations. They run before the code uploads, which is why the migration guard keeps them additive.
   6. `wrangler deploy --tag <first 12 characters of the SHA> --message <commit subject>`.
   7. **Smoke checks** (`scripts/ci/smoke.ts`) against `CUSTOM_DOMAIN`, retried for about a minute each: `/api/health` is `{"status":"ok"}`, `/api/capabilities` lists features (the shipped vars), `/api/apps/public?limit=1` succeeds (a D1 query, unauthenticated), and `/` serves HTML (the assets).
   8. If a smoke check failed, decide on a rollback, then fail the run.
   9. A job summary lists the commit, Worker version, restore point and outcomes.

The wrangler deploy does not pass `--containers-rollout`: wrangler 4.90 only accepts `immediate` or `gradual`, and there is no way to say "none". Instead the container `image` in `wrangler.jsonc` is pinned to the live registry reference, so a deploy leaves the container application unchanged. Keep `max_instances`, `instance_type` and `rollout_step_percentage` equal to the live application for the same reason. `--strict` is not used: what it blocks is undocumented and unverified.

### Automatic rollback

A failed smoke check rolls back automatically only when the release left the data model alone:

| Release | Result |
| --- | --- |
| No D1 migration applied, no Durable Object migration | Roll back to the version that served before |
| Applied D1 migrations | Fail and leave recovery to a person: D1 is forward-only and the old version was not tested against the new schema |
| Applied a Durable Object migration | Fail: Cloudflare blocks rolling back across a class change |
| No previous version recorded | Fail |

The run always ends failed when smoke checks fail, even after a successful rollback.

## Rollback

`.github/workflows/rollback.yml` is manual:

```bash
gh workflow run rollback.yml -f reason="why" [-f version_id=<id>] [-f force_secret_revert=true]
```

It lists the deployments, puts the chosen version (by default the one before the current deployment) on 100% of traffic through the deployments API, then runs the smoke checks.

It deliberately does not call `wrangler rollback`. Secrets are part of a Worker version, so Cloudflare refuses a rollback to a version older than a secret change (error 10220) and names the secrets. `wrangler rollback` answers its own confirmation with "yes" when it is not interactive and retries with force, which would silently bring old secret values back, possibly an older JWT secret or a revoked Cloudflare token. The workflow stops instead and prints the secret names. Roll back to a newer version, or set `force_secret_revert` if reverting those secrets is what you want. Rolling back never reverts D1, KV, R2 or Durable Object data.

A secret change creates its own version and deployment. `sync-secrets` therefore refuses to run while the active deployment is a rollback.

## Secrets

Runtime secrets are never touched by a deploy. Their source of truth is the GitHub environment secret `WORKER_SECRETS` on `production`: a JSON object of secret name to value. `.github/workflows/sync-secrets.yml` pushes it:

```bash
gh workflow run sync-secrets.yml                       # dry run: names only
gh workflow run sync-secrets.yml -f apply=true         # write
gh workflow run sync-secrets.yml -f apply=true -f allow_delete=true   # null values delete
```

It is additive: secrets that are not listed stay as they are, so a partial `WORKER_SECRETS` cannot wipe the Worker. Before anything is written it checks, without ever printing a value:

- The JSON is an object of at most 100 valid binding names to non-empty strings (`null` deletes, and only with `allow_delete`; deletion uses `wrangler secret delete`, because `wrangler secret bulk` rejects non-string values).
- `JWT_SECRET` passes the same rules the Worker enforces at startup (`shared/utils/jwt-secret.ts`): 32 or more characters, three character classes, no run of four identical characters.
- `CLOUDFLARE_API_TOKEN` differs from the CI deploy token, so the Worker holds a narrower token than the pipeline.
- No name is also a committed `vars` entry; non-secret configuration belongs in `wrangler.jsonc`.
- The Worker exists (unless `allow_missing_worker`, which lets wrangler create a draft Worker to hold the secrets) and the active deployment is not a rollback.

Values are registered with the runner's log masking first, travel to wrangler through a temporary file with mode 600 (never a command line), and the file is deleted afterwards.

### Inventory

By name. Which of these the deployment needs depends on the features enabled.

| Name | Kind | Notes |
| --- | --- | --- |
| `JWT_SECRET` | Required secret | Signs sessions. Rotating it signs everyone out. |
| `CLOUDFLARE_API_TOKEN` | Required secret | The Worker's own token; see the matrix below. Must differ from the CI token. |
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | Secret | Gateway authentication; falls back to `CLOUDFLARE_API_TOKEN`. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_STUDIO_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY` | Optional secrets | Provider keys; unset means the gateway's stored keys. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_EXPORTER_CLIENT_ID`, `GITHUB_EXPORTER_CLIENT_SECRET`, `CLOUDFLARE_OAUTH_CLIENT_ID`, `CLOUDFLARE_OAUTH_CLIENT_SECRET` | Optional secrets | Sign-in and export integrations. |
| `CF_OAUTH_ENCRYPTION_KEY` | Optional secret | Encrypts the AI Gateway token cookie. |
| `AI_PROXY_JWT_SECRET`, `SENTRY_DSN`, `CLOUDFLARE_AI_GATEWAY_URL`, `CF_ACCESS_ID`, `CF_ACCESS_SECRET`, `SERPAPI_KEY`, `SANDBOX_SERVICE_API_KEY` | Optional secrets | Read when present. |
| `CLOUDFLARE_ACCOUNT_ID`, `ENVIRONMENT`, `CUSTOM_DOMAIN`, `CUSTOM_PREVIEW_DOMAIN`, `DISPATCH_NAMESPACE`, `CLOUDFLARE_AI_GATEWAY`, `MAX_SANDBOX_INSTANCES`, `SANDBOX_INSTANCE_TYPE`, `TEMPLATES_REPOSITORY`, `PLATFORM_MODEL_PROVIDERS` | Not secrets | The template's deploy script uploaded these as secrets. Keep them in committed `vars`; the sync refuses them. |
| `ENABLE_*`, `ALLOWED_EMAIL`, `ALLOCATION_STRATEGY`, `USE_CLOUDFLARE_IMAGES` | Dashboard-managed | Feature toggles. `keep_vars: true` preserves them across deploys; see [setup.md](setup.md#dashboard-managed-feature-toggles). |

## Credentials

| Credential | Lives in | Scope |
| --- | --- | --- |
| CI deploy token | GitHub environment secret `CLOUDFLARE_API_TOKEN` on `production`, passed only to the steps that call Cloudflare | One account and one zone. |
| Account id and Worker name | GitHub environment variables `CLOUDFLARE_ACCOUNT_ID` and `WORKER_NAME` | Not secret. Every script refuses to act when `WORKER_NAME` differs from the name in the configuration. |
| Worker runtime secrets | GitHub environment secret `WORKER_SECRETS` | Pushed by `sync-secrets` only. |
| Worker runtime Cloudflare token | A key inside `WORKER_SECRETS` | Workers Scripts: Edit, AI Gateway: Run and Read, Browser Rendering: Edit, Account Analytics: Read. No zone, DNS, D1, KV, R2, container or Builds access. |
| Local and agent access | `wrangler login` (OAuth), minimal scopes | Never stored in GitHub, never shared with the deploy token. |

The CI deploy token starts from the list in [setup.md](setup.md#cloudflare-account-information), with Workers Routes: Edit narrowed to the one zone. Prune it after the first green deploy: remove one permission at a time and re-run the preflight, then record the permissions that remain here.

## Before the first deploy

Nothing deploys automatically. Complete these in order; each Cloudflare write is yours to make.

1. **Disconnect Cloudflare Workers Builds.** It is connected to this repository today: every push produced a `Workers Builds: vibesdk-production` check run, and a merge to `main` would start a production build that runs the template's `scripts/deploy.ts`, which mints a new `JWT_SECRET` and uploads a broad token as the runtime token. In the dashboard, open the Worker, Settings, Builds, and disconnect (note the commands and root directory first). The deploy workflow refuses to deploy a commit that has the check run. A commit keeps it after you disconnect, so merge only after disconnecting; to return to a version built earlier use `rollback.yml`, not `deploy.yml`.
2. **Check whether the Worker exists.** Workers Builds reported "This Worker does not exist on your account" for the account it is bound to. If so, the first deploy is a bootstrap: the D1 database, KV namespace, R2 bucket, dispatch namespace, AI Gateway and templates must exist first, and the container image needs a one-time push from a machine with Docker so its registry reference can be pinned.
3. **Collect the live state.** Build (`bun run build`), then run `bun scripts/ci/preflight.ts --config dist/<worker>/wrangler.json --report` with a read-only API token in `CLOUDFLARE_API_TOKEN` and the account in `CLOUDFLARE_ACCOUNT_ID`. It prints the live bindings, migration tag, secret names and recent deployments next to the findings, and reads no value. It does not use the `wrangler login` session.
4. **Re-home `wrangler.jsonc`.** Replace the template's routes, zone, `CUSTOM_DOMAIN`, D1, KV, R2, dispatch namespace and container image with this account's values, move the variables listed as "not secrets" above into `vars`, regenerate the Worker types, fill `zoneIds` and `resources` in `.github/deploy.config.json`, and set `"enforce": true`.
5. **Delete the live secrets that collide with committed `vars`** (the sync and the preflight both refuse them).
6. **Set the environment** (`scripts/ops/configure-github.sh`, then `gh secret set --env production` for `CLOUDFLARE_API_TOKEN` and `WORKER_SECRETS`, and `gh variable set --env production` for `CLOUDFLARE_ACCOUNT_ID` and `WORKER_NAME`). Run `sync-secrets` as a dry run, then for real.
7. **Deploy once by hand** (`gh workflow run deploy.yml -f ref=main`), confirm the smoke checks pass and the new version carries the SHA tag, then register and sign in by hand.
8. **Exercise the rollback** while there are no users, then deploy forward again.

## Deploying on every merge (the last step)

`deploy.yml` stays manual until the checklist above is complete and a manual deploy, a rollback and a forward deploy have all worked. Only then is it worth making a merge to `main` deploy by itself. The change is small:

1. Add the trigger: `on.push.branches: [main]`.
2. In `resolve`, take the commit from `inputs.ref || github.sha` (inputs are empty on a push), and skip when a newer commit has landed: if `git rev-parse origin/main` is not `GITHUB_SHA`, set an output `skip=true`, and put `if: needs.resolve.outputs.skip != 'true'` on `verify` and `deploy`. The newest commit then carries the deploy, and the concurrency group (which keeps only the newest pending run) serializes the rest.
3. Merge a trivial documentation pull request and confirm it deploys on its own.

Even then every manual-run safeguard still applies, because they are steps of the same job: the commit must be on `main`, CI must pass on it, the configuration guards are enforced, the preflight must be clean, and a failed smoke check rolls back or fails the run.

## Runbooks

**Deploy.** `gh workflow run deploy.yml -f ref=main`. Read the job summary for the Worker version and the D1 restore point.

**Roll back.** `gh workflow run rollback.yml -f reason="..."`. If it refuses because secrets changed, read which, and either choose a newer version or pass `force_secret_revert=true`. If the release applied D1 or Durable Object migrations, follow the next two entries instead of rolling back blindly.

**Restore D1.** Each deploy records a Time Travel bookmark in its summary. Restoring rewinds the whole database, including data written since: `wrangler d1 time-travel restore <database> --bookmark=<bookmark>`. Time Travel keeps 30 days on the Workers Paid plan. Stop writes first and prefer a forward fix when the damage is small.

**Rotate a secret.** Edit `WORKER_SECRETS` with `gh secret set WORKER_SECRETS --env production < secrets.json` (delete the file afterwards), run `sync-secrets` as a dry run, then with `apply=true`. Rotating `JWT_SECRET` signs everyone out. Rotating the runtime Cloudflare token: create the new token first, sync, verify, then revoke the old one.

**Change the schema without downtime (expand and contract).** Migrations run before the code deploys, so never remove or rename in the same release that stops using it. First release: add the new column or table (additive), keep writing and reading the old one. Second release: switch the code to the new one. Third release: drop the old one, in a migration labelled `destructive-migration`, once nothing reads it.

**Change a Durable Object class.** `migrations` in `wrangler.jsonc` is append-only and the tags must stay ascending. A release that adds one cannot be rolled back automatically.

**Break glass.** If Actions is unavailable, run wrangler locally after `wrangler login`, from a clean checkout of a commit on `main`, with the same commands the workflow uses. Log out afterwards (`wrangler logout`) and record what you did in the next pull request.

## Guards

Both guards are pure functions in `scripts/ci/lib/` with unit tests next to them; `scripts/ci/*.ts` are thin command-line wrappers.

### Migration guard

`bun scripts/ci/check-migrations.ts --base <ref> [--head <ref>] [--allow-destructive]`

D1 migrations are applied before the new code deploys, so each new migration has to work for the release that is still running. The guard looks only at files changed by the pull request under `migrations/*.sql`:

- An existing migration that is modified, renamed or deleted always fails: applied migrations are immutable.
- A new migration containing `DROP TABLE|COLUMN|INDEX|VIEW|TRIGGER`, `RENAME TO|COLUMN`, `DELETE FROM` or `TRUNCATE` fails unless the pull request carries the `destructive-migration` label. Comments and string literals are ignored. drizzle's table-rebuild pattern (`DROP TABLE` then `RENAME TO`) is flagged on purpose.

The historical migrations, including both `0006_*` files, contain such statements and are never rescanned.

The guard catches the common ways a migration breaks the release still serving traffic; it cannot prove a migration is compatible. Review the additive ones too: a new `NOT NULL` column needs a default (SQLite refuses one without, so that fails loudly), and a new unique index must not reject inserts the running release makes.

### Wrangler config guard

`bun scripts/ci/verify-wrangler-config.ts <config>... [--expect <file>] [--enforce]`

CI checks both `wrangler.jsonc` and the generated `dist/<worker>/wrangler.json`, which is what `wrangler deploy` uploads. Rules:

| Rule | Fails when |
| --- | --- |
| `worker-name` | `name` differs from `workerName` in `.github/deploy.config.json` |
| `foreign-host` | A route or var references a host under `forbiddenHostSuffixes` (upstream `cloudflare.dev`) |
| `custom-domain` | `vars.CUSTOM_DOMAIN` is not a lowercase fully qualified domain name |
| `zone-id` | A route zone is not in `zoneIds` (when declared) |
| `resource-id` | D1, KV, R2, dispatch namespace or Artifacts values differ from `resources` (when declared) |
| `resource-consistency` | `DISPATCH_NAMESPACE` or `ARTIFACTS_NAMESPACE` differs from its binding |
| `container-image` | A container `image` is not a `registry.cloudflare.com/` reference, so a deploy would build an image |
| `container-instances` | `max_instances` exceeds `MAX_SANDBOX_INSTANCES`, or that var is not a positive integer |
| `migration-tags` | Durable Object migration tags are not strictly ascending `v<number>` values |

Values omitted from `.github/deploy.config.json` are not compared. `"artifactsNamespace": null` asserts that no Artifacts binding exists.

## Supply chain

- Third-party actions are pinned to commit SHAs, and the repository setting `sha_pinning_required` enforces it. Dependabot proposes updates weekly for `github-actions`, and for `bun` in `/` and `/sdk`, with a seven-day cooldown on new releases. Bun support in Dependabot covers version updates only, so `bun audit` is the vulnerability signal.
- `gitleaks` is downloaded in the `security` job at a pinned version and verified against a pinned SHA-256; Dependabot cannot update it, so change `GITLEAKS_VERSION` and `GITLEAKS_SHA256` together. `.gitleaks.toml` allowlists two documented false positives (a truncated sample JWT in `sdk/README.md` and a fixed test token) by path and value.
- `actionlint` and `zizmor` run from pinned PyPI versions. `.github/zizmor.yml` disables the `self-repository` audit because actionlint cannot yet parse GitHub's `$/` syntax.
- Workflows use `pull_request`, never `pull_request_target`, and checkouts do not persist credentials. Environment secrets are only exposed to jobs that name the `production` environment, which the repository settings limit to `main`.

## Repository settings

`scripts/ops/configure-github.sh` holds the intended settings as code. Without arguments it only reads and reports drift; `--apply` writes. It never reads or writes secret values, and reports which environment secret and variable names are missing. Drift means any difference in what the script manages, in either direction: a ruleset that is looser than intended (another merge method, required check or bypass actor) is reported, while fields GitHub adds on its own are ignored. Applying the environment keeps the reviewers and wait timer already set on it.

| Setting | Value |
| --- | --- |
| Merge methods | Squash only; commit title is the pull request title; delete branch on merge; auto-merge allowed |
| Actions | `sha_pinning_required: true`; default workflow permissions stay read-only (verified, not set) |
| Ruleset `main` | Pull request required with zero approvals, squash only; `gate` required and the branch must be up to date; linear history; no force-push or deletion; repository admins bypass through a pull request only |
| Environment `production` | Deployments limited to the `main` branch |

After applying, confirm the ruleset by hand: the script reads back `enforcement: active`, but the settings page is the authority on whether it is enforced for a private repository. A direct `git push` to `main` must be rejected, and a pull request without a passing `gate` must not be mergeable. The required check name is `gate`; `gh pr checks <number>` lists it.

## Changing CI

- A new check is a new step in an existing job, or a new job added to `needs` of `gate`. A job that is not in `gate` does not block anything.
- Keep `permissions: contents: read` and pass any user-controlled value (titles, branch names, labels, inputs) through `env:`.
- Run `uvx --from actionlint-py==1.7.12.25 actionlint` and `uvx zizmor==1.31.1 --offline .github` before pushing workflow changes.
