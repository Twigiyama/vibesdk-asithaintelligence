# CI/CD

How changes are checked before they reach `main`. The release flow is: short-lived feature branch, pull request, squash-merge to `main`. Local setup is in [development.md](development.md).

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

- Third-party actions are pinned to commit SHAs, and the repository setting `sha_pinning_required` enforces it. Dependabot proposes updates weekly for `github-actions`, and for `bun` in `/` and `/sdk`. Bun support in Dependabot covers version updates only, so `bun audit` is the vulnerability signal.
- `gitleaks` is downloaded in the `security` job at a pinned version and verified against a pinned SHA-256; Dependabot cannot update it, so change `GITLEAKS_VERSION` and `GITLEAKS_SHA256` together. `.gitleaks.toml` allowlists two documented false positives (a truncated sample JWT in `sdk/README.md` and a fixed test token) by path and value.
- `actionlint` and `zizmor` run from pinned PyPI versions. `.github/zizmor.yml` disables the `self-repository` audit because actionlint cannot yet parse GitHub's `$/` syntax.
- Workflows use `pull_request`, never `pull_request_target`, and checkouts do not persist credentials.

## Repository settings

`scripts/ops/configure-github.sh` holds the intended settings as code. Without arguments it only reads and reports drift; `--apply` writes. It never reads or writes secret values. Drift means any difference in what the script manages, in either direction: a ruleset that is looser than intended (another merge method, required check or bypass actor) is reported, while fields GitHub adds on its own are ignored. Applying the environment keeps the reviewers and wait timer already set on it.

| Setting | Value |
| --- | --- |
| Merge methods | Squash only; commit title is the pull request title; delete branch on merge; auto-merge allowed |
| Actions | `sha_pinning_required: true`; default workflow permissions stay read-only (verified, not set) |
| Ruleset `main` | Pull request required with zero approvals, squash only; `gate` required and the branch must be up to date; linear history; no force-push or deletion; repository admins bypass through a pull request only |
| Environment `production` | Deployments limited to the `main` branch |

After applying, confirm the ruleset by hand: the script reads back `enforcement: active`, but the settings page is the authority on whether it is enforced for a private repository. A direct `git push` to `main` must be rejected, and a pull request without a passing `gate` must not be mergeable. Confirm the check name too: `gh pr checks <number>` should list `gate`.

## Changing CI

- A new check is a new step in an existing job, or a new job added to `needs` of `gate`. A job that is not in `gate` does not block anything.
- Keep `permissions: contents: read` and pass any user-controlled value (titles, branch names, labels) through `env:`.
- Run `uvx --from actionlint-py==1.7.12.25 actionlint` and `uvx zizmor==1.31.1 --offline .github` before pushing workflow changes.
