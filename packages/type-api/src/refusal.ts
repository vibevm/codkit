/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-API-STABILITY */
// How an answer of a type says "this file is not what it claims to be".
//
// A type package imports nothing from the tool but this contract, so it cannot
// raise the tool's own diagnosed error; and the tool must not turn a refusal it
// asked for into an unexplained crash. So the contract states the one shape:
// an Error carrying the detail and the hint, marked with a registered symbol so
// the engine recognises it across module instances rather than by `instanceof`.
// The engine turns it into `CK-E-ARTIFACT-BROKEN` naming the file it was
// reading; nothing else about the tool's message registry is visible here.

/** Registered so two copies of this module still recognise each other's marks. */
const MARK = Symbol.for('@codkit/type-api.brokenArtifact');

/** The refusal, as the engine reads it back. */
export type BrokenArtifact = Error & { readonly hint: string };

/**
 * Refuse a file the answer cannot read. `detail` completes the sentence
 * "`<path>`: ..."; `hint` says what would make the file readable.
 */
export function brokenArtifact(detail: string, hint: string): BrokenArtifact {
	const error = new Error(detail) as Error & { hint: string };
	Object.defineProperty(error, MARK, { value: true });
	error.hint = hint;
	return error;
}

/** Whether a thrown value is a refusal raised by an answer of a type. */
export function isBrokenArtifact(value: unknown): value is BrokenArtifact {
	return value instanceof Error && (value as { [MARK]?: unknown })[MARK] === true;
}
