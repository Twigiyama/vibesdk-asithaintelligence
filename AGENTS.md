# AGENTS.md

## Tooling
- Use Bun from the repository root. The tracked lockfile is `bun.lock`, the `space` workspace dependency uses `workspace:*`, and install/build hooks invoke Bun even when started through npm. The toolchain is pinned: Node in `.nvmrc`, Bun in `.bun-version`.
- `bun run setup` and `bun run deploy` are one-time bootstrap scripts that rewrite tracked files and create Cloudflare resources; do not run them in a working checkout. Local development expects a `.dev.vars` copied from `.dev.vars.example`; never commit `.dev.vars*` (other than the example) or `.prod.vars`.
- `bun run dev` starts the React frontend and Worker together through `@cloudflare/vite-plugin` at `http://localhost:5173`. There is no separate Worker dev command. It runs offline; set `VIBESDK_REMOTE_BINDINGS=1` (after `wrangler login`) to connect the AI, Browser and dispatch bindings.
- `bun run dev:browser` is an optional local Chromium sidecar for the think agent's browser-console tool; absence only produces a warning.

## Verification
- Root checks: `bun run verify` (typecheck, lint, `space` typecheck, tests; what CI blocks on), `bun run build`, and `bun run cf-typegen:check`.
- `bun run build` builds `space` and the Vite/Worker bundle; it does not typecheck. Run `bun run typecheck` separately.
- Focus a root test with `bunx vitest run path/to/file.test.ts`; test execution uses the Workers pool and `wrangler.test.jsonc`, with one shared runtime (`singleWorker`). After a crashed run, `pkill -f vitest-pool-workers` before re-running.
- The root Vitest suite excludes all `sdk/test/**` and `container/monitor-cli.test.ts`. SDK tests use Bun: `bun run --cwd sdk test`.
- SDK integration tests require a running root dev server and `VIBESDK_INTEGRATION_API_KEY`; run `bun run --cwd sdk test:integration`. They can take 5-10 minutes; `VIBESDK_INTEGRATION_RUN_PREVIEW=1` enables the slower preview case.
- Root typecheck/lint do not validate `space` or `sdk`. For touched packages run `bun run --cwd space typecheck` / `bun run --cwd space build` and `bun run --cwd sdk package` as appropriate.
- ESLint checks only `src/**` and `worker/**` and deliberately ignores tests; do not treat `bun run lint` as repository-wide validation.
- Pre-commit typechecks staged TypeScript and runs related Vitest tests. `RUN_ALL_TESTS=1` selects its broader suite; `SKIP_TESTS=1` bypasses the hook.

## Frontend UI
- Tailwind CSS v4 via CSS-first setup in `src/index.css` (`@import 'tailwindcss'`, `@theme`, Kumo tokens); no `tailwind.config.*`.
- Prefer `@cloudflare/kumo` for new UI. List components with `bun kumo ls`; component docs via `bun kumo doc Button` (swap name as needed). Legacy shadcn/Radix under `src/components/ui/` still exists—do not add new primitives there when Kumo covers the case.
- Icons: `@phosphor-icons/react`. Dark mode is `data-mode="dark"` on the root (not a `class` strategy).
- Path aliases: `@/*` → `src/*`, `shared/*`, `worker/*` (see `tsconfig.app.json`).

## Frontend Data Fetching
- Use TanStack Query for frontend server state and network-call caching. `QueryClientProvider` is wired at the React root; configure shared defaults in `src/lib/query-client.ts`.
- Keep TanStack query keys centralized in `src/lib/query-keys.ts`. Use hierarchical keys so broad invalidation works, for example `queryKeys.apps.all` should invalidate app list/favorite variants.
- Frontend HTTP still goes through `src/lib/api-client.ts`; query functions should wrap existing `apiClient` methods rather than calling `fetch` directly from components.
- Include user/account identity in query keys when cached data is user-specific, or explicitly clear/remove those queries on logout/user switch. `enabled: !!user` prevents fetching but does not clear old cached data.
- Mutations that change cached server state must update cache with `queryClient.setQueryData` or invalidate the relevant `queryKeys` on success. Do not rely on a local `refetch()` in one component if sidebar or other shared UI consumes the same data.
- Prefer query hooks (`useQuery`, `useMutation`) over ad-hoc loading/error state in React contexts. Context remains appropriate for client-only UI state or providers required by libraries.

## Boundaries
- `src/` is the React app (`src/main.tsx`, routes in `src/routes.tsx`). API contracts live in `src/api-types.ts`; frontend HTTP calls belong in `src/lib/api-client.ts`.
- `worker/index.ts` is the Worker entrypoint and Durable Object export surface. Hono middleware/routes are wired by `worker/app.ts` and `worker/api/routes/index.ts`.
- `space/` is the only declared workspace package. It provides the `SpaceDO` workspace and file layer used by the think agent, with durable git history stored through Cloudflare Artifacts, and is bundled before the root app; edit implementation in `space/src`, never generated `space/dist`, and keep the hand-maintained `space/types/index.d.ts` aligned with public exports.
- `sdk/` is an independent Bun package with its own lockfile, scripts, and tests. It imports the platform WebSocket protocol from `worker/api/websocketTypes.ts`, so protocol changes must remain SDK-compatible.
- Shared frontend/backend types belong in `shared/`; Worker-only types stay under `worker/`.
- Architecture overview (ThinkAgent, SpaceDO, Artifacts, Dynamic Worker previews): `docs/llm.md`. CI, deploys, rollbacks and secrets: `docs/ci-cd.md`.

## Change Paths
- API endpoint: update `src/api-types.ts` -> `src/lib/api-client.ts` -> `worker/database/services/` (when persistence is needed) -> `worker/api/controllers/` -> `worker/api/routes/`, then register the route in `worker/api/routes/index.ts`.
- WebSocket message: update `worker/api/websocketTypes.ts`, backend handling in `worker/agents/core/websocket.ts`, and frontend handling in `src/routes/chat/utils/handle-websocket-message.ts`; verify SDK tests because its protocol re-exports these types.
- LLM tool: add it under `worker/agents/tools/toolkit/` and register it in `worker/agents/tools/customTools.ts` (`buildTools` or `buildDebugTools`). The think behavior has a separate tool path and bypasses `buildTools`.
- Think tool: create it under `worker/agents/think/`, add SpaceDO RPC typing if needed, register it in `ThinkAgent.getTools()`, and update the relevant prompt or skill.
- D1 schema source is `worker/database/schema.ts`; generate migrations into `migrations/` with `bun run db:generate`, then apply locally with `bun run db:migrate:local`.
- After changing Wrangler bindings or `vars`, run `bun run cf-typegen` and commit `worker-configuration.d.ts`; CI fails when it is stale. It reads secret names from `.dev.vars.example`, so declare a secret the code reads in `worker/types/env.d.ts` unless the template lists it.
- CI guard: put the logic in `scripts/ci/lib/` as a pure module with a test beside it, then a thin wrapper in `scripts/ci/`. They are typechecked by `tsconfig.ci.json` and tested by the root Vitest run.

## Constraints
- Do not introduce new `any` types even though ESLint currently permits existing ones; find or define a concrete type. Frontend API types should import from `@/api-types`.
- Worker code reads bindings from `env`; do not use Vite environment variables there.
- All `/api/*` routes are owner-only by default in `worker/app.ts`; public routes must explicitly follow the existing auth override pattern.
- User secrets RPC methods return `null`/`boolean` on failure rather than throwing; preserve that contract when editing `worker/services/secrets/`.
- For usage-limit UI behavior and its cross-component invariants, read `docs/usage-limits-ui.md` before editing the badge, credits banner, or limit popups.

## CI and deploy
- Every pull request must pass the `gate` check (`check`, `build`, `sdk`, `security` jobs; `docs/ci-cd.md`). The PR title becomes the squash commit, so it must be a Conventional Commit.
- D1 migrations are additive: never edit, rename or delete an applied migration, and a `DROP`, `RENAME` or `DELETE FROM` needs the `destructive-migration` label. Durable Object `migrations` in `wrangler.jsonc` are append-only.
- `wrangler.jsonc` must keep this deployment's resources, not the upstream template's. `.github/deploy.config.json` declares the expected identity; change both together.
- Production deploys run only through the manual `deploy.yml` workflow, rollbacks through `rollback.yml`, and runtime secrets through `sync-secrets.yml`. Do not run `scripts/deploy.ts`, `scripts/setup.ts` or `scripts/undeploy.ts` from CI.
- Cloudflare writes (deploy, rollback, secret sync, `scripts/ops/configure-github.sh --apply`) need the owner's explicit approval. Do not merge to `main` while Cloudflare Workers Builds is attached to the repository.
- Pass user-controlled workflow values (titles, branch names, inputs) through `env:`, never inline in `run:`, and lint workflow changes with actionlint and zizmor.
