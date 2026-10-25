/**
 * Validation and planning for the WORKER_SECRETS sync. Nothing here ever puts a
 * secret value into a message: errors name secrets, never their contents.
 */
import { jwtSecretProblems } from '../../../shared/utils/jwt-secret';
import { formatMask } from './annotations';

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SECRETS = 100;
// Shorter lines are left unmasked so ordinary words such as "true" or "dev" do not
// disappear from the logs.
const MIN_MASKED_LENGTH = 8;

export interface SecretsContext {
	/** Names of `vars` committed in wrangler.jsonc. */
	committedVarNames: readonly string[];
	/** The token the deploy runs with; the Worker must not get the same one. */
	ciToken?: string;
	allowDelete: boolean;
}

export type SecretEntries = Record<string, string | null>;

export interface SecretsValidation {
	errors: string[];
	entries: SecretEntries;
}

export interface SecretSyncPlan {
	create: string[];
	update: string[];
	delete: string[];
	untouched: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateWorkerSecrets(raw: string, context: SecretsContext): SecretsValidation {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// The parser's own message can quote part of the input, so it is dropped.
		return { errors: ['WORKER_SECRETS is not valid JSON.'], entries: {} };
	}

	if (!isPlainObject(parsed)) {
		return {
			errors: ['WORKER_SECRETS must be a JSON object of secret names to values.'],
			entries: {},
		};
	}

	const names = Object.keys(parsed);
	if (names.length === 0) {
		return { errors: ['WORKER_SECRETS contains no secrets.'], entries: {} };
	}

	const errors: string[] = [];
	const entries: SecretEntries = {};

	if (names.length > MAX_SECRETS) {
		errors.push(`WORKER_SECRETS has ${names.length} secrets; one upload accepts at most ${MAX_SECRETS}.`);
	}

	for (const name of names) {
		const value = parsed[name];

		if (!SECRET_NAME.test(name)) {
			errors.push(`Secret name ${JSON.stringify(name)} is not a valid binding name.`);
			continue;
		}

		if (value === null) {
			if (!context.allowDelete) {
				errors.push(`Secret ${name} is null (delete) but deletion was not allowed; enable allow_delete.`);
			}
			entries[name] = null;
			continue;
		}

		if (typeof value !== 'string' || value === '') {
			errors.push(`Secret ${name} must be a non-empty string (or null to delete).`);
			continue;
		}

		if (context.committedVarNames.includes(name)) {
			errors.push(
				`Secret ${name} is also a committed var in wrangler.jsonc; keep non-secret configuration in vars only.`,
			);
		}

		if (name === 'JWT_SECRET') {
			for (const problem of jwtSecretProblems(value)) {
				errors.push(`JWT_SECRET is rejected by the Worker: ${problem.replace(/^JWT_SECRET /, '')}`);
			}
		}

		if (name === 'CLOUDFLARE_API_TOKEN' && context.ciToken !== undefined && value === context.ciToken) {
			errors.push(
				'CLOUDFLARE_API_TOKEN must differ from the CI deploy token: the Worker needs a narrower token.',
			);
		}

		entries[name] = value;
	}

	return { errors, entries };
}

/**
 * Mask commands for the runner, one per line of each value. A multi-line value
 * (a private key, say) must be registered line by line: printed whole, only its
 * first line would be treated as the command and the rest would reach the log.
 */
export function secretMaskCommands(values: Iterable<string>): string[] {
	const lines = new Set<string>();
	for (const value of values) {
		for (const line of value.split(/\r?\n/)) {
			if (line.length >= MIN_MASKED_LENGTH) lines.add(line);
		}
	}
	return [...lines].map(formatMask);
}

/** What a sync would do, by name. Live secrets that are not listed stay as they are. */
export function planSecretSync(entries: SecretEntries, liveNames: readonly string[]): SecretSyncPlan {
	const live = new Set(liveNames);
	const plan: SecretSyncPlan = { create: [], update: [], delete: [], untouched: [] };

	for (const [name, value] of Object.entries(entries)) {
		if (value === null) {
			if (live.has(name)) plan.delete.push(name);
		} else if (live.has(name)) {
			plan.update.push(name);
		} else {
			plan.create.push(name);
		}
	}

	plan.untouched = liveNames.filter((name) => !(name in entries));

	for (const names of Object.values(plan)) names.sort();
	return plan;
}
