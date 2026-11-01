import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Root is this package itself, so `vitest run --root packages/type-vscode-extension`
// and a bare `vitest run` from here see the same test set (PROP-013 ##TP-RUNNER).
const packageRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: packageRoot,
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node'
	}
});
