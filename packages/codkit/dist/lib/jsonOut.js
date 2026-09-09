/** @scope spec://codkit/modules/codkit/PROP-012#root */
// The `--json` envelope and the human-readable output channel (PROP-012 sec. 1).
//
// One rule governs everything here: in `--json` mode stdout carries exactly one
// JSON object, printed once, at finish(); every human-readable line goes to
// stderr. In human mode info lines go to stdout and errors/warnings to stderr.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { formatError, formatWarning, serializeErrorPayload } from './messages.js';
export const ENVELOPE_SCHEMA_VERSION = 2;
const defaultStreams = {
    writeOut: (chunk) => {
        process.stdout.write(chunk);
    },
    writeErr: (chunk) => {
        process.stderr.write(chunk);
    }
};
export class Output {
    jsonMode;
    command;
    version;
    streams;
    messages;
    errors;
    roots;
    data;
    projectType;
    finished;
    constructor(options) {
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
    info(text, code) {
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
    diag(text) {
        this.messages.push(makeMessage('info', text, undefined));
        this.write('err', `${text}\n`);
    }
    /** Human-facing warning. Always stderr, in both modes. */
    warn(text, code) {
        this.messages.push(makeMessage('warn', text, code));
        this.write('err', `${formatWarning(text, code)}\n`);
    }
    setRoots(toolRoot, locations) {
        this.roots = {
            tool: { path: toolRoot, source: 'install', exists: true },
            patches: rootEnvelope(locations.patchesDir),
            fork: rootEnvelope(locations.forkDir)
        };
    }
    setToolRoot(toolRoot) {
        this.roots = { ...this.roots, tool: { path: toolRoot, source: 'install', exists: true } };
    }
    setForkTree(path, source) {
        this.roots = {
            ...this.roots,
            fork: { path, source, exists: this.roots.fork?.path === path ? this.roots.fork.exists : false }
        };
    }
    setData(data) {
        this.data = data;
    }
    /** The project type this run resolved; it is carried by every envelope. */
    setProjectType(id) {
        this.projectType = id;
    }
    addError(payload) {
        this.errors.push(payload);
        if (!this.jsonMode) {
            this.write('err', `${formatError(payload)}\n`);
        }
    }
    /**
     * Terminate the command's output. In `--json` mode this is the single point
     * where stdout is written. Calling it twice is a no-op on the second call.
     */
    finish(exitCode) {
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
    buildEnvelope(exitCode) {
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
    write(target, chunk) {
        if (target === 'out') {
            this.streams.writeOut(chunk);
        }
        else {
            this.streams.writeErr(chunk);
        }
    }
}
function makeMessage(level, text, code) {
    const message = { level, text };
    if (code !== undefined) {
        message.code = `CK-W-${code}`;
    }
    return message;
}
const packageManifestSchema = z.object({ version: z.string().min(1) });
const versionCache = new Map();
/** Codkit's version is the version of its installed package manifest. */
export function readCodkitVersion(toolRoot) {
    const cached = versionCache.get(toolRoot);
    if (cached !== undefined) {
        return cached;
    }
    let version = '0.0.0';
    try {
        const raw = JSON.parse(readFileSync(join(toolRoot, 'package.json'), 'utf8'));
        const parsed = packageManifestSchema.safeParse(raw);
        if (parsed.success) {
            version = parsed.data.version;
        }
    }
    catch {
        // A missing or unreadable manifest must not break command output.
    }
    versionCache.set(toolRoot, version);
    return version;
}
function rootEnvelope(resolution) {
    return resolution === null ? null : { path: resolution.path, source: resolution.source, exists: resolution.exists };
}
