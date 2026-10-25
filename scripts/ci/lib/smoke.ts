/**
 * Post-deploy smoke checks. Together they prove the new version serves its
 * shipped vars, reaches D1 and answers for the static assets, without needing
 * a user session. /api/health alone only proves routing.
 */
import { z } from 'zod';

export interface SmokeResponse {
	status: number;
	contentType: string;
	body: string;
	/** Response headers with lowercase names. */
	headers: Record<string, string>;
}

export interface SmokeCheck {
	name: string;
	path: string;
	/** A failure message, or null when the response is as expected. */
	validate(response: SmokeResponse): string | null;
}

const healthSchema = z.looseObject({ status: z.literal('ok') });

const capabilitiesSchema = z.looseObject({
	success: z.literal(true),
	data: z.looseObject({ features: z.array(z.unknown()).min(1) }),
});

const publicAppsSchema = z.looseObject({
	success: z.literal(true),
	data: z.looseObject({ apps: z.array(z.unknown()) }),
});

function jsonCheck(
	name: string,
	path: string,
	schema: z.ZodType,
): SmokeCheck {
	return {
		name,
		path,
		validate(response) {
			const challenged = challengeFailure(response);
			if (challenged) return challenged;
			if (response.status !== 200) return `expected HTTP 200, got ${response.status}`;

			let body: unknown;
			try {
				body = JSON.parse(response.body);
			} catch {
				return `expected a JSON body, got ${response.contentType || 'no content type'}`;
			}

			const result = schema.safeParse(body);
			if (result.success) return null;

			const issue = result.error.issues[0];
			const where = issue.path.length > 0 ? issue.path.join('.') : 'body';
			return `unexpected response at ${where}: ${issue.message}`;
		},
	};
}

function challengeFailure(response: SmokeResponse): string | null {
	if (response.headers['cf-mitigated'] !== 'challenge') return null;
	return `blocked by a Cloudflare challenge (HTTP ${response.status}); add a WAF skip rule for the CI runner, for example keyed on a secret header`;
}

export const smokeChecks: readonly SmokeCheck[] = [
	jsonCheck('health', '/api/health', healthSchema),
	jsonCheck('capabilities', '/api/capabilities', capabilitiesSchema),
	jsonCheck('public apps', '/api/apps/public?limit=1', publicAppsSchema),
	{
		name: 'assets',
		path: '/',
		validate(response) {
			const challenged = challengeFailure(response);
			if (challenged) return challenged;
			if (response.status !== 200) return `expected HTTP 200, got ${response.status}`;
			if (!response.contentType.toLowerCase().includes('text/html')) {
				return `expected an HTML document, got ${response.contentType || 'no content type'}`;
			}
			return null;
		},
	},
];
