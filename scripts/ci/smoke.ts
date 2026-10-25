#!/usr/bin/env bun
/**
 * Probes a deployed Worker with the smoke checks from lib/smoke.ts.
 *
 *   bun scripts/ci/smoke.ts --config dist/<worker>/wrangler.json [--attempts 12] [--delay 5]
 *   bun scripts/ci/smoke.ts --url https://example.com
 *
 * The host is the committed CUSTOM_DOMAIN. Each check is retried because a new
 * version takes a few seconds to reach every edge location. Exits 1 when any
 * check still fails after the last attempt.
 */
import { parseArgs } from 'node:util';
import { smokeChecks, type SmokeCheck, type SmokeResponse } from './lib/smoke';
import { isFullyQualifiedDomain, parseWranglerConfig } from './lib/verify-wrangler-config';
import { fail, readJsonc, setOutputs } from './support';

const REQUEST_TIMEOUT_MS = 15_000;

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		config: { type: 'string' },
		url: { type: 'string' },
		attempts: { type: 'string', default: '12' },
		delay: { type: 'string', default: '5' },
	},
});

function resolveBaseUrl(): string {
	if (values.url) return values.url.replace(/\/+$/, '');
	if (!values.config) {
		console.error('usage: smoke.ts (--config <wrangler.json> | --url <origin>) [--attempts N] [--delay SECONDS]');
		process.exit(2);
	}

	const domain = parseWranglerConfig(readJsonc(values.config)).vars?.CUSTOM_DOMAIN;
	if (typeof domain !== 'string' || !isFullyQualifiedDomain(domain)) {
		throw new Error(
			`vars.CUSTOM_DOMAIN in ${values.config} is ${JSON.stringify(domain ?? null)}, not a fully qualified domain name, so there is no host to probe. Re-home wrangler.jsonc (docs/ci-cd.md).`,
		);
	}
	return `https://${domain}`;
}

async function probe(url: string): Promise<SmokeResponse> {
	const response = await fetch(url, {
		redirect: 'manual',
		headers: { 'user-agent': 'vibesdk-ci-smoke' },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	return {
		status: response.status,
		contentType: response.headers.get('content-type') ?? '',
		body: await response.text(),
		headers: Object.fromEntries([...response.headers].map(([name, value]) => [name.toLowerCase(), value])),
	};
}

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function run(check: SmokeCheck, baseUrl: string, attempts: number, delay: number): Promise<string | null> {
	let lastFailure = 'no attempt was made';

	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const failure = check.validate(await probe(`${baseUrl}${check.path}`));
			if (failure === null) return null;
			lastFailure = failure;
		} catch (error) {
			lastFailure = `request failed: ${error instanceof Error ? error.message : String(error)}`;
		}

		if (attempt < attempts) await sleep(delay);
	}

	return lastFailure;
}

try {
	const baseUrl = resolveBaseUrl();
	const attempts = Number(values.attempts);
	const delay = Number(values.delay);
	if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(delay) || delay < 0) {
		throw new Error('--attempts must be a positive integer and --delay a non-negative number of seconds.');
	}

	console.log(`Smoke checks against ${baseUrl}`);
	let failed = 0;

	for (const check of smokeChecks) {
		const failure = await run(check, baseUrl, attempts, delay);
		if (failure === null) {
			console.log(`  pass  ${check.name.padEnd(12)} ${check.path}`);
		} else {
			failed++;
			console.log(`  FAIL  ${check.name.padEnd(12)} ${check.path}: ${failure}`);
		}
	}

	setOutputs({ failed });
	if (failed > 0) process.exit(1);
} catch (error) {
	fail(error);
}
