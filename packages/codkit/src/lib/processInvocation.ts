/** @scope spec://codkit/modules/codkit/PROP-011#root */

export type ProcessInvocation = {
	readonly command: string;
	readonly args: readonly string[];
};

/**
 * Node cannot execute Windows batch launchers directly with `shell: false`.
 * Route only those launchers through cmd.exe; native executables and every
 * non-Windows platform keep the direct argv-preserving path.
 */
export function processInvocation(
	command: string,
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
	comspec: string | undefined = process.env['ComSpec']
): ProcessInvocation {
	if (platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(command)) {
		return { command, args };
	}
	return {
		command: comspec ?? 'cmd.exe',
		args: ['/d', '/s', '/c', command, ...args]
	};
}
