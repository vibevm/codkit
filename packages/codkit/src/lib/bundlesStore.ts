/** @scope spec://codkit/modules/codkit/PROP-006#BUNDLES-STAMP */
// The stamp of the bundles of one fork tree (PROP-006 ##BUNDLES-STAMP): which
// unit codkit unpacked where and from what - the name, the version, the hash of
// the archive, the cache path, and the size and mtime of the archive, so that an
// unchanged archive is not hashed again, an unchanged unit is not unpacked
// again, and a withdrawn bundle is removed exactly where codkit wrote it. It
// sits beside the stamp of the inputs in the tree's own git directory.
//
// It is a record of codkit's own writing, never a source of truth: a stamp that
// does not read is warned about and treated as absent - every bundle is
// provisioned again and a new stamp is written.

import { z } from 'zod';
import { encodeUtf8 } from './bytes.ts';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.ts';
import { gitDirOf } from './treeCache.ts';

export const BUNDLES_STAMP_RELATIVE_PATH = 'codkit/bundles.json';
const STAMP_SCHEMA_VERSION = 1;

export const storedBundleSchema = z.strictObject({
	name: z.string().min(1),
	version: z.string(),
	sha256: z.string().regex(/^[0-9a-f]{64}$/u),
	cachePath: z.string().min(1),
	/** The target whose archive was unpacked, for a unit built per target; absent or null for one archive. */
	target: z.string().min(1).nullable().optional(),
	archiveBytes: z.number().int().nonnegative(),
	archiveMtimeMs: z.number()
});

const storeSchema = z.strictObject({ codkitBundles: z.literal(STAMP_SCHEMA_VERSION), bundles: z.array(storedBundleSchema) });

export type StoredBundle = z.infer<typeof storedBundleSchema>;

/** The stamp of every bundle this tree carries; empty when none was ever provisioned. */
export function readBundleStore(treeDir: string, onWarn: (text: string) => void): readonly StoredBundle[] {
	let read;
	try {
		read = readContainedFile(gitDirOf(treeDir), BUNDLES_STAMP_RELATIVE_PATH, { what: BUNDLES_STAMP_RELATIVE_PATH });
	} catch (error) {
		onWarn(
			`the bundles stamp of the tree cannot be read (${error instanceof Error ? error.message : String(error)}); every bundle is provisioned again`
		);
		return [];
	}
	if (read.state !== 'ok') return [];
	try {
		return storeSchema.parse(JSON.parse(Buffer.from(read.bytes).toString('utf8'))).bundles;
	} catch {
		onWarn(`the bundles stamp ${BUNDLES_STAMP_RELATIVE_PATH} of the tree is malformed; every bundle is provisioned again`);
		return [];
	}
}

/** Replace the stamp; the bundles in declaration order. */
export function writeBundleStore(treeDir: string, bundles: readonly StoredBundle[]): void {
	writeContainedFileAtomic(gitDirOf(treeDir), BUNDLES_STAMP_RELATIVE_PATH, {
		bytes: encodeUtf8(`${JSON.stringify({ codkitBundles: STAMP_SCHEMA_VERSION, bundles }, null, 2)}\n`),
		what: BUNDLES_STAMP_RELATIVE_PATH
	});
}
