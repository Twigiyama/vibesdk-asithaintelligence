import type { LiveDeployment } from './preflight';

/**
 * The version that served before the current deployment, which is where a
 * rollback without an explicit target goes. A gradual deployment has no single
 * stable version and is skipped, matching `wrangler rollback`.
 */
export function defaultRollbackVersion(
	deployments: readonly LiveDeployment[],
): string | undefined {
	const [, ...earlier] = [...deployments].sort((a, b) =>
		(b.createdOn ?? '').localeCompare(a.createdOn ?? ''),
	);

	for (const deployment of earlier) {
		const stable = deployment.versions.find((version) => version.percentage === 100);
		if (stable) return stable.versionId;
	}
	return undefined;
}
