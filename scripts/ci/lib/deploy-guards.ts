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
	/** The deploy step failed. Wrangler can fail after the new version is already live. */
	deployFailed: boolean;
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
 * A failed deploy step also needs a person: it is not known which version serves.
 */
export function decideRollback({
	smokeFailed,
	deployFailed,
	d1MigrationsApplied,
	durableObjectMigrationApplied,
	previousVersionId,
}: RollbackInput): RollbackDecision {
	if (!smokeFailed) return { action: 'none' };

	const reasons: string[] = [];
	if (deployFailed) {
		reasons.push(
			'The deploy step failed, so it is not known which version is serving; check the Deployments page before rolling back.',
		);
	}
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
		return { action: 'manual', reasons };
	}

	return reasons.length > 0
		? { action: 'manual', reasons }
		: { action: 'rollback', versionId: previousVersionId };
}
