// unit: the files of the licence metadata itself carry nothing and are never
// annotated (PROP-014 ##LIC-CARRIER-ANNOTATION): registries, sidecars, the
// LICENSES directory, and the licence texts of REUSE - LICENSE, LICENCE and
// COPYING with or without one extension.

import { describe, expect, it } from 'vitest';
import { isConsumerLicenseMetadata } from '../../src/lib/consumerLicenseCheck.ts';

describe('isConsumerLicenseMetadata', () => {
	it('names the licence texts with or without one extension', () => {
		for (const path of ['LICENSE', 'pack/LICENSE.md', 'pack/LICENSE.txt', 'LICENCE', 'COPYING', 'COPYING.LESSER', 'a/b/COPYING.txt']) {
			expect(isConsumerLicenseMetadata(path), path).toBe(true);
		}
	});

	it('names the registries, the sidecars and the LICENSES directory', () => {
		for (const path of ['REUSE.toml', 'deep/REUSE.toml', 'icons/logo.png.license', 'LICENSES/MIT.txt']) {
			expect(isConsumerLicenseMetadata(path), path).toBe(true);
		}
	});

	it('leaves the files that need a carrier alone', () => {
		for (const path of [
			'LICENSE-CODKIT.md',
			'licenses/LICENSE-CODE-OSS.md',
			'LicenseService.ts',
			'license.json',
			'README.md',
			'copying.ts'
		]) {
			expect(isConsumerLicenseMetadata(path), path).toBe(false);
		}
	});
});
