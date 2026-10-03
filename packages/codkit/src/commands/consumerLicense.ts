/** @scope spec://codkit/modules/codkit/PROP-019#CONSUMER-LICENSE-CLI */
// Explicit profile selection; the patchset cannot select a policy directory.
import { resolve } from 'node:path';
import type { CommandDefinition } from '../lib/command.ts';
import { commandFlagValue, EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, patchesRoot } from '../lib/command.ts';
import { checkConsumerLicenses } from '../lib/consumerLicenseCheck.ts';
import { organizationPolicyRoot, readOrganizationPolicy } from '../lib/organizationPolicyStore.ts';
import { ckError } from '../lib/messages.ts';

export const consumerLicenseCheckCommand: CommandDefinition = {
	name: 'license consumer-check',
	summary: 'check consumer source against a trusted organization profile',
	configMode: 'none',
	roots: 'patches',
	maxArgs: 1,
	commandFlags: ['--profile'],
	async run(ctx) {
		const source = ctx.args[0];
		const profile = commandFlagValue(ctx.commandFlags, '--profile');
		if (source === undefined || profile === null)
			throw ckError('CONFIG', 'consumer-check requires a source directory and --profile', 'license consumer-check <dir> --profile <id>');
		const selected = readOrganizationPolicy(organizationPolicyRoot(), patchesRoot(ctx), { profile });
		if (!selected.ok) {
			for (const message of selected.problems)
				ctx.out.addError({
					code: 'CONFIG',
					message,
					hint: 'install or repair the approved profile in ~/.codkit/organization-policies.json'
				});
			return EXIT_ENVIRONMENT;
		}
		const report = checkConsumerLicenses(resolve(source), selected.value);
		for (const problem of report.problems)
			ctx.out.addError({
				code: 'LICENSE-PACKAGE',
				file: problem.file,
				message: problem.message,
				hint: 'fix consumer declarations under the selected profile'
			});
		ctx.out.info(`${report.checked.length} consumer files checked, ${report.problems.length} problems`);
		ctx.out.setData(report);
		return report.status === 'complete' ? EXIT_OK : EXIT_CHECK_FAILED;
	}
};
