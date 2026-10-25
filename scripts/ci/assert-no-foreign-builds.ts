#!/usr/bin/env bun
/**
 * Refuses to deploy a commit that another system is also building.
 *
 *   GITHUB_TOKEN=... bun scripts/ci/assert-no-foreign-builds.ts --repo owner/name --sha <commit>
 *
 * While Cloudflare Workers Builds is attached to the repository it posts a check
 * run for every push and runs the template's deploy script on its own. Deploying
 * from Actions on top of that would race it, so the deploy stops until it is
 * disconnected.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { findBlockingCheckRuns } from './lib/deploy-guards';
import { fail } from './support';

const BLOCKED_APPS = ['cloudflare-workers-and-pages'];

const checkRunsSchema = z.looseObject({
	check_runs: z.array(
		z.looseObject({
			name: z.string(),
			app: z.looseObject({ slug: z.string().nullish() }).nullish(),
		}),
	),
});

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: { repo: { type: 'string' }, sha: { type: 'string' } },
});

try {
	const token = process.env.GITHUB_TOKEN;
	if (!values.repo || !values.sha || !token) {
		throw new Error('usage: GITHUB_TOKEN=... assert-no-foreign-builds.ts --repo owner/name --sha <commit>');
	}

	const response = await fetch(
		`https://api.github.com/repos/${values.repo}/commits/${values.sha}/check-runs?per_page=100`,
		{
			headers: {
				authorization: `Bearer ${token}`,
				accept: 'application/vnd.github+json',
				'x-github-api-version': '2022-11-28',
			},
		},
	);
	if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status} for the check runs of ${values.sha}.`);

	const { check_runs: checkRuns } = checkRunsSchema.parse(await response.json());
	const blocking = findBlockingCheckRuns(checkRuns, BLOCKED_APPS);

	if (blocking.length > 0) {
		for (const run of blocking) console.error(`Found check run "${run.name}" from ${run.app?.slug}.`);
		throw new Error(
			'Cloudflare Workers Builds is still attached to this repository and is building this commit. Disconnect it (Worker, Settings, Builds) before deploying from GitHub Actions.',
		);
	}

	console.log(`No competing builds found on ${values.sha}.`);
} catch (error) {
	fail(error);
}
