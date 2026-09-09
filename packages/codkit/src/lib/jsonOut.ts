/** @scope spec://codkit/modules/codkit/PROP-012#root */
// The `--json` envelope and the human-readable output channel (PROP-012 sec. 1).
//
// One rule governs everything here: in `--json` mode stdout carries exactly one
// JSON object, printed once, at finish(); every human-readable line goes to
// stderr. In human mode info lines go to stdout and errors/warnings to stderr.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CkErrorPayload, PublicErrorPayload, WarningCode } from './messages.ts';
import { formatError, formatWarning, serializeErrorPayload } from './messages.ts';
import type { DirectoryResolution, ResolvedLocations } from './paths.ts';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type EnvelopeMessage = {
	level: 'info' | 'warn';
	code?: string;
	text: string;
};

export type Envelope = {
	/**
	 * `type` is the project type of the patch set this run resolved, or null when
	 * the run has no patch set to read one from (PROP-016 ##TYPE-VERBS-UNIVERSAL:
	 * the roster is universal, and the output names the type where it matters).
	 */
	codkit: { schema: 2; command: string; version: string; type: string | null };
	ok: boolean;
	exitCode: number;
	roots: {
		tool: { path: string; source: 'install'; exists: true };
		patches: RootEnvelope | null;
		fork: RootEnvelope | null;
	};
	data: JsonValue;
	messages: EnvelopeMessage[];
	errors: PublicErrorPayload[];
};

export type RootEnvelope = Pick<DirectoryResolution, 'path' | 'source' | 'exists'>;

/** Injectable sinks so tests can capture output without touching real streams. */
export type OutputStreams = {
	writeOut: (chunk: string) => void;
	writeErr: (chunk: string) => void;
};

export const ENVELOPE_SCHEMA_VERSION = 2;

const defaultStreams: OutputStreams = {
	writeOut: (chunk) => {
		process.stdout.write(chunk);
	},
	writeErr: (chunk) => {
		process.stderr.write(chunk);
	}
};

export class Output {
	readonly jsonMode: boolean;

	private readonly command: string;
	private readonly version: string;
	private readonly streams: OutputStreams;
	private readonly messages: EnvelopeMessage[];
	private readonly errors: CkErrorPayload[];
	private roots: Envelope['roots'];
	private data: JsonValue;
	private projectType: string | null;
	private finished: boolean;

	constructor(options: { command: string; version: string; jsonMode: boolean; streams?: OutputStreams }) {
		this.command = options.command;
		this.version = options.version;
		this.jsonMode = options.jsonMode;
		this.streams = options.streams ?? defaultStreams;
		this.messages = [];
		this.errors = [];
		this.roots = { tool: { path: '', source: 'install', exists: true }, patches: null, fork: null };
		this.data = {};
		this.projectType = null;
		this.finished = false;
	}

	/** Human-facing progress line. Recorded in the envelope as level "info". */
	info(text: string, code?: WarningCode): void {
		this.messages.push(makeMessage('info', text, code));
		// In --json mode all human text is diverted to stderr so that stdout
		// stays a single machine-readable document.
		this.write(this.jsonMode ? 'err' : 'out', `${text}\n`);
	}

	/**
	 * `--verbose` diagnostics. Always stderr, in both modes
	 * (PROP-007 ##CLI-GLOBAL-FLAGS: "--verbose - diagnostics on stderr"), so a
	 * command's answer on stdout stays the answer, whatever the verbosity.
	 */
	diag(text: string): void {
		this.messages.push(makeMessage('info', text, undefined));
		this.write('err', `${text}\n`);
	}

	/** Human-facing warning. Always stderr, in both modes. */
	warn(text: string, code?: WarningCode): void {
		this.messages.push(makeMessage('warn', text, code));
		this.write('err', `${formatWarning(text, code)}\n`);
	}

	setRoots(toolRoot: string, locations: ResolvedLocations): void {
		this.roots = {
			tool: { path: toolRoot, source: 'install', exists: true },
			patches: rootEnvelope(locations.patchesDir),
			fork: rootEnvelope(locations.forkDir)
		};
	}

	setToolRoot(toolRoot: string): void {
		this.roots = { ...this.roots, tool: { path: toolRoot, source: 'install', exists: true } };
	}

	setForkTree(path: string, source: DirectoryResolution['source']): void {
		this.roots = {
			...this.roots,
			fork: { path, source, exists: this.roots.fork?.path === path ? this.roots.fork.exists : false }
		};
	}

	setData(data: JsonValue): void {
		this.data = data;
	}

	/** The project type this run resolved; it is carried by every envelope. */
	setProjectType(id: string | null): void {
		this.projectType = id;
	}

	addError(payload: CkErrorPayload): void {
		this.errors.push(payload);
		if (!this.jsonMode) {
			this.write('err', `${formatError(payload)}\n`);
		}
	}

	/**
	 * Terminate the command's output. In `--json` mode this is the single point
	 * where stdout is written. Calling it twice is a no-op on the second call.
	 */
	finish(exitCode: number): number {
		if (this.finished) {
			return exitCode;
		}
		this.finished = true;
		if (this.jsonMode) {
			// Errors were withheld from stderr in json mode; surface them now so
			// that a human watching a piped run still sees what went wrong.
			for (const error of this.errors) {
				this.write('err', `${formatError(error)}\n`);
			}
			this.write('out', `${JSON.stringify(this.buildEnvelope(exitCode), null, 2)}\n`);
		}
		return exitCode;
	}

	/** The envelope as it would be serialized; exposed for tests. */
	buildEnvelope(exitCode: number): Envelope {
		return {
			codkit: {
				schema: ENVELOPE_SCHEMA_VERSION,
				command: this.command,
				version: this.version,
				type: this.projectType
			},
			ok: exitCode === 0,
			exitCode,
			roots: this.roots,
			data: this.data,
			messages: this.messages,
			errors: this.errors.map((error) => serializeErrorPayload(error))
		};
	}

	private write(target: 'out' | 'err', chunk: string): void {
		if (target === 'out') {
			this.streams.writeOut(chunk);
		} else {
			this.streams.writeErr(chunk);
		}
	}
}

function makeMessage(level: 'info' | 'warn', text: string, code: WarningCode | undefined): EnvelopeMessage {
	const message: { level: 'info' | 'warn'; code?: string; text: string } = { level, text };
	if (code !== undefined) {
		message.code = `CK-W-${code}`;
	}
	return message;
}

const packageManifestSchema = z.object({ version: z.string().min(1) });

const versionCache = new Map<string, string>();

/** Codkit's version is the version of its installed package manifest. */
export function readCodkitVersion(toolRoot: string): string {
	const cached = versionCache.get(toolRoot);
	if (cached !== undefined) {
		return cached;
	}
	let version = '0.0.0';
	try {
		const raw: unknown = JSON.parse(readFileSync(join(toolRoot, 'package.json'), 'utf8'));
		const parsed = packageManifestSchema.safeParse(raw);
		if (parsed.success) {
			version = parsed.data.version;
		}
	} catch {
		// A missing or unreadable manifest must not break command output.
	}
	versionCache.set(toolRoot, version);
	return version;
}

function rootEnvelope(resolution: DirectoryResolution | null): RootEnvelope | null {
	return resolution === null ? null : { path: resolution.path, source: resolution.source, exists: resolution.exists };
}
