/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-CAPABILITY-REFUSAL */
// The refusal a verb makes when the declared project type does not have the
// ability it needs.
//
// ##TYPE-CAPABILITY-REFUSAL: the roster of verbs is the same for every type, so
// a verb outside a type's abilities refuses - naming the type and the
// capability, exit 2, before any write - rather than quietly doing something
// else. The verbs that need one: `imageset *` (brand-images), `gen brand`
// (gen-brand), `build *` (build-channels), `runtime load|check`
// (runtime-library), `preview` (preview), and `verify` over an artifact of a
// layer the type does not provide.
import { ckError } from '../lib/messages.js';
/**
 * What a person reads instead of the verb's answer, per capability. Each value
 * completes the sentence "this family of upstreams has no ...", so none of them
 * carries an article of its own.
 */
const WHAT_IT_IS = {
    'brand-images': 'brand image set',
    'gen-brand': 'brand table generator',
    'build-channels': 'compile channels behind a watch wrapper',
    'runtime-library': 'runtime library to deliver',
    'own-extensions': 'own extensions of the patch set',
    'service-override': 'service-override seam',
    'entry-module': 'entry modules a graft may target',
    'config-overlay': 'configuration files an overlay may target',
    'dev-channel': 'development channel beside an overlay target',
    'upgrade-advisory': 'semantic readers for the upgrade advisory',
    preview: 'host application to show the product in'
};
/**
 * Refuse unless the type declares the capability. `what` names the verb or the
 * artifact the refusal is about, so the message says what was asked for.
 */
export function requireCapability(type, capability, what) {
    // No configuration means no declared type, and therefore no capability
    // question to answer. Every verb that needs a configuration has already
    // refused for want of one by the time this is asked.
    if (type === null) {
        return;
    }
    if (type.capabilities.has(capability)) {
        return;
    }
    throw ckError('TYPE-CAPABILITY', `${what} needs the capability ${capability}, and the project type ${type.id} does not declare it: ` +
        `this family of upstreams has no ${WHAT_IT_IS[capability]}`, `run: codkit types   for what ${type.id} answers; nothing was written`);
}
