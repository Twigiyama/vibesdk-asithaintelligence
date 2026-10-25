/**
 * Read-only access to the live state of a Worker through the Cloudflare API.
 *
 * The endpoints are the ones wrangler itself uses to describe a deployed Worker.
 * Responses are validated before use, so an API change fails with the name of the
 * request instead of producing a silently wrong comparison. Error messages never
 * contain the token.
 */
import { z } from 'zod';
import type { LiveBinding, LiveDeployment } from './preflight';

const API_BASE = 'https://api.cloudflare.com/client/v4';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class CloudflareApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = 'CloudflareApiError';
	}
}

export interface LiveWorker {
	exists: boolean;
	migrationTag: string | null;
	bindings: LiveBinding[];
	secretNames: string[];
	deployments: LiveDeployment[];
}

interface ClientOptions {
	accountId: string;
	token: string;
	/** Overrides the API origin; only the tests and local fixtures use it. */
	baseUrl?: string;
	fetchImpl?: FetchLike;
}

const envelopeSchema = z.looseObject({
	success: z.boolean().optional(),
	errors: z
		.array(z.looseObject({ code: z.number().optional(), message: z.string().optional() }))
		.optional(),
	result: z.unknown().optional(),
});

const environmentSchema = z.looseObject({
	script: z.looseObject({ migration_tag: z.string().nullish() }).optional(),
});

const bindingsSchema = z.array(z.looseObject({ name: z.string(), type: z.string() }));

const secretsSchema = z.array(z.looseObject({ name: z.string() }));

const deploymentsSchema = z.looseObject({
	deployments: z.array(
		z.looseObject({
			id: z.string().optional(),
			created_on: z.string().optional(),
			source: z.string().optional(),
			annotations: z.record(z.string(), z.unknown()).optional(),
			versions: z.array(z.looseObject({ version_id: z.string(), percentage: z.number() })),
		}),
	),
});

const d1QuerySchema = z.array(
	z.looseObject({ results: z.array(z.looseObject({ name: z.string() })) }),
);

interface CallResult {
	status: number;
	ok: boolean;
	result: unknown;
	messages: string[];
	codes: number[];
}

async function call(
	options: ClientOptions,
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<CallResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const method = init.method ?? 'GET';

	const response = await fetchImpl(
		`${(options.baseUrl ?? API_BASE).replace(/\/+$/, '')}/accounts/${options.accountId}${path}`,
		{
			method,
			headers: {
				authorization: `Bearer ${options.token}`,
				'content-type': 'application/json',
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		},
	);

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		payload = undefined;
	}

	const envelope = envelopeSchema.safeParse(payload);
	const errors = envelope.success ? (envelope.data.errors ?? []) : [];

	return {
		status: response.status,
		ok: response.ok && envelope.success && envelope.data.success !== false,
		result: envelope.success ? envelope.data.result : undefined,
		messages: errors.flatMap((e) => (e.message ? [e.message] : [])),
		codes: errors.flatMap((e) => (e.code === undefined ? [] : [e.code])),
	};
}

function failure(path: string, result: CallResult): CloudflareApiError {
	const detail = result.messages.length > 0 ? `: ${result.messages.join('; ')}` : '';
	return new CloudflareApiError(
		`Cloudflare API request ${path} failed with HTTP ${result.status}${detail}`,
		result.status,
	);
}

function parseResult<S extends z.ZodType>(path: string, schema: S, result: unknown): z.infer<S> {
	const parsed = schema.safeParse(result);
	if (parsed.success) return parsed.data;

	const issue = parsed.error.issues[0];
	const where = issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
	throw new CloudflareApiError(
		`Cloudflare API request ${path}: unexpected response${where}: ${issue.message}`,
	);
}

async function get<S extends z.ZodType>(
	options: ClientOptions,
	path: string,
	schema: S,
): Promise<z.infer<S>> {
	const result = await call(options, path);
	if (!result.ok) throw failure(path, result);
	return parseResult(path, schema, result.result);
}

export async function fetchLiveWorker(
	options: ClientOptions & { workerName: string },
): Promise<LiveWorker> {
	const name = encodeURIComponent(options.workerName);
	const environmentPath = `/workers/services/${name}/environments/production`;

	const probe = await call(options, environmentPath);
	if (probe.status === 404) {
		return { exists: false, migrationTag: null, bindings: [], secretNames: [], deployments: [] };
	}
	if (!probe.ok) throw failure(environmentPath, probe);
	const environment = parseResult(environmentPath, environmentSchema, probe.result);

	const [bindings, secrets, deployments] = await Promise.all([
		get(options, `${environmentPath}/bindings`, bindingsSchema),
		get(options, `/workers/scripts/${name}/secrets`, secretsSchema),
		get(options, `/workers/scripts/${name}/deployments`, deploymentsSchema),
	]);

	return {
		exists: true,
		migrationTag: environment.script?.migration_tag ?? null,
		bindings,
		secretNames: secrets.map((secret) => secret.name),
		deployments: deployments.deployments.map((deployment) => {
			const triggeredBy = deployment.annotations?.['workers/triggered_by'];
			const message = deployment.annotations?.['workers/message'];
			return {
				id: deployment.id,
				createdOn: deployment.created_on,
				source: deployment.source,
				triggeredBy: typeof triggeredBy === 'string' ? triggeredBy : undefined,
				message: typeof message === 'string' ? message : undefined,
				versions: deployment.versions.map((v) => ({
					versionId: v.version_id,
					percentage: v.percentage,
				})),
			};
		}),
	};
}

/**
 * Names recorded in the database's migrations table, in the order they ran, or
 * null when the table does not exist yet.
 */
export async function fetchAppliedD1Migrations(
	options: ClientOptions & { databaseId: string },
): Promise<string[] | null> {
	const path = `/d1/database/${encodeURIComponent(options.databaseId)}/query`;
	const result = await call(options, path, {
		method: 'POST',
		body: { sql: 'SELECT name FROM d1_migrations ORDER BY id' },
	});

	if (!result.ok) {
		if (result.messages.some((message) => message.includes('no such table'))) return null;
		throw failure(path, result);
	}

	const statements = parseResult(path, d1QuerySchema, result.result);
	return (statements[0]?.results ?? []).map((row) => row.name);
}

/** The API refuses to roll back past a secret change; the message lists the secrets. */
const MODIFIED_SECRETS_CODE = 10220;
const MAX_DEPLOYMENT_MESSAGE_LENGTH = 100;

export type CreateDeploymentResult =
	| { created: true }
	| { created: false; reason: 'secrets-changed'; secrets: string[] };

/**
 * Puts one version on 100% of traffic. Without `force`, the API declines when
 * secrets changed after that version was deployed, because the rollback would
 * bring their old values back; the caller decides whether that is acceptable.
 */
export async function createDeployment(
	options: ClientOptions & {
		workerName: string;
		versionId: string;
		message: string;
		force?: boolean;
	},
): Promise<CreateDeploymentResult> {
	const path = `/workers/scripts/${encodeURIComponent(options.workerName)}/deployments${options.force ? '?force=true' : ''}`;
	const result = await call(options, path, {
		method: 'POST',
		body: {
			strategy: 'percentage',
			versions: [{ version_id: options.versionId, percentage: 100 }],
			annotations: { 'workers/message': options.message.slice(0, MAX_DEPLOYMENT_MESSAGE_LENGTH) },
		},
	});

	if (result.ok) return { created: true };

	if (result.codes.includes(MODIFIED_SECRETS_CODE)) {
		const listed = /The following secrets have changed:\s*([^[\]]+?)\s*(?:\[code:.*)?$/.exec(
			result.messages.join(' '),
		);
		const secrets = listed ? listed[1].split(',').map((name) => name.trim()).filter(Boolean) : [];
		return { created: false, reason: 'secrets-changed', secrets };
	}

	throw failure(path, result);
}
