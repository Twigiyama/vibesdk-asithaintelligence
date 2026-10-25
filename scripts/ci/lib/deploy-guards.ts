/** Decisions the deploy workflow makes about the commit and the release. */

export interface CheckRunLike {
	name: string;
	app?: { slug?: string | null } | null;
}

/**
 * Check runs created by apps that must not be building this commit. While
 * Cloudflare Workers Builds is attached it posts one for every push, and its
 * build would run the template's deploy script against production.
 */
export function findBlockingCheckRuns<T extends CheckRunLike>(
	checkRuns: readonly T[],
	blockedAppSlugs: readonly string[],
): T[] {
	return checkRuns.filter(
		(run) => run.app?.slug != null && blockedAppSlugs.includes(run.app.slug),
	);
}

export interface RollbackInput {
	smokeFailed: boolean;
	d1MigrationsApplied: number;
	durableObjectMigrationApplied: boolean;
	previousVersionId: string | undefined;
}

export type RollbackDecision =
	| { action: 'none' }
	| { action: 'rollback'; versionId: string }
	| { action: 'manual'; reasons: string[] };

/**
 * A failed smoke check rolls back automatically only when the release left the
 * data model alone. D1 is forward-only and Cloudflare blocks a rollback across a
 * Durable Object class change, so those releases need a person and the runbook.
 */
export function decideRollback({
	smokeFailed,
	d1MigrationsApplied,
	durableObjectMigrationApplied,
	previousVersionId,
}: RollbackInput): RollbackDecision {
	if (!smokeFailed) return { action: 'none' };

	const reasons: string[] = [];
	if (d1MigrationsApplied > 0) {
		reasons.push(
			`${d1MigrationsApplied} D1 migration(s) were applied before this deploy; the previous version has not been verified against the new schema.`,
		);
	}
	if (durableObjectMigrationApplied) {
		reasons.push(
			'A Durable Object migration was applied; Cloudflare blocks rolling back across a Durable Object class change.',
		);
	}
	if (previousVersionId === undefined) {
		reasons.push('No previous version was recorded, so there is nothing to roll back to.');
	}

	if (reasons.length > 0 || previousVersionId === undefined) {
		return { action: 'manual', reasons };
	}
	return { action: 'rollback', versionId: previousVersionId };
}
