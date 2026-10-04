/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-MATERIAL-V2 */
// Resolve only committed attributes in an isolated oracle; no local attribute authority.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { lfsContentOf } from './publishLfs.js';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
import { hashContainedFile } from './containedFile.js';
export function savedMaterialLfs(common, commit, wanted) {
    const parent = realpathSync(tmpdir());
    const scratch = mkdtempSync(join(parent, 'codkit-material-lfs-'));
    try {
        const result = runGit({ cwd: common, args: ['--git-dir', common, 'rev-parse', `${commit}^{tree}`] });
        if (result.status !== 0)
            throw ckError('CONFIG', 'saved workspace material tree is unavailable');
        const files = lfsContentOf({ treeDir: common, scratchDir: scratch, tree: result.stdout.trim() });
        const pointers = new Map();
        for (const file of files) {
            if (!wanted.includes(file.path))
                continue;
            if (file.pointer === null)
                throw ckError('CONFIG', 'saved LFS material has an invalid pointer');
            const oid = file.pointer.oid;
            const backing = hashContainedFile(common, `lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`, {
                what: 'saved workspace LFS backing object'
            });
            if (backing.state !== 'ok' || backing.sha256 !== oid || backing.bytes !== file.pointer.size)
                throw ckError('LFS', 'saved workspace LFS backing object is missing or changed');
            pointers.set(file.path, file.pointer);
        }
        return pointers;
    }
    finally {
        if (dirname(scratch) !== parent || realpathSync(scratch) !== scratch)
            throw ckError('CONFIG', 'material attribute scratch custody moved; refusing cleanup');
        rmSync(scratch, { recursive: true, force: true });
    }
}
