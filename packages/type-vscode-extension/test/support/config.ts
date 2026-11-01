// The two configurations the suites answer from: the smallest one, a
// repository that is one extension, and a full one - a synthetic extension
// `acme-sample` by the publisher `acme`, one workspace package of a pnpm
// monorepo, with every optional field of PROP-002 ##VSX-TYPE-CONFIG declared.

import type { VsxTypeConfig } from '../../src/index.ts';

/** A repository that is one extension: the own root under its `src/`. */
export const MINIMAL: VsxTypeConfig = {
	ownRoot: 'src/acme',
	extensionRoot: '.'
};

/** The extension as one workspace package of a monorepo, with every field declared. */
export const FULL: VsxTypeConfig = {
	ownRoot: 'packages/acme-sample/src/own',
	extensionRoot: 'packages/acme-sample',
	monorepo: true,
	packageManager: 'pnpm',
	tagPattern: '^release-\\d+\\.\\d+\\.\\d+$',
	scripts: {
		build: 'build',
		lint: ['lint', 'lint:types'],
		test: { command: 'vitest run', ownGlobArg: '--dir' },
		package: 'vsix'
	},
	entryModules: ['packages/acme-sample/src/extension.ts', 'packages/acme-sample/src/webview/main.ts'],
	localeManifests: ['packages/acme-sample/package.nls.json', 'packages/acme-sample/package.nls.ru.json'],
	cleanupWhitelist: ['packages/acme-sample/.cache/'],
	packageScratch: ['packages/acme-sample/package.json'],
	outputs: ['packages/acme-sample/build/*.vsix'],
	stamps: [{ name: 'ACME_CHANNEL', value: 'stable' }],
	watch: {
		channels: [
			{
				channel: 'bundle',
				script: 'watch:bundle',
				passStart: ['^\\[watch\\] build started$'],
				passEnd: ['^\\[watch\\] build finished$'],
				errorCountLine: ['^(\\d+) errors?$']
			}
		]
	},
	preview: { host: 'code-insiders', workspace: 'samples/workspace' }
};

/** The manifest of the synthetic extension, as its upstream writes it. */
export function sampleManifest(overrides: Readonly<Record<string, unknown>> = {}): string {
	return JSON.stringify({
		name: 'acme-sample',
		displayName: 'Acme Sample',
		publisher: 'acme',
		version: '1.2.3',
		engines: { vscode: '^1.90.0' },
		main: './dist/extension.js',
		activationEvents: ['onStartupFinished'],
		contributes: {
			commands: [{ command: 'acmeSample.hello', title: 'Hello' }],
			configuration: {
				title: 'Acme Sample',
				properties: {
					'acmeSample.greeting': { type: 'string', default: 'Hello' },
					'acmeSample.enabled': { type: 'boolean', default: true }
				}
			}
		},
		...overrides
	});
}

/** The root manifest of the monorepo, as its upstream writes it. */
export function rootManifest(overrides: Readonly<Record<string, unknown>> = {}): string {
	return JSON.stringify({
		name: 'acme-monorepo',
		private: true,
		packageManager: 'pnpm@9.12.0',
		workspaces: ['packages/*'],
		...overrides
	});
}
