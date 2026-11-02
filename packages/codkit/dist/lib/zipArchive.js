/** @scope spec://codkit/modules/codkit/PROP-008#BUNDLES-LOAD */
// Reading a zip archive the way the bundles need it (PROP-008 ##BUNDLES-LOAD):
// the hash of the whole file, one entry read on its own, and the regular files
// under one root of the archive unpacked into a directory. The entries are
// found through the central directory at the end of the archive, which states
// where the data of each entry begins and how long it is; that exact range is
// read in chunks and inflated through fflate, so a large archive never sits in
// memory at once, and only the entries that are wanted are read. A reader that
// streams the archive from its start has to find the end of an entry written
// with a data descriptor by the descriptor's signature, and compressed bytes
// carry those four bytes by chance (finding of 2026-11-02: an executable of
// 47 MB in a per-target archive), so the central directory is the only map.
//
// A name the archive carries is data, not a path: an absolute name, a `..` or
// a `.git` segment, a backslash, a link or an entry that is not a regular file
// refuses the whole archive before anything of it is kept, and so does an
// entry the reader cannot inflate or whose size or CRC-32 differs from what
// the central directory states.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { Inflate } from 'fflate';
/**
 * The version of what `extractZip` writes, which the stamp of a bundle cache
 * records (PROP-006 ##BUNDLES-STAMP): 2 keeps the executable bit of an entry;
 * the unpacker before it, which recorded no version, wrote every file 644.
 */
export const EXTRACT_VERSION = 2;
const CHUNK = 1 << 20;
/** Compressed bytes per push: deflate expands about a thousandfold at most, so what one push hands back stays bounded. */
const INFLATE_CHUNK = 1 << 16;
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_DIRECTORY = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const LOCAL_LENGTH = 30;
const CENTRAL_LENGTH = 46;
const END_LENGTH = 22;
const ZIP64_END_LENGTH = 56;
const ZIP64_LOCATOR_LENGTH = 20;
/** The value of a 32-bit or 16-bit slot whose value stands in the ZIP64 records instead. */
const ALL_ONES_32 = 0xffffffff;
const ALL_ONES_16 = 0xffff;
/** Why an entry name cannot be a path under the destination, or null when it can. */
export function zipEntryPathProblem(name) {
    if (name === '')
        return 'is empty';
    if (name.includes('\\'))
        return 'contains a backslash';
    if (name.startsWith('/') || /^[A-Za-z]:/u.test(name))
        return 'is absolute';
    if (/[\u0000-\u001f\u007f]/u.test(name))
        return 'contains a control character';
    const segments = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
        return 'has an empty, dot or dot-dot segment';
    if (segments.some((segment) => segment.toLowerCase() === '.git'))
        return 'has a .git segment';
    return null;
}
/** Read exactly `length` bytes at `position` into the start of `buffer`; an archive that ends sooner is damaged. */
function fill(fd, buffer, length, position) {
    for (let done = 0; done < length;) {
        const read = readSync(fd, buffer, done, length - done, position + done);
        if (read <= 0)
            throw new Error('the archive ends inside one of its records');
        done += read;
    }
}
function readAt(fd, length, position) {
    const buffer = Buffer.alloc(length);
    fill(fd, buffer, length, position);
    return buffer;
}
function uint64(buffer, offset) {
    const value = buffer.readBigUInt64LE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error('the archive states a ZIP64 size or offset beyond what the reader can address');
    return Number(value);
}
/** The data of the extra field `id`, or null when the extra carries none. */
function extraField(extra, id) {
    for (let at = 0; at + 4 <= extra.length;) {
        const length = extra.readUInt16LE(at + 2);
        if (extra.readUInt16LE(at) === id)
            return extra.subarray(at + 4, Math.min(extra.length, at + 4 + length));
        at += 4 + length;
    }
    return null;
}
/** Where the central directory is and how many entries it holds, from its end record - the ZIP64 one when that record defers to it. */
function directoryBounds(fd, size) {
    // The end record is the last thing in the archive but its comment, of at most 65535 bytes.
    const tailLength = Math.min(size, END_LENGTH + 0xffff);
    const tailStart = size - tailLength;
    const tail = readAt(fd, tailLength, tailStart);
    let at = -1;
    for (let index = tailLength - END_LENGTH; index >= 0; index -= 1) {
        if (tail.readUInt32LE(index) === END_OF_DIRECTORY && index + END_LENGTH + tail.readUInt16LE(index + 20) === tailLength) {
            at = index;
            break;
        }
    }
    if (at < 0)
        throw new Error('the archive has no end of central directory record');
    const disks = tail.readUInt16LE(at + 4) + tail.readUInt16LE(at + 6);
    const count = tail.readUInt16LE(at + 10);
    const length = tail.readUInt32LE(at + 12);
    const offset = tail.readUInt32LE(at + 16);
    const locatorAt = tailStart + at - ZIP64_LOCATOR_LENGTH;
    const deferred = count === ALL_ONES_16 || length === ALL_ONES_32 || offset === ALL_ONES_32;
    const locator = deferred && locatorAt >= 0 ? readAt(fd, ZIP64_LOCATOR_LENGTH, locatorAt) : null;
    if (locator === null || locator.readUInt32LE(0) !== ZIP64_LOCATOR) {
        if (disks !== 0)
            throw new Error('the archive spans several disks');
        return { count, offset, length };
    }
    const record = readAt(fd, ZIP64_END_LENGTH, uint64(locator, 8));
    if (record.readUInt32LE(0) !== ZIP64_END_OF_DIRECTORY)
        throw new Error('the ZIP64 end of central directory record is not where its locator puts it');
    if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0)
        throw new Error('the archive spans several disks');
    return { count: uint64(record, 32), length: uint64(record, 40), offset: uint64(record, 48) };
}
function centralEntry(directory, at, nameLength, extraLength) {
    const flags = directory.readUInt16LE(at + 8);
    const rawName = directory.subarray(at + CENTRAL_LENGTH, at + CENTRAL_LENGTH + nameLength);
    // Bit 11 says the name is UTF-8; without it a byte is a character, as fflate reads it.
    const name = rawName.toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1');
    let compressedSize = directory.readUInt32LE(at + 20);
    let size = directory.readUInt32LE(at + 24);
    let disk = directory.readUInt16LE(at + 34);
    let headerOffset = directory.readUInt32LE(at + 42);
    if (size === ALL_ONES_32 || compressedSize === ALL_ONES_32 || headerOffset === ALL_ONES_32 || disk === ALL_ONES_16) {
        // The ZIP64 extended information holds, in this order, the values whose slot is all ones.
        const extra = directory.subarray(at + CENTRAL_LENGTH + nameLength, at + CENTRAL_LENGTH + nameLength + extraLength);
        const zip64 = extraField(extra, 0x0001);
        if (zip64 === null)
            throw new Error(`the archive entry ${JSON.stringify(name)} has no ZIP64 extended information for its sizes`);
        let field = 0;
        const take = (bytes) => {
            if (field + bytes > zip64.length)
                throw new Error(`the ZIP64 extended information of the archive entry ${JSON.stringify(name)} is short`);
            const value = bytes === 8 ? uint64(zip64, field) : zip64.readUInt32LE(field);
            field += bytes;
            return value;
        };
        if (size === ALL_ONES_32)
            size = take(8);
        if (compressedSize === ALL_ONES_32)
            compressedSize = take(8);
        if (headerOffset === ALL_ONES_32)
            headerOffset = take(8);
        if (disk === ALL_ONES_16)
            disk = take(4);
    }
    if (disk !== 0)
        throw new Error('the archive spans several disks');
    // The upper byte of "version made by" names the system: on Unix (3) and on
    // macOS (19) the upper half of the external attributes is the file's mode.
    const system = directory.readUInt8(at + 5);
    return {
        name,
        rawName,
        flags,
        method: directory.readUInt16LE(at + 10),
        crc: directory.readUInt32LE(at + 16),
        compressedSize,
        size,
        headerOffset,
        unixMode: system === 3 || system === 19 ? directory.readUInt32LE(at + 38) >>> 16 : 0
    };
}
/** Open the archive and read its central directory; the descriptor is the caller's to close. */
function openArchive(archivePath) {
    const fd = openSync(archivePath, 'r');
    try {
        // fflate reads past anything that is not a zip without a word; the
        // signature every zip opens with is checked here instead.
        const head = Buffer.alloc(4);
        if (readSync(fd, head, 0, 4, 0) < 4 || head[0] !== 0x50 || head[1] !== 0x4b) {
            throw new Error('the file does not open with the PK signature of a zip archive');
        }
        const size = fstatSync(fd).size;
        const bounds = directoryBounds(fd, size);
        if (bounds.offset + bounds.length > size)
            throw new Error('the central directory runs past the end of the archive');
        const directory = readAt(fd, bounds.length, bounds.offset);
        const entries = [];
        for (let index = 0, at = 0; index < bounds.count; index += 1) {
            const damaged = () => new Error(`the central directory of the archive is damaged at its entry ${index + 1} of ${bounds.count}`);
            if (at + CENTRAL_LENGTH > directory.length || directory.readUInt32LE(at) !== CENTRAL_HEADER)
                throw damaged();
            const nameLength = directory.readUInt16LE(at + 28);
            const extraLength = directory.readUInt16LE(at + 30);
            const next = at + CENTRAL_LENGTH + nameLength + extraLength + directory.readUInt16LE(at + 32);
            if (next > directory.length)
                throw damaged();
            entries.push(centralEntry(directory, at, nameLength, extraLength));
            at = next;
        }
        return { fd, entries, directoryOffset: bounds.offset };
    }
    catch (error) {
        closeSync(fd);
        throw error;
    }
}
/** Why an entry is neither a regular file nor a directory, or null when it is one. */
function kindProblem(entry) {
    const kind = entry.unixMode & 0o170000;
    if (kind === 0o120000)
        return 'is a symbolic link';
    if (entry.name.endsWith('/'))
        return kind === 0 || kind === 0o040000 ? null : 'is not a directory';
    if (kind !== 0 && kind !== 0o100000)
        return 'is not a regular file';
    return null;
}
/** Why the data of an entry cannot be read, or null when it can. */
function dataProblem(entry) {
    if ((entry.flags & 0x1) !== 0)
        return 'is encrypted';
    if (entry.method !== 0 && entry.method !== 8)
        return `is compressed with method ${entry.method}, which the reader does not inflate`;
    if (entry.method === 0 && entry.compressedSize !== entry.size)
        return 'is stored, and the central directory states two sizes for it';
    return null;
}
/** Hand the bytes of one entry to `sink` chunk by chunk, read from the exact range the central directory gives. */
function readEntry(archive, entry, sink) {
    const label = `the archive entry ${JSON.stringify(entry.name)}`;
    const problem = dataProblem(entry);
    if (problem !== null)
        throw new Error(`${label} ${problem}`);
    const header = readAt(archive.fd, LOCAL_LENGTH, entry.headerOffset);
    if (header.readUInt32LE(0) !== LOCAL_HEADER)
        throw new Error(`${label} has no local header where the central directory puts it`);
    const nameLength = header.readUInt16LE(26);
    if (!readAt(archive.fd, nameLength, entry.headerOffset + LOCAL_LENGTH).equals(entry.rawName)) {
        throw new Error(`${label} has a local header that names another entry`);
    }
    // The local extra field need not be as long as the central one: the data
    // begins after the local header's own.
    let position = entry.headerOffset + LOCAL_LENGTH + nameLength + header.readUInt16LE(28);
    const end = position + entry.compressedSize;
    if (end > archive.directoryOffset)
        throw new Error(`${label} runs into the central directory`);
    let crc = 0;
    let size = 0;
    const take = (chunk) => {
        size += chunk.byteLength;
        if (size > entry.size)
            throw new Error(`${label} inflates to more than the ${entry.size} bytes the central directory states`);
        crc = crc32(chunk, crc);
        if (chunk.byteLength > 0)
            sink(chunk);
    };
    const inflater = entry.method === 8 && entry.compressedSize > 0 ? new Inflate((chunk) => take(chunk)) : null;
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(entry.compressedSize, inflater === null ? CHUNK : INFLATE_CHUNK)));
    while (position < end) {
        const length = Math.min(buffer.length, end - position);
        fill(archive.fd, buffer, length, position);
        position += length;
        const chunk = new Uint8Array(buffer.buffer, buffer.byteOffset, length);
        if (inflater === null)
            take(chunk);
        else
            inflater.push(chunk, position === end);
    }
    if (size !== entry.size)
        throw new Error(`${label} inflates to ${size} bytes, and the central directory states ${entry.size}`);
    if (crc !== entry.crc)
        throw new Error(`${label} fails its CRC-32 check`);
}
function writeAll(fd, chunk) {
    for (let done = 0; done < chunk.byteLength;)
        done += writeSync(fd, chunk, done, chunk.byteLength - done);
}
/** The sha256 of the bytes behind a descriptor, read from the start, and their count. */
function hashOf(fd) {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(CHUNK);
    let bytes = 0;
    for (;;) {
        const read = readSync(fd, buffer, 0, CHUNK, bytes);
        if (read <= 0)
            break;
        hash.update(buffer.subarray(0, read));
        bytes += read;
    }
    return { sha256: hash.digest('hex'), bytes };
}
/** The sha256 of a file, and its size. */
export function hashFile(path) {
    const fd = openSync(path, 'r');
    try {
        return hashOf(fd);
    }
    finally {
        closeSync(fd);
    }
}
/** The bytes of one entry of the archive, or null when there is no such entry; nothing else is inflated. */
export function readZipEntry(archivePath, entryName) {
    const archive = openArchive(archivePath);
    try {
        const matching = archive.entries.filter((entry) => entry.name === entryName);
        const entry = matching[0];
        if (entry === undefined)
            return null;
        if (matching.length > 1)
            throw new Error(`the archive entry ${JSON.stringify(entryName)} occurs more than once`);
        const parts = [];
        readEntry(archive, entry, (chunk) => {
            parts.push(Buffer.from(chunk));
        });
        return Buffer.concat(parts);
    }
    finally {
        closeSync(archive.fd);
    }
}
/**
 * Unpack the regular files under `root` of the archive into `destination`, each
 * at its path without the root, with the mode 755 when the archive marks it
 * executable and 644 otherwise: the build of a distribution packs the files
 * with the modes it finds, and an executable of a unit must stay one. The
 * destination is created; what is already there is overwritten file by file.
 */
export function extractZip(archivePath, options) {
    const root = options.root;
    const archive = openArchive(archivePath);
    try {
        const seen = new Set();
        const wanted = [];
        for (const entry of archive.entries) {
            const problem = zipEntryPathProblem(entry.name) ?? kindProblem(entry) ?? (seen.has(entry.name) ? 'occurs more than once' : null);
            if (problem !== null)
                throw new Error(`the archive entry ${JSON.stringify(entry.name)} ${problem}`);
            seen.add(entry.name);
            if (!entry.name.startsWith(root) || entry.name === root || entry.name.endsWith('/'))
                continue;
            const unreadable = dataProblem(entry);
            if (unreadable !== null)
                throw new Error(`the archive entry ${JSON.stringify(entry.name)} ${unreadable}`);
            wanted.push({ entry, relative: entry.name.slice(root.length) });
        }
        mkdirSync(options.destination, { recursive: true });
        for (const { entry, relative } of wanted) {
            const target = join(options.destination, ...relative.split('/'));
            mkdirSync(dirname(target), { recursive: true });
            const out = openSync(target, 'w', (entry.unixMode & 0o111) === 0 ? 0o644 : 0o755);
            try {
                readEntry(archive, entry, (chunk) => {
                    writeAll(out, chunk);
                });
            }
            finally {
                closeSync(out);
            }
        }
        // The hash is of the bytes as they are once every entry is read, so an
        // archive that changed while it was unpacked hashes to something else than
        // the record the caller holds.
        return { ...hashOf(archive.fd), files: wanted.length };
    }
    finally {
        closeSync(archive.fd);
    }
}
