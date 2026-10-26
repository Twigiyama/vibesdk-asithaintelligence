# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

AGENTS.md (imported above) is the source of truth for commands, verification quirks, frontend conventions, change paths, and constraints. This file adds architecture context and project rules; do not restate AGENTS.md here.

## Communication Style
- Be professional, concise, and direct
- Do NOT use emojis in code reviews, changelogs, or any generated content. You may use professional visual indicators or favor markdown formatting over emojis.
- Focus on substance over style
- Use clear technical language

## Project Overview

VibeSDK is an agentic full-stack application builder on Cloudflare.

**Tech Stack:**
- Frontend: React 19, TypeScript, Vite, TailwindCSS v4, React Router v7
- Backend: Cloudflare Workers, Durable Objects, Hono, D1 (Drizzle), R2, and KV
- Agent: Cloudflare Think with AI Gateway model routing
- Workspace: SpaceDO Durable Object (`space/` workspace package)
- Version history: Cloudflare Artifacts (opt-in via `ENABLE_ARTIFACTS`)
- Preview runtime: Worker Loader bindings and Dynamic Workers
- Generated app data: Durable Object Facets with isolated SQLite
- WebSocket: PartySocket for real-time communication
- Tooling: Bun, Node >= 22

**Non-obvious directories:** `container/` (sandbox container tooling for the legacy path), `packages/artifacts-viewer/` (vendored git subtree), `sdk/` (independent Bun package), `debug-tools/` (Python and TypeScript analysis scripts).

## Architecture

An app session spans three Durable Objects. The browser opens a WebSocket (`/api/agent/:agentId/ws`, owner-only) to `CodeGeneratorAgent`, which drives `ThinkAgent` over DO RPC; `ThinkAgent` edits files and deploys through `SpaceDO` over DO RPC.

| Component | Binding | Code |
|---|---|---|
| `CodeGeneratorAgent`: session host, WebSocket endpoint, behavior selection | `CodeGenObject` | `worker/agents/core/codingAgent.ts` |
| `ThinkCodingBehavior`: host orchestration, runs inside `CodeGeneratorAgent` | n/a | `worker/agents/core/behaviors/think.ts` |
| `ThinkAgent`: model-and-tool loop, extends `@cloudflare/think` | `THINK_DO` | `worker/agents/think/ThinkAgent.ts` |
| `SpaceDO`: workspace, files, preview and deploy | `SPACE_DO` | `space/src/space/durable-object.ts` |

**Behavior selection.** `CodeGeneratorAgent.onStart` resolves the behavior from explicit props, then persisted `state.behaviorType`, then the feature registry in `worker/agents/core/features/types.ts`: project type `app` maps to `think`; `presentation`, `workflow`, and `general` map to `agentic`. `phasic` is reachable only for sessions persisted with it and their clones (`cloneAgent` in `worker/agents/index.ts` carries `behaviorType` over).

**Think path.** `ThinkCodingBehavior` pushes model and prompt config to `ThinkAgent` with `configureVibe`, calls `chat()` with an `RpcTarget` forwarder, and translates the streamed AI SDK `UIMessageChunk` frames into VibeSDK WebSocket events. `ThinkAgent` uses explicit tools only (workspace bash is disabled) and reaches files through `space-workspace-ops.ts`. Prompts and skills live in `worker/agents/think/prompts/` and `worker/agents/think/skills/`. New Think tools need focused tests.

**Legacy path.** `agentic` and `phasic` use the tools in `worker/agents/tools/` (`customTools.ts`, `toolkit/`), the `operations/`, `planning/`, and `assistants/` code under `worker/agents/`, and previews through the sandbox service (`worker/services/sandbox/`, `UserAppSandboxService` container). The Think path bypasses all of it; confirm which path a change affects.

**Workspace and versioning.**
- `commit` saves without deploying; `deploy_space` commits and rebuilds the preview. Rollback applies a selected tree, creates a new commit, and redeploys.
- Each SpaceDO resolves its storage backend once and pins it (`resolveSpaceFsBackendMode` in `space/src/space/fs-backend.ts`). A new space uses Cloudflare Artifacts for git history when `ENABLE_ARTIFACTS="true"` and the `ARTIFACTS` binding exists, otherwise `SqlBackend` keeps local git history in SQLite. A space that already has Artifacts state stays on Artifacts, and `ArtifactsBackend` throws if the binding is later removed, so changing the flag does not migrate existing spaces.
- Describe SpaceDO as the workspace and file layer, not as git-backed (`docs/llm.md`). Artifacts synchronization lives in `space/src/space/artifacts-sync.ts`.

**Preview runtime.** `@cloudflare/worker-bundler` builds committed files, the `LOADER` Worker Loader binding loads them as a Dynamic Worker, and generated `App` classes run as Durable Object Facets with isolated SQLite.

## Model Configuration
- Think: the model is `THINK_MODEL_ID` / `THINK_MODEL_CONFIG` in `worker/agents/think/model-config.ts`. `ThinkCodingBehavior` converts it to AI Gateway coordinates with `getConfigurationForModel`.
- Legacy actions: `AGENT_CONFIG` in `worker/agents/inferutils/config.ts` (`PLATFORM_AGENT_CONFIG` when `PLATFORM_MODEL_PROVIDERS` is set, otherwise `DEFAULT_AGENT_CONFIG`). Per-user overrides go through `ModelConfigService`.

## User Secrets Vault
- `UserSecretsStore` (`worker/services/secrets/`) is a per-user Durable Object with a session-bound vault. The vault master key is derived client-side (Argon2id or WebAuthn PRF; `src/lib/vault-crypto.ts`), never stored, and unlocked per WebSocket session. The server persists encrypted blobs only; the header comment in `UserSecretsStore.ts` documents the key model.
- Server code reads secrets through `SecretsClient`: a locked vault triggers a `vault_required` broadcast and a wait of up to 120 s for the browser to unlock. Missing or undecryptable secrets resolve `null`; an unlock timeout or cancellation throws.
- Tests: `worker/services/secrets/UserSecretsStore.test.ts`.

## Cross-Cutting Patterns

**Abort controller** (`BaseCodingBehavior` in `worker/agents/core/behaviors/base.ts`; legacy inference path, `think.ts` has no abort handling):
- `getOrCreateAbortController()` reuses the controller for nested operations
- Cleared after top-level operations complete
- Shared by parent and nested tool calls; `cancelCurrentInference()` aborts the whole tree

**Message deduplication:**
- Tool execution causes duplicate assistant messages
- Legacy path: `UserConversationProcessor` skips a final response that duplicates the last assistant message, and its system prompt teaches the LLM not to repeat
- Frontend: `src/routes/chat/utils/deduplicate-messages.ts` deduplicates live and restored messages

## Testing Notes
- Tests run in workerd via `@cloudflare/vitest-pool-workers`. `test/worker-entry.ts` exports only `UserSecretsStore` and an empty `FsHarnessDO` (a real `SqlStorage` for filesystem contract tests), and `wrangler.test.jsonc` binds no D1, KV, or other resources: mock them, and avoid importing modules that load the MCP SDK.
- Tests are colocated with source (`*.test.ts` beside the module); `space/test` and `sdk/test` hold their packages' tests.

## Tooling and Build Gotchas
- Commits are checked by commitlint (Conventional Commits: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`; no trailing period in the subject).
- `bun run knip` reports unused files, exports, and dependencies (rules are `error`).
- `bun run cli` and `bun run tui` point at a gitignored `cli/` directory that is not in this checkout.
- `package.json` requires Node >= 22 (the README says 18+).
- `.editorconfig` and Prettier specify tabs and single quotes, but several older worker files use 4 spaces; match the file being edited.
- The root app imports `@space-do/space` from `space/dist`, so run `bun run --cwd space build` after editing `space/src`.
- CommonJS `require()` inside code-split Worker chunks crashes startup (deploy error 10021). `vite.config.ts` aliases `mimetext` and `safe-buffer` for this; use the same approach for similar packages.
- `packages/artifacts-viewer` is aliased in both `vite.config.ts` (Vite) and `wrangler.jsonc` `alias` (esbuild during `wrangler deploy`); change both when remapping its entrypoints.
- `wrangler.jsonc` sets `keep_vars: true`: feature toggles are set in the Cloudflare dashboard or `.dev.vars`, not committed there. Markdown imports (Think skills) rely on the `?raw` Text rule in `wrangler.jsonc`.

## Docs
- `docs/llm.md`: only the sections above "Legacy reference" are current; the remainder documents the retired phase-based sandbox architecture.
- `docs/setup.md`: full setup, custom domain, AI Gateway, dashboard-managed feature toggles, and troubleshooting.

## Core Rules (Non-Negotiable)

**1. Strict Type Safety**
- NEVER use `any` type
- Frontend imports types from `@/api-types` (single source of truth)
- Search codebase for existing types before creating new ones

**2. DRY Principle**
- Search for similar functionality before implementing
- Extract reusable utilities, hooks, and components
- Never copy-paste code - refactor into shared functions

**3. Follow Existing Patterns**
- Frontend APIs: All in `/src/lib/api-client.ts`
- Backend Routes: Controllers in `worker/api/controllers/`, routes in `worker/api/routes/`
- Database Services: In `worker/database/services/`
- Types: Shared in `shared/types/`, API in `src/api-types.ts`

**4. Code Quality**
- Production-ready code only - no TODOs or placeholders
- No hacky workarounds
- Comments explain purpose, not narration
- No overly verbose AI-like comments

**5. File Naming**
- React Components: PascalCase.tsx
- Utilities/Hooks: kebab-case.ts
- Backend Services: PascalCase.ts

## Common Pitfalls

**Don't:**
- Use `any` type (find or create proper types)
- Copy-paste code (extract to utilities)
- Use Vite env variables in Worker code
- Forget to update types when changing APIs
- Create new implementations without searching for existing ones
- Use emojis in code or comments
- Write verbose AI-like comments

**Do:**
- Search codebase thoroughly before creating new code
- Follow existing patterns consistently
- Keep comments concise and purposeful
- Write production-ready code
- Test thoroughly before submitting
