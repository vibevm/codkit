/** @scope spec://codkit/modules/codkit/PROP-011#root */
/**
 * Node cannot execute Windows batch launchers directly with `shell: false`.
 * Route only those launchers through cmd.exe; native executables and every
 * non-Windows platform keep the direct argv-preserving path.
 */
export function processInvocation(command, args, platform = process.platform, comspec = process.env['ComSpec']) {
    if (platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(command)) {
        return { command, args };
    }
    return {
        command: comspec ?? 'cmd.exe',
        args: ['/d', '/s', '/c', command, ...args]
    };
}
