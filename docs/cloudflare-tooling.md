# Cloudflare tooling

Which tool to use for what, how each authenticates, and the rules for letting an agent near the account. The pipeline itself is in [ci-cd.md](ci-cd.md).

## wrangler and cf

| Tool | Use it for | Where |
| --- | --- | --- |
| `wrangler`, pinned in `package.json` | Everything the repository scripts and workflows do: build, deploy, D1 migrations, Time Travel, secrets | CI and local. Run it as `bunx wrangler ...` so the pinned version is used. |
| `cf` (npm package `cf`, a beta at `1.0.0-beta.21`) | Ad-hoc inspection and agent use | Local only, never in CI |

`cf` is a beta and its commands can change between releases, which is why the pipeline does not depend on it. It needs Node `^22.23.0`, `^24.22.0` or `^26.12.0`; the repository's `.nvmrc` satisfies that.

```bash
npm install --global cf
```

## Signing in

Local use authenticates with OAuth:

```bash
bunx wrangler login     # opens a browser
bunx wrangler whoami
bunx wrangler logout    # when you are done
```

The session is stored in your user configuration directory (on macOS, `~/Library/Preferences/.wrangler/config`), not in the repository.

- Prefer a session or token with the least access the task needs. For looking around, read-only is enough.
- `scripts/ci/preflight.ts` and `scripts/ci/sync-secrets.ts` do not use the wrangler session; they read `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment.
- The CI deploy token lives only in the GitHub environment `production`. Do not copy it to a laptop and never hand it to an agent. Use a separate token for local work.

## Claude Code skills and the Cloudflare MCP server

The repository's `.claude/settings.json` registers the official marketplace and enables its plugin:

```json
{
  "extraKnownMarketplaces": {
    "cloudflare": { "source": { "source": "github", "repo": "cloudflare/skills" } }
  },
  "enabledPlugins": { "cloudflare@cloudflare": true }
}
```

Claude Code asks you to trust the marketplace the first time. The plugin bundles Cloudflare platform guidance and the Cloudflare MCP server. Check it loaded:

```bash
claude mcp list
```

then run `/reload-plugins` (or restart) so the tools appear. You authorize the MCP server yourself the first time it is used.

### Safety rules

- The MCP server's `execute` tool can change the account, and it has no read-only mode. The only protection is what the credential you give it is allowed to do. Authorize it with the minimum OAuth scopes, or a read-only API token, and revoke the authorization when you are done.
- Do not store an agent's credential in GitHub, and do not give an agent the CI deploy token or `WORKER_SECRETS`.
- Treat production writes as yours to approve: deploys, rollbacks, secret syncs and settings changes run through the workflows, where they are logged and gated by the `production` environment.
