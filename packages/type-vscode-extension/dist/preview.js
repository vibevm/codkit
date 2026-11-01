/** @scope spec://codkit/modules/vscode-extension/PROP-004#VSX-PREVIEW-MODES */
// Area 11: how a person looks at an extension.
//
// Two modes (##VSX-PREVIEW-MODES): `development` runs the extension from the
// loaded tree through the extension development host, `artifact` installs the
// packaged `.vsix` into an isolated profile and opens the host on it. The host
// is `code` by default, the command-line entry of the editor found on PATH
// (##VSX-PREVIEW-HOST); the engine resolves it and hands it over. Every launch
// and every preparation carries both isolation directories as whole arguments
// under the state directory the engine hands over, so that the person's own
// profile is never touched (##VSX-PREVIEW-ISOLATION). The type spawns nothing.
import { isAbsolute, join } from 'node:path';
import { packageBuildOf } from './build.js';
/** ##VSX-PREVIEW-MODES, in the order they are listed to a person. */
export const PREVIEW_MODES = ['development', 'artifact'];
export const DEFAULT_PREVIEW_MODE = 'development';
/** ##VSX-PREVIEW-HOST: the command-line entry of the editor. */
export const DEFAULT_PREVIEW_HOST = 'code';
/** The two isolation directories under the state directory of a mode. */
export const USER_DATA_DIR = 'user-data';
export const EXTENSIONS_DIR = 'extensions';
/** ##VSX-PREVIEW-ISOLATION: both directories, built from the engine's state directory. */
export function isolationOf(stateDir) {
    return { userDataDir: join(stateDir, USER_DATA_DIR), extensionsDir: join(stateDir, EXTENSIONS_DIR) };
}
/** The two isolation flags, as whole arguments. */
function isolationArgs(isolation) {
    return ['--user-data-dir', isolation.userDataDir, '--extensions-dir', isolation.extensionsDir];
}
/**
 * The folder the host opens: the one the run named, else the one the
 * configuration names as the default, resolved against the tree when it is
 * tree-relative, else none.
 */
// REVIEW: `typeConfig.preview.workspace` is applied here when the request names
// no folder, because the contract hands the type no other place to answer the
// default the field declares; the host of the same section is read by the
// engine's resolution order and is not the recipe's to apply.
export function workspaceOf(config, request) {
    if (request.workspaceDir !== null) {
        return request.workspaceDir;
    }
    const configured = config.preview?.workspace ?? null;
    if (configured === null) {
        return null;
    }
    return isAbsolute(configured) ? configured : join(request.treeDir, ...configured.split('/'));
}
function launchOf(host, args, workspace) {
    return { command: host, args: workspace === null ? args : [...args, workspace] };
}
/**
 * ##VSX-PREVIEW-DEVELOPMENT: the family's build first, so the bundle the host
 * loads is current; then the host with the extension root as its development
 * path, the two isolation directories, a new window and the workspace when
 * one is given.
 */
export function developmentRecipe(config, request) {
    const isolation = isolationOf(request.stateDir);
    const extensionPath = join(request.treeDir, ...config.extensionRoot.split('/'));
    return {
        prepare: packageBuildOf(config),
        needsArtifact: false,
        launch: launchOf(request.host, [`--extensionDevelopmentPath=${extensionPath}`, ...isolationArgs(isolation), '--new-window'], workspaceOf(config, request)),
        isolation
    };
}
/**
 * ##VSX-PREVIEW-ARTIFACT: the distributable is needed, so the engine builds it
 * first and hands the newest match of the package outputs; the preparation
 * installs it into the isolated profile and exits, and the launch opens the
 * host on the same two directories.
 */
// REVIEW: a request of this mode that carries no artifact yet - the engine
// asks the recipe before it knows that the mode needs one - prepares nothing
// and keeps `needsArtifact` true, so the answer stays total; the install
// command appears once the artifact is handed over.
export function artifactRecipe(config, request) {
    const isolation = isolationOf(request.stateDir);
    const install = request.artifact === null
        ? []
        : [
            {
                label: 'install extension',
                command: request.host,
                args: [
                    '--install-extension',
                    request.artifact,
                    '--extensions-dir',
                    isolation.extensionsDir,
                    '--user-data-dir',
                    isolation.userDataDir,
                    '--force'
                ]
            }
        ];
    return {
        prepare: install,
        needsArtifact: true,
        launch: launchOf(request.host, [...isolationArgs(isolation), '--new-window'], workspaceOf(config, request)),
        isolation
    };
}
export function makePreview(config) {
    return {
        modes: PREVIEW_MODES,
        defaultMode: DEFAULT_PREVIEW_MODE,
        defaultHost: DEFAULT_PREVIEW_HOST,
        // Total over the declared modes: the engine refuses an unknown mode before
        // it asks, and anything that is not the artifact mode is the default one.
        recipe: (request) => (request.mode === 'artifact' ? artifactRecipe(config, request) : developmentRecipe(config, request))
    };
}
