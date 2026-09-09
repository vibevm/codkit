import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Root is the CLI package itself, so `vitest run --root packages/codkit` and a bare
// `vitest run` from here see the same test set (PROP-013 ##TP-RUNNER).
const codkitRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: codkitRoot,
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',
		// Real git and real temp directories; nothing here needs a long leash,
		// but spawning the CLI as a subprocess is slower than an in-process call.
		testTimeout: 30_000
	}
});
