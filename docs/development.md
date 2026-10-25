# Local development

How to prepare a machine, run the same checks as CI, and commit to this repository. For Cloudflare resources and production configuration see [setup.md](setup.md).

## Toolchain

| Tool | Version | Source of truth |
| --- | --- | --- |
| Node.js | 22 | `.nvmrc` |
| Bun | 1.3.14 | `.bun-version` |

```bash
nvm install && nvm use
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
```

Run all repository scripts with Bun from the repository root. The git hooks look for Bun in `~/.bun/bin` and `/opt/homebrew/bin`; when Bun is not found they print a warning and skip their checks rather than failing, so confirm `bun --version` before your first commit.

## Install

```bash
nvm use
bun install --frozen-lockfile
```

`bun install` also builds the `space` workspace package (`postinstall`) and activates the git hooks (`prepare`). Use `--frozen-lockfile` so a stale `bun.lock` fails loudly instead of being rewritten.

## Local variables

```bash
cp .dev.vars.example .dev.vars
perl -pi -e "s|^JWT_SECRET=.*|JWT_SECRET=\"$(openssl rand -base64 48)\"|" .dev.vars
```

`.dev.vars` is gitignored; never commit it and never copy production secrets into it. Wrangler loads it for local development only, and its values override the matching `vars` in `wrangler.jsonc`. The template lists the settings the Worker reads from `.dev.vars`; bindings and the `vars` already in `wrangler.jsonc` are not repeated there.

## Verify

```bash
bun run verify
```

`verify` runs, in order: root typecheck, ESLint, the `space` typecheck, and the Vitest suite. Root `typecheck` and `lint` do not cover `space` or `sdk`, and ESLint ignores tests.

| Command | Covers |
| --- | --- |
| `bun run verify` | Root typecheck, lint, `space` typecheck, tests |
| `bun run build` | `space` plus the Vite and Worker bundle (does not typecheck) |
| `bun run knip` | Unused files, exports and dependencies (currently reports findings) |
| `bun run --cwd sdk package` | SDK typecheck, tests, build and bundled types (run `bun install --frozen-lockfile` in `sdk/` once first) |

Tests run in workerd through `@cloudflare/vitest-pool-workers`, configured with a single shared runtime (`singleWorker` in `vitest.config.ts`). One runtime per test file loads every module over fresh loopback connections, which exhausts the macOS ephemeral port range and fails the run with `EADDRNOTAVAIL`. If a crashed run leaves orphaned `workerd` processes behind, stop them with `pkill -f vitest-pool-workers` and wait about 30 seconds for the sockets to drain before re-running.

## Git hooks

| Hook | Behavior |
| --- | --- |
| `pre-commit` | Typechecks when TypeScript is staged, then runs Vitest for the staged files (`vitest related`). `RUN_ALL_TESTS=1` runs the full suite; `SKIP_TESTS=1` skips the hook. |
| `commit-msg` | Validates the message with commitlint (Conventional Commits; `commitlint.config.js`). |

## Bootstrap scripts

`bun run setup` and `bun run deploy` are one-time bootstrap scripts for a fresh clone of the upstream template, not part of the everyday workflow. They create Cloudflare resources and rewrite tracked files: `setup` edits `wrangler.jsonc`, `vite.config.ts`, `worker-configuration.d.ts` and `SandboxDockerfile`; `deploy` edits `package.json`, `wrangler.jsonc` and `SandboxDockerfile`, and uploads secrets. Do not run them in this checkout. Configure local development with `.dev.vars.example` as above.
