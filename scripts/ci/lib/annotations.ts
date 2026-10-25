/** GitHub Actions workflow-command annotations. */

export type AnnotationLevel = 'error' | 'warning' | 'notice';

export interface Annotation {
	level: AnnotationLevel;
	message: string;
	file?: string;
	line?: number;
	title?: string;
}

function escapeData(value: string): string {
	return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(value: string): string {
	return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function formatAnnotation({
	level,
	message,
	file,
	line,
	title,
}: Annotation): string {
	const properties: string[] = [];
	if (file !== undefined) properties.push(`file=${escapeProperty(file)}`);
	if (line !== undefined) properties.push(`line=${line}`);
	if (title !== undefined) properties.push(`title=${escapeProperty(title)}`);

	const head = properties.length > 0 ? `${level} ${properties.join(',')}` : level;
	return `::${head}::${escapeData(message)}`;
}

/** Registers a value so the runner masks it in every log from then on. */
export function formatMask(value: string): string {
	return `::add-mask::${escapeData(value)}`;
}

/** A workflow command on GitHub Actions, one readable line anywhere else. */
export function formatReport(annotation: Annotation, github: boolean): string {
	if (github) return formatAnnotation(annotation);

	const { level, message, file, line, title } = annotation;
	const location =
		file === undefined ? '' : `${file}${line === undefined ? '' : `:${line}`}: `;
	return `${level}: ${location}${title === undefined ? '' : `${title}: `}${message}`;
}
