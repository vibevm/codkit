/** @scope spec://codkit/modules/codkit/PROP-007#CMD-VERIFY */
// A file of the fork tree as the pin has it, read from the git objects of the
// tree and never from the working files: the checks against the pin work on a
// dirty tree as well (##CMD-VERIFY), and the surfaces `gen licensing` writes
// take their `expectUpstream` and their component texts from the same place
// (PROP-019 ##GEN-LICENSING).
import { encodeUtf8 } from './bytes.js';
import { runGit } from './gitx.js';
/** The file at the pin, or null when the pin lacks it. */
export function bytesAtPin(treeDir, pinSha, target) {
    const shown = runGit({ args: ['show', `${pinSha}:${target.split('\\').join('/')}`], cwd: treeDir });
    return shown.status === 0 ? encodeUtf8(shown.stdout) : null;
}
