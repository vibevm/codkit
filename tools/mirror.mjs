#!/usr/bin/env node
// Thin maintainer surface; the Git fan-out lives in the library and is tested offline.
import { resolve } from 'node:path';
import { mirrorRepository } from './lib/mirror.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
	console.log('Usage: npm run mirror -- [--check | --from github|gitverse]');
} else {
	try {
		const check = args.length === 1 && args[0] === '--check';
		const from = args.length === 2 && args[0] === '--from' ? args[1] : undefined;
		if (args.length !== 0 && !check && from === undefined) throw new Error('Expected --check or --from NAME; see --help');
		const result = mirrorRepository(resolve(import.meta.dirname, '..'), { check, from, log: console.log });
		process.exitCode = result.exitCode;
	} catch (error) {
		console.error(`mirror: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
