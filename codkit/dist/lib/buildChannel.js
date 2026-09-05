/** @scope spec://codkit/modules/codkit/PROP-010#DAEMON-RUNTIME-CONTAINMENT */
// Build channel namespace: one portable, collision-free filename vocabulary.
import { ckError } from './messages.js';
import { safeBasenameProblem } from './pathSafety.js';
const RESERVED = new Set(['all', 'deps-hash']);
const PORTABLE_COMPONENT_BYTES = 255;
const CANDIDATE_FIXED_BYTES = Buffer.byteLength('..json..candidate') + 36;
export function asciiFoldChannel(channel) {
    return channel.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
export function validateChannelName(channel) {
    const problem = safeBasenameProblem(channel);
    const folded = asciiFoldChannel(channel);
    const candidateBytes = Buffer.byteLength(channel, 'utf8') + CANDIDATE_FIXED_BYTES;
    const detail = problem ??
        (RESERVED.has(folded) ? `reserved build runtime name ${JSON.stringify(folded)}` : null) ??
        (candidateBytes > PORTABLE_COMPONENT_BYTES
            ? `candidate/temp filename is ${candidateBytes} UTF-8 bytes, above portable component limit ${PORTABLE_COMPONENT_BYTES}`
            : null);
    if (detail !== null) {
        throw ckError('CONFIG', `unsafe build channel name ${JSON.stringify(channel)}: ${detail}`, 'channel keys must be unique portable basenames and become direct children of .codkit/build', 'codkit/config/build-watch.json');
    }
}
export function validateChannelSet(channels) {
    const seen = new Map();
    for (const channel of channels) {
        validateChannelName(channel);
        const folded = asciiFoldChannel(channel);
        const prior = seen.get(folded);
        if (prior !== undefined) {
            throw ckError('CONFIG', `build channel names ${JSON.stringify(prior)} and ${JSON.stringify(channel)} collide after ASCII case folding`, 'rename one channel; runtime .json/.log/.log.1 names must be unique on case-insensitive filesystems', 'codkit/config/build-watch.json');
        }
        seen.set(folded, channel);
    }
}
