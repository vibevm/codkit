/** @scope spec://codkit/modules/codkit/PROP-006#INPUTS-STAMP */
// The stamp of the inputs of one fork tree (PROP-006 ##INPUTS-STAMP): what
// `load` last delivered for each input - where, from which source, the content
// stamp of that source and every file with its blob. It sits beside the apply
// mark in the tree's own git directory, and the blobs sit in the tree's object
// database: the stamp says whether a build can be skipped, and the blobs are
// what a skipped build puts back.
//
// It is a record of codkit's own writing, never a source of truth: a stamp that
// does not read is warned about and treated as absent - the next load builds
// again and writes a new one.

import { z } from 'zod';
import { encodeUtf8 } from './bytes.ts';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.ts';
import { runGit } from './gitx.ts';
import { gitDirOf } from './treeCache.ts';

export const INPUTS_STAMP_RELATIVE_PATH = 'codkit/inputs.json';
const STAMP_SCHEMA_VERSION = 1;

const storedInputSchema = z.strictObject({
	name: z.string().min(1),
	to: z.string().min(1),
	mode: z.enum(['working', 'pinned']),
	commit: z
		.string()
		.regex(/^[0-9a-f]{40}$/)
		.nullable(),
	stamp: z.string().regex(/^[0-9a-f]{64}$/),
	files: z.record(z.string().min(1), z.string().regex(/^[0-9a-f]{40,64}$/))
});

const storeSchema = z.strictObject({ codkitInputs: z.literal(STAMP_SCHEMA_VERSION), inputs: z.array(storedInputSchema) });

export type StoredInput = z.infer<typeof storedInputSchema>;

/** The stamp of every input this tree carries; empty when none was ever delivered. */
export function readInputStore(treeDir: string, onWarn: (text: string) => void): readonly StoredInput[] {
	let read;
	try {
		read = readContainedFile(gitDirOf(treeDir), INPUTS_STAMP_RELATIVE_PATH, { what: INPUTS_STAMP_RELATIVE_PATH });
	} catch (error) {
		onWarn(
			`the inputs stamp of the tree cannot be read (${error instanceof Error ? error.message : String(error)}); every input is built again`
		);
		return [];
	}
	if (read.state !== 'ok') return [];
	try {
		return storeSchema.parse(JSON.parse(Buffer.from(read.bytes).toString('utf8'))).inputs;
	} catch {
		onWarn(`the inputs stamp ${INPUTS_STAMP_RELATIVE_PATH} of the tree is malformed; every input is built again`);
		return [];
	}
}

/** Replace the stamp; the inputs in declaration order, the files of each in byte order. */
export function writeInputStore(treeDir: string, inputs: readonly StoredInput[]): void {
	const canonical = inputs.map((input) => ({ ...input, files: sortedRecord(input.files) }));
	writeContainedFileAtomic(gitDirOf(treeDir), INPUTS_STAMP_RELATIVE_PATH, {
		bytes: encodeUtf8(`${JSON.stringify({ codkitInputs: STAMP_SCHEMA_VERSION, inputs: canonical }, null, 2)}\n`),
		what: INPUTS_STAMP_RELATIVE_PATH
	});
}

/** Whether the tree's object database holds every blob, so a stamp can be reused. */
export function blobsPresent(treeDir: string, blobs: readonly string[]): boolean {
	if (blobs.length === 0) return true;
	const checked = runGit({ args: ['cat-file', '--batch-check'], cwd: treeDir, input: `${blobs.join('\n')}\n` });
	return checked.status === 0 && !checked.stdout.split('\n').some((line) => line.endsWith(' missing'));
}

function sortedRecord(record: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	const sorted: Record<string, string> = {};
	for (const key of Object.keys(record).sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')))) {
		sorted[key] = record[key] ?? '';
	}
	return sorted;
}
