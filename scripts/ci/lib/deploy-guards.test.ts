import { describe, expect, it } from 'vitest';
import { decideRollback, findBlockingCheckRuns } from './deploy-guards';

describe('findBlockingCheckRuns', () => {
	const runs = [
		{ name: 'gate', app: { slug: 'github-actions' } },
		{ name: 'Workers Builds: vibesdk-production', app: { slug: 'cloudflare-workers-and-pages' } },
		{ name: 'Unattributed', app: null },
		{ name: 'No app key' },
	];

	it('returns the check runs created by a blocked app', () => {
		expect(findBlockingCheckRuns(runs, ['cloudflare-workers-and-pages'])).toEqual([
			runs[1],
		]);
	});

	it('ignores runs from other apps and runs without an app', () => {
		expect(findBlockingCheckRuns(runs, ['mintlify'])).toEqual([]);
	});

	it('returns nothing when no app is blocked', () => {
		expect(findBlockingCheckRuns(runs, [])).toEqual([]);
	});
});

describe('decideRollback', () => {
	const failed = {
		smokeFailed: true,
		deployFailed: false,
		d1MigrationsApplied: 0,
		durableObjectMigrationApplied: false,
		previousVersionId: 'prev-version',
	};

	it('does nothing when the smoke checks passed', () => {
		expect(decideRollback({ ...failed, smokeFailed: false })).toEqual({ action: 'none' });
	});

	it('does nothing when the deploy step failed but the smoke checks passed', () => {
		expect(decideRollback({ ...failed, smokeFailed: false, deployFailed: true })).toEqual({
			action: 'none',
		});
	});

	it('leaves recovery to a person when the deploy step failed and the smoke checks fail', () => {
		const decision = decideRollback({ ...failed, deployFailed: true });

		expect(decision).toEqual({
			action: 'manual',
			reasons: [expect.stringContaining('deploy step failed')],
		});
	});

	it('lists a failed deploy next to the other reasons', () => {
		const decision = decideRollback({ ...failed, deployFailed: true, d1MigrationsApplied: 1 });

		expect(decision.action === 'manual' && decision.reasons).toHaveLength(2);
	});

	it('rolls back to the previous version when the release changed no schema', () => {
		expect(decideRollback(failed)).toEqual({
			action: 'rollback',
			versionId: 'prev-version',
		});
	});

	it('leaves recovery to a person after a D1 migration was applied', () => {
		const decision = decideRollback({ ...failed, d1MigrationsApplied: 2 });

		expect(decision).toEqual({
			action: 'manual',
			reasons: [expect.stringContaining('D1')],
		});
	});

	it('leaves recovery to a person after a Durable Object migration', () => {
		const decision = decideRollback({ ...failed, durableObjectMigrationApplied: true });

		expect(decision).toEqual({
			action: 'manual',
			reasons: [expect.stringContaining('Durable Object')],
		});
	});

	it('leaves recovery to a person when there is no previous version', () => {
		const decision = decideRollback({ ...failed, previousVersionId: undefined });

		expect(decision).toEqual({
			action: 'manual',
			reasons: [expect.stringContaining('previous version')],
		});
	});

	it('lists every reason that blocks the automatic rollback', () => {
		const decision = decideRollback({
			smokeFailed: true,
			deployFailed: true,
			d1MigrationsApplied: 1,
			durableObjectMigrationApplied: true,
			previousVersionId: undefined,
		});

		expect(decision.action).toBe('manual');
		expect(decision.action === 'manual' && decision.reasons).toHaveLength(4);
	});
});
