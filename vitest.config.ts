import { defineConfig } from 'vitest/config';

// One run over the whole workspace: every package brings its own config, so a
// bare `vitest run` here and `vitest run --root packages/<name>` see the same
// test set (PROP-013 ##TP-RUNNER).
export default defineConfig({
	test: {
		projects: ['packages/*']
	}
});
