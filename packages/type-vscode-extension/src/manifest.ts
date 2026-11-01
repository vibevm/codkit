/** @scope spec://codkit/modules/vscode-extension/PROP-002#VSX-TREE-FINGERPRINT */
// Reading the manifests of this family as JSON objects.
//
// Two areas read the same kind of file: the identity area proves a tree by what
// its manifests say, and the advisory area reads the manifest at two pins. Both
// are handed the text by the engine and never open a file themselves; what they
// share is how a text becomes an object, and how a text that is not JSON is
// refused - with `brokenArtifact`, which the engine turns into
// `CK-E-ARTIFACT-BROKEN` naming the file (##VSX-TREE-FINGERPRINT).

import { brokenArtifact } from '@codkit/type-api';

/** A parsed JSON object, read field by field as `unknown`. */
export type JsonObject = { readonly [key: string]: unknown };

/** The text of the files the engine handed over, by tree path; absent files are null. */
export type TextFiles = ReadonlyMap<string, string | null>;

/** Whether a parsed value is a JSON object and not an array. */
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One manifest of the tree as an object: null when the file is absent or when
 * it parses as something other than an object; a refusal when it is not JSON at
 * all, because a manifest that cannot be parsed is broken rather than missing.
 */
export function readJsonObject(files: TextFiles, path: string): JsonObject | null {
	const text = files.get(path) ?? null;
	if (text === null) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		throw brokenArtifact(
			`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
			'restore the manifest from the pin'
		);
	}
	return isJsonObject(parsed) ? parsed : null;
}

/** The non-empty string a field carries, or null for anything else. */
export function nonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

/** The nested object a field carries, or null for anything else. */
export function objectField(object: JsonObject | null, key: string): JsonObject | null {
	const value = object?.[key];
	return isJsonObject(value) ? value : null;
}
