/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-CONFIGURED */
// Specializing a project type for the patch set that declared it.
//
// Most types answer the same thing for every patch set. A type whose answers
// live in `typeConfig` - which overlay targets exist, which commands build the
// tree, whether there are compile channels at all - cannot: its capabilities
// and its areas are a function of that section. Such a type answers `configure`
// and the engine asks the result everything afterwards, so no engine below ever
// learns that a type has a configuration at all.
//
// The result is a project type in its own right and is held to the same shape:
// it must answer its own contract, and it may declare only capabilities the
// unconfigured type named as its own or as configurable - otherwise
// `codkit types`, which runs without a patch set, would be printing a matrix
// the tool does not keep.

import type { ProjectType } from '@codkit/type-api';
import { projectTypeProblems } from '@codkit/type-api';
import { CONFIG_FILE_NAME } from '../lib/configFile.ts';
import { ckError } from '../lib/messages.ts';

/**
 * The type as this patch set's `typeConfig` makes it. Called once, after the
 * section has passed the type's own schema; a type without `configure` is
 * returned unchanged.
 */
export function configureProjectType(type: ProjectType, typeConfig: unknown): ProjectType {
	if (type.configure === undefined) {
		return type;
	}
	const configured = type.configure(typeConfig);
	const problems = [...projectTypeProblems(configured)];
	if (configured.id !== type.id) {
		problems.push(`${type.id}: configure returned the project type ${configured.id}`);
	}
	const announced = new Set([...type.capabilities, ...(type.configurableCapabilities ?? [])]);
	for (const capability of configured.capabilities) {
		if (!announced.has(capability)) {
			problems.push(`${type.id}: typeConfig declared the capability ${capability}, which the type never announced`);
		}
	}
	if (problems.length > 0) {
		throw ckError(
			'TYPE-UNKNOWN',
			`the project type ${type.id} does not answer its own contract for this typeConfig: ${problems.join('; ')}`,
			`reinstall the package of ${type.id} at a version built against this codkit; run: codkit types`,
			CONFIG_FILE_NAME
		);
	}
	return configured;
}
