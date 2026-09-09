/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-CONFIG-FIELD */
// The schema of `typeConfig` for the `theia` type.
//
// Most of what this type answers is a constant of the family: the tag shape,
// the fingerprints, the cleanup whitelist, the forbidden targets, the install,
// the lint, the runners, the advisory readers. Four things it cannot know,
// because upstream does not have them - a Theia monorepo ships no product of
// its own:
//
//   * where the own package sits in the workspace (`ownRoot`);
//   * what the own package is called, since `lerna --scope` selects a package by
//     its npm name and not by its directory (`ownPackageName`);
//   * which directory holds the application whose `package.json` is the overlay
//     target and whose bundle is the package build (`applicationRoot`);
//   * which npm scripts of the tree root start the two watch channels
//     (`watchScripts`), because a fork writes those scripts itself.
//
// The engine validates the universal fields of `codkit.json` and hands this the
// rest; a refusal becomes `CK-E-CONFIG` naming the field.
import { z } from 'zod';
import { ownRootProblem } from './layout.js';
/** A repository-relative POSIX directory: no escape, no leading or trailing slash. */
const treeDirectorySchema = z
    .string()
    .min(1)
    .refine((value) => !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'), { message: 'must be a directory from the tree root, POSIX, without a leading or trailing slash, a backslash or a dot-dot segment' });
/** An npm package name, scoped or plain. */
const packageNameSchema = z
    .string()
    .min(1)
    .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u, { message: 'must be an npm package name, e.g. @acme/theia-product' });
export const configSchema = z
    .object({
    /** ##THEIA-OWN-ROOT: a workspace package directory of the monorepo. */
    ownRoot: z
        .string()
        .min(1)
        .superRefine((value, context) => {
        const problem = ownRootProblem(value);
        if (problem !== null) {
            context.addIssue({ code: 'custom', message: problem });
        }
    }),
    /**
     * The npm name of the own package, as its `package.json` carries it.
     * `lerna run <script> --scope <name>` is how this family selects one
     * package, so lint and tests of the own root need the name and not the
     * path (##THEIA-LINT, ##THEIA-TEST-RUNNERS).
     */
    ownPackageName: packageNameSchema,
    /**
     * ##THEIA-APPLICATION-ROOT: the application directory, as it exists at
     * the pin. Its `package.json` is the overlay target that carries the
     * whole product model of this family, and an overlay edits a file
     * upstream ships - so a product forks one of upstream's example
     * applications and points this at it.
     */
    applicationRoot: treeDirectorySchema,
    /**
     * ##THEIA-BUILD-CHANNELS: the npm scripts of the tree root that start
     * `tsc -b -w` and `theia build --watch`. Upstream's own root scripts
     * start both watchers of one example application at once; a fork writes
     * one script per channel, so that `build up|down|status|errors` can talk
     * about them separately.
     */
    watchScripts: z
        .object({
        typecheck: z.string().min(1).optional(),
        bundle: z.string().min(1).optional()
    })
        .strict()
        .optional()
})
    .strict();
/** The configuration of a patch set that declared nothing yet; see `projectType`. */
export const PLACEHOLDER_CONFIG = {
    ownRoot: 'packages/own',
    ownPackageName: '@own/theia-product',
    applicationRoot: 'applications/own'
};
