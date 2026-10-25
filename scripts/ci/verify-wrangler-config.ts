#!/usr/bin/env bun
/**
 * Checks wrangler configuration files against .github/deploy.config.json.
 *
 *   bun scripts/ci/verify-wrangler-config.ts <config> [<config>...] [--expect <deploy.config.json>] [--enforce]
 *
 * Pass both wrangler.jsonc and the generated dist/<worker>/wrangler.json: the
 * generated file is what `wrangler deploy` uploads.
 *
 * Findings fail the run only when --enforce is given or deploy.config.json sets
 * "enforce": true; otherwise they are reported as warnings. The number of
 * findings is written to the `findings` step output when running in Actions.
 */
import { parseArgs } from 'node:util';
import { formatReport } from './lib/annotations';
import {
	deployConfigSchema,
	parseWranglerConfig,
	verifyWranglerConfig,
} from './lib/verify-wrangler-config';
import { fail, isGitHubActions, readJsonc, setOutputs } from './support';

const { values, positionals: configPaths } = parseArgs({
	args: process.argv.slice(2),
	options: {
		expect: { type: 'string', default: '.github/deploy.config.json' },
		enforce: { type: 'boolean', default: false },
	},
	allowPositionals: true,
});
const expectPath = values.expect;

if (configPaths.length === 0) {
	console.error('usage: verify-wrangler-config.ts <config> [<config>...] [--expect <deploy.config.json>] [--enforce]');
	process.exit(2);
}

const github = isGitHubActions();
let total = 0;
let enforced = values.enforce;

try {
	const expected = deployConfigSchema.parse(readJsonc(expectPath));
	enforced ||= expected.enforce;

	for (const path of configPaths) {
		const findings = verifyWranglerConfig(parseWranglerConfig(readJsonc(path)), expected);
		total += findings.length;

		for (const finding of findings) {
			console.log(
				formatReport(
					{
						level: enforced ? 'error' : 'warning',
						title: `Wrangler config guard (${finding.rule})`,
						file: path,
						message: finding.message,
					},
					github,
				),
			);
		}

		if (findings.length === 0) console.log(`Wrangler config guard: ${path} matches ${expectPath}.`);
	}
} catch (error) {
	fail(error);
}

setOutputs({ findings: total });

if (total > 0 && !enforced) {
	console.log(
		`Wrangler config guard: ${total} finding(s) reported as warnings because ${expectPath} does not set "enforce": true.`,
	);
}

if (total > 0 && enforced) process.exit(1);
