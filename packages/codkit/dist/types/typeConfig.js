/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-CONFIG-FIELD */
// Handing `typeConfig` to the type that owns it.
//
// The engine validates the universal fields of `codkit.json` itself and knows
// only one field of this section - the own root, which every engine that
// mirrors, excludes or names the own layer needs. Everything else in it belongs
// to the type, which validates it with its own schema; a refusal becomes
// `CK-E-CONFIG` naming the field, exactly like a refusal of a universal field.
import { CONFIG_FILE_NAME } from '../lib/configFile.js';
import { ckError } from '../lib/messages.js';
/**
 * Validate the type's own section of the configuration. Throws `CK-E-CONFIG`
 * naming the field the type refused; returns nothing when the section is good.
 */
export function assertTypeConfig(type, config) {
    const parsed = type.configSchema.safeParse(config.typeConfig);
    if (parsed.success) {
        return;
    }
    const issue = parsed.error.issues[0];
    const field = issue === undefined ? 'typeConfig' : ['typeConfig', ...issue.path.map(String)].join('.');
    throw ckError('CONFIG', `${field}: ${issue?.message ?? 'failed the validation of the project type'}`, `the project type ${type.id} states what its section may contain; run: codkit types`, CONFIG_FILE_NAME);
}
