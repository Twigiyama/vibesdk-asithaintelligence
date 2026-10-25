/** File and workflow I/O shared by the command-line wrappers in this directory. */
import { appendFileSync, readFileSync } from 'node:fs';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

export const isGitHubActions = (): boolean => process.env.GITHUB_ACTIONS === 'true';

export function readJsonc(path: string): unknown {
	const errors: ParseError[] = [];
	const value: unknown = parse(readFileSync(path, 'utf8'), errors, {
		allowTrailingComma: true,
	});
	if (errors.length > 0) {
		const detail = errors
			.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
			.join(', ');
		throw new Error(`${path} is not valid JSONC: ${detail}`);
	}
	return value;
}

/** Writes step outputs when running in Actions; elsewhere does nothing. */
export function setOutputs(outputs: Readonly<Record<string, string | number | boolean>>): void {
	const file = process.env.GITHUB_OUTPUT;
	if (!file) return;

	for (const [name, value] of Object.entries(outputs)) {
		const text = String(value);
		if (/[\r\n]/.test(text)) throw new Error(`Output ${name} must be a single line.`);
		appendFileSync(file, `${name}=${text}\n`);
	}
}

/** Exits with a one-line message; used for failures that are not findings. */
export function fail(error: unknown): never {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(2);
}
