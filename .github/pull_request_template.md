## Summary

<!-- What changes and why. The PR title becomes the squash commit, so keep it a Conventional Commit. -->

## Migration safety

- [ ] No D1 migration in this PR, or every new migration is additive and the release that is currently deployed keeps working against the new schema (migrations run before the code deploys).
- [ ] Destructive statements (`DROP`, `RENAME`, `DELETE FROM`) carry the `destructive-migration` label, with the restore plan below.
- [ ] No applied migration was edited, renamed or deleted.
- [ ] New columns are nullable or have a default, and new unique indexes cannot reject inserts that the running release makes. The migration guard only catches destructive statements.

## Durable Objects and bindings

- [ ] `migrations` in `wrangler.jsonc` is unchanged, or the new tag is appended (never edited) and I understand rollback past it is blocked.
- [ ] No binding, route or resource id changed, or `.github/deploy.config.json` and `docs/ci-cd.md` are updated to match.

## Secrets and configuration

- [ ] No new secret is required, or it is added to `WORKER_SECRETS` and synced before this merges.
- [ ] Non-secret configuration is a `vars` entry in `wrangler.jsonc`, not a secret.

## Testing

<!-- Commands you ran and what you checked by hand. -->
