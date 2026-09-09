/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-IDENTITY */
// Area 1: what a pin of a plain git upstream looks like, and what proves that a
// directory really is that upstream.
//
// A family with a release process has a tag shape; an arbitrary repository does
// not, so the pattern here accepts any ordinary git tag and refuses only what
// is not a tag at all. The fingerprint is the one file the patch set names as
// the manifest of its upstream: with no product model there is nothing else the
// type could look for.

import type { IdentityArea } from '@codkit/type-api';
import type { GenericTypeConfig } from './configSchema.ts';

/** Any ordinary git tag: a `v` prefix, dates and release trains all pass. */
export const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function makeIdentity(identity: GenericTypeConfig['identity']): IdentityArea {
	const manifest = identity?.manifest;
	return {
		tagPattern: TAG_PATTERN,
		tagShape: 'an ordinary git tag',
		fingerprints:
			manifest === undefined
				? []
				: [
						{
							path: manifest.path,
							kind: 'file',
							why:
								manifest.nameField === undefined
									? 'the manifest this patch set names as the proof of its upstream'
									: `the manifest this patch set names as the proof of its upstream; its field ${manifest.nameField} carries the name of the project`
						}
					]
	};
}

export const identity: IdentityArea = makeIdentity(undefined);
