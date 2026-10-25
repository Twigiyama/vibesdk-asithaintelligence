#!/usr/bin/env bash
# Repository settings, the `main` ruleset and the `production` environment.
#
#   scripts/ops/configure-github.sh           report drift from the desired settings (read-only)
#   scripts/ops/configure-github.sh --apply   write the desired settings, then report again
#
# Needs gh authenticated with admin access to the repository, and jq. Secret
# and variable values are never read or written: the script only reports which
# names exist on the production environment.
set -euo pipefail

command -v gh >/dev/null || { echo "gh is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

apply=false
case "${1:-}" in
	"") ;;
	--apply) apply=true ;;
	*) echo "usage: ${0##*/} [--apply]" >&2; exit 2 ;;
esac

REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
RULESET_NAME="main"
ENVIRONMENT="production"
REQUIRED_CHECK="gate"
DEPLOY_BRANCH="main"
MIGRATION_LABEL="destructive-migration"

drift=0

ok() { printf 'ok       %s\n' "$1"; }
report_drift() { printf 'DRIFT    %s\n' "$1"; drift=1; }
missing() { printf 'MISSING  %s\n' "$1"; drift=1; }

# Prints one line per key of $2 whose value in $1 differs.
subset_diff() {
	jq -rn --argjson actual "$1" --argjson desired "$2" '
		$desired | to_entries[]
		| select($actual[.key] != .value)
		| "\(.key) is \($actual[.key] | tojson), want \(.value | tojson)"'
}

desired_repository='{
	"allow_squash_merge": true,
	"allow_merge_commit": false,
	"allow_rebase_merge": false,
	"squash_merge_commit_title": "PR_TITLE",
	"squash_merge_commit_message": "BLANK",
	"delete_branch_on_merge": true,
	"allow_auto_merge": true
}'

desired_actions='{
	"enabled": true,
	"allowed_actions": "all",
	"sha_pinning_required": true
}'

# Actor 5 is the repository admin role; it may bypass only through a pull
# request, so direct pushes to main stay blocked for everyone.
desired_ruleset="$(jq -n --arg name "$RULESET_NAME" --arg check "$REQUIRED_CHECK" '{
	name: $name,
	target: "branch",
	enforcement: "active",
	conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
	bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }],
	rules: [
		{ type: "deletion" },
		{ type: "non_fast_forward" },
		{ type: "required_linear_history" },
		{
			type: "pull_request",
			parameters: {
				required_approving_review_count: 0,
				dismiss_stale_reviews_on_push: false,
				require_code_owner_review: false,
				require_last_push_approval: false,
				required_review_thread_resolution: false,
				allowed_merge_methods: ["squash"]
			}
		},
		{
			type: "required_status_checks",
			parameters: {
				strict_required_status_checks_policy: true,
				do_not_enforce_on_create: false,
				required_status_checks: [{ context: $check }]
			}
		}
	]
}')"

desired_environment='{
	"deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}'

check_repository() {
	local actual diff
	actual="$(gh api "repos/$REPO")"
	diff="$(subset_diff "$actual" "$desired_repository")"
	if [ -z "$diff" ]; then ok "repository merge settings"; else
		while IFS= read -r line; do report_drift "repository: $line"; done <<<"$diff"
	fi
}

check_actions() {
	local actual diff workflow
	actual="$(gh api "repos/$REPO/actions/permissions")"
	diff="$(subset_diff "$actual" "$desired_actions")"
	if [ -z "$diff" ]; then ok "actions permissions (SHA pinning required)"; else
		while IFS= read -r line; do report_drift "actions: $line"; done <<<"$diff"
	fi

	# Verified, never written: a wider default would let every workflow write.
	workflow="$(gh api "repos/$REPO/actions/permissions/workflow" --jq .default_workflow_permissions)"
	if [ "$workflow" = "read" ]; then ok "default workflow permissions are read-only"; else
		report_drift "default workflow permissions are '$workflow'; set them to read in the repository settings"
	fi
}

ruleset_id() {
	gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$RULESET_NAME\") | .id" | head -n 1
}

check_ruleset() {
	local id actual
	id="$(ruleset_id)"
	if [ -z "$id" ]; then missing "ruleset '$RULESET_NAME'"; return; fi

	actual="$(gh api "repos/$REPO/rulesets/$id")"
	if jq -e --argjson desired "$desired_ruleset" '. | contains($desired)' <<<"$actual" >/dev/null; then
		ok "ruleset '$RULESET_NAME' matches (enforcement: $(jq -r .enforcement <<<"$actual"))"
	else
		report_drift "ruleset '$RULESET_NAME' differs from the desired rules; re-run with --apply"
	fi

	if [ "$(jq -r .enforcement <<<"$actual")" != "active" ]; then
		report_drift "ruleset '$RULESET_NAME' enforcement is not active"
	fi
}

check_environment() {
	local actual policies name
	if ! actual="$(gh api "repos/$REPO/environments/$ENVIRONMENT" 2>/dev/null)"; then
		missing "environment '$ENVIRONMENT'"
		return
	fi

	if jq -e --argjson desired "$desired_environment" '. | contains($desired)' <<<"$actual" >/dev/null; then
		ok "environment '$ENVIRONMENT' limits deployments to selected branches"
	else
		report_drift "environment '$ENVIRONMENT' does not restrict deployments to selected branches"
	fi

	policies="$(gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" --jq '.branch_policies[].name')"
	if grep -qx "$DEPLOY_BRANCH" <<<"$policies"; then ok "environment '$ENVIRONMENT' allows branch '$DEPLOY_BRANCH'"; else
		report_drift "environment '$ENVIRONMENT' does not allow branch '$DEPLOY_BRANCH'"
	fi

	local secrets variables
	secrets="$(gh api "repos/$REPO/environments/$ENVIRONMENT/secrets" --jq '.secrets[].name')"
	variables="$(gh api "repos/$REPO/environments/$ENVIRONMENT/variables" --jq '.variables[].name')"
	for name in CLOUDFLARE_API_TOKEN WORKER_SECRETS; do
		if grep -qx "$name" <<<"$secrets"; then ok "environment secret $name is set"; else
			missing "environment secret $name (gh secret set $name --env $ENVIRONMENT --repo $REPO)"
		fi
	done
	for name in CLOUDFLARE_ACCOUNT_ID WORKER_NAME; do
		if grep -qx "$name" <<<"$variables"; then ok "environment variable $name is set"; else
			missing "environment variable $name (gh variable set $name --env $ENVIRONMENT --repo $REPO)"
		fi
	done
}

check_label() {
	if gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name' | grep -qx "$MIGRATION_LABEL"; then
		ok "label '$MIGRATION_LABEL' exists"
	else
		missing "label '$MIGRATION_LABEL'"
	fi
}

apply_repository() {
	gh api --method PATCH "repos/$REPO" --input - <<<"$desired_repository" >/dev/null
	gh api --method PUT "repos/$REPO/actions/permissions" --input - <<<"$desired_actions" >/dev/null
	echo "applied  repository merge settings and actions permissions"
}

apply_ruleset() {
	local id
	id="$(ruleset_id)"
	if [ -z "$id" ]; then
		gh api --method POST "repos/$REPO/rulesets" --input - <<<"$desired_ruleset" >/dev/null
		echo "applied  created ruleset '$RULESET_NAME'"
	else
		gh api --method PUT "repos/$REPO/rulesets/$id" --input - <<<"$desired_ruleset" >/dev/null
		echo "applied  updated ruleset '$RULESET_NAME'"
	fi
}

apply_environment() {
	gh api --method PUT "repos/$REPO/environments/$ENVIRONMENT" --input - <<<"$desired_environment" >/dev/null
	if ! gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx "$DEPLOY_BRANCH"; then
		gh api --method POST "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
			-f name="$DEPLOY_BRANCH" -f type=branch >/dev/null
	fi
	echo "applied  environment '$ENVIRONMENT'"
}

apply_label() {
	gh label create "$MIGRATION_LABEL" --repo "$REPO" --color B60205 --force \
		--description "Allows destructive statements in a new D1 migration" >/dev/null
	echo "applied  label '$MIGRATION_LABEL'"
}

echo "Repository: $REPO"

if $apply; then
	apply_repository
	apply_ruleset
	apply_environment
	apply_label
	echo
fi

check_repository
check_actions
check_ruleset
check_environment
check_label

if [ "$drift" -ne 0 ]; then
	echo
	$apply && echo "Some settings still differ after applying; see above." || echo "Re-run with --apply to write the desired settings."
	exit 1
fi
