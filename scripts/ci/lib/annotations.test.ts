import { describe, expect, it } from 'vitest';
import { formatAnnotation, formatReport } from './annotations';

describe('formatReport', () => {
	const annotation = {
		level: 'error',
		message: 'broken',
		file: 'migrations/0008_x.sql',
		line: 3,
		title: 'Migration guard',
	} as const;

	it('emits a workflow command on GitHub Actions', () => {
		expect(formatReport(annotation, true)).toBe(formatAnnotation(annotation));
	});

	it('emits one readable line elsewhere', () => {
		expect(formatReport(annotation, false)).toBe(
			'error: migrations/0008_x.sql:3: Migration guard: broken',
		);
	});

	it('omits the parts that are not set', () => {
		expect(formatReport({ level: 'warning', message: 'careful' }, false)).toBe(
			'warning: careful',
		);
	});
});

describe('formatAnnotation', () => {
	it('formats a bare message', () => {
		expect(formatAnnotation({ level: 'error', message: 'broken' })).toBe(
			'::error::broken',
		);
	});

	it('includes file, line and title properties when given', () => {
		expect(
			formatAnnotation({
				level: 'warning',
				message: 'check this',
				file: 'migrations/0008_x.sql',
				line: 3,
				title: 'Migration guard',
			}),
		).toBe(
			'::warning file=migrations/0008_x.sql,line=3,title=Migration guard::check this',
		);
	});

	it('escapes line breaks and percent signs in the message', () => {
		expect(formatAnnotation({ level: 'error', message: '100%\nnext\r' })).toBe(
			'::error::100%25%0Anext%0D',
		);
	});

	it('escapes colons and commas in property values, which delimit properties', () => {
		expect(
			formatAnnotation({
				level: 'error',
				message: 'm',
				file: 'a,b:c.sql',
				title: 'x: y, z',
			}),
		).toBe('::error file=a%2Cb%3Ac.sql,title=x%3A y%2C z::m');
	});

	it('does not escape colons or commas in the message', () => {
		expect(formatAnnotation({ level: 'notice', message: 'a: b, c' })).toBe(
			'::notice::a: b, c',
		);
	});
});
