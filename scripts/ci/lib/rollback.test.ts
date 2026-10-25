import { describe, expect, it } from 'vitest';
import type { LiveDeployment } from './preflight';
import { defaultRollbackVersion } from './rollback';

const deployment = (createdOn: string, versions: LiveDeployment['versions']): LiveDeployment => ({
	id: createdOn,
	createdOn,
	versions,
});

const stable = (id: string) => [{ versionId: id, percentage: 100 }];

describe('defaultRollbackVersion', () => {
	it('returns the version that served before the current deployment', () => {
		const deployments = [
			deployment('2026-10-25T12:00:00Z', stable('current')),
			deployment('2026-10-25T11:00:00Z', stable('previous')),
			deployment('2026-10-25T10:00:00Z', stable('older')),
		];

		expect(defaultRollbackVersion(deployments)).toBe('previous');
	});

	it('does not rely on the order the API returned', () => {
		const deployments = [
			deployment('2026-10-25T10:00:00Z', stable('older')),
			deployment('2026-10-25T12:00:00Z', stable('current')),
			deployment('2026-10-25T11:00:00Z', stable('previous')),
		];

		expect(defaultRollbackVersion(deployments)).toBe('previous');
	});

	it('skips a gradual deployment, which has no single stable version', () => {
		const deployments = [
			deployment('2026-10-25T12:00:00Z', stable('current')),
			deployment('2026-10-25T11:00:00Z', [
				{ versionId: 'a', percentage: 50 },
				{ versionId: 'b', percentage: 50 },
			]),
			deployment('2026-10-25T10:00:00Z', stable('older')),
		];

		expect(defaultRollbackVersion(deployments)).toBe('older');
	});

	it('has nothing to return to after the first deployment', () => {
		expect(defaultRollbackVersion([deployment('2026-10-25T12:00:00Z', stable('only'))])).toBeUndefined();
		expect(defaultRollbackVersion([])).toBeUndefined();
	});
});
