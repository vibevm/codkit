/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-CONTAINERS */
// The one door between the image pipeline and the containers it works in.
//
// The engine owns the orchestration - discovery, the masters, the render, the
// round trip, the report - and knows no container by name (PROP-016
// ##TYPE-ENGINE-IS-BLIND). It takes the `kind` a target declares, asks the
// project type for the codec of that kind, and every question about the file
// goes through that codec.
//
// A codec refuses a file it cannot read with the contract's refusal, which
// carries a detail and a hint but no error code - the registry of codes is the
// engine's (PROP-012). `readingImage` is where such a refusal becomes the
// tool's own `CK-E-ARTIFACT-BROKEN`, naming the file that was being read.
import { isBrokenArtifact } from '@codkit/type-api';
import { ckError } from './messages.js';
/** The codec of a target's container, as the project type answers it. */
export function codecFor(type, kind) {
    const codec = type.brandImages?.codecs.find((candidate) => candidate.kind === kind);
    if (codec === undefined) {
        throw ckError('ARTIFACT-BROKEN', `the project type ${type.id} declares an image target of kind ${kind} and no codec that reads it`, 'every kind named by the target table must have a codec of the same kind');
    }
    return codec;
}
/**
 * Run a read or a write of one image file, turning a refusal of the container
 * into the diagnosed error of the tool. Anything else propagates untouched: a
 * defect of the engine must not arrive dressed as a broken artifact.
 */
export function readingImage(file, run) {
    try {
        return run();
    }
    catch (error) {
        if (!isBrokenArtifact(error)) {
            throw error;
        }
        throw ckError('ARTIFACT-BROKEN', `${file}: ${error.message}`, error.hint);
    }
}
/**
 * The article a container name takes when it is read out letter by letter: it
 * is "an ICO" and "an SVG" but "a PNG", because what the reader hears is the
 * name of the first letter and not the letter itself.
 */
export function articleFor(kind) {
    const letter = kind.slice(0, 1).toUpperCase();
    return 'AEFHILMNORSX'.includes(letter) ? 'an' : 'a';
}
