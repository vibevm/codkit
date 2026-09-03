import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function writeOwnManifestFixture(root: string, pin: string, roots: readonly string[]): void {
	const path = join(root, 'delta', 'own', 'patchset.delta.json');
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				codkitOwnManifest: 2,
				units: [
					{
						id: 'CK-workbench-208',
						layer: 'own',
						type: 'extend',
						category: 'own',
						owner: 'workbench-core',
						reason: 'cycle materialization own fixture',
						link: 'none',
						cause: 'none',
						pin,
						contractTests: [],
						roots
					}
				],
				serviceOverrides: []
			},
			null,
			2
		)}\n`,
		'utf8'
	);
}
