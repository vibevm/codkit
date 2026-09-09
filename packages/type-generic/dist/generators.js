/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-GENERATORS */
// Area 10: the skeleton `codkit gen feature` writes over a plain git upstream.
//
// A family with a composition root gets a class with dependency injection and a
// contribution registration. A plain upstream has neither, so the skeleton is
// the smallest honest thing: the identifiers of the feature, the feature module
// itself, and the test beside them inside the feature's own directory - one
// declared unit of the own manifest covers all three.
//
// There is no brand graft: grafting a table into a string funnel needs a
// funnel, and this type does not claim its upstream has one. The capability
// `gen-brand` is therefore absent and `gen brand` refuses.
/** The constant of a feature's identifier module, e.g. `SAMPLE_FEATURE_ID`. */
export function featureConstant(name) {
    const upper = name.replace(/[^A-Za-z0-9]+/gu, '_').toUpperCase();
    return `${upper.replace(/^_+|_+$/gu, '')}_FEATURE_ID`;
}
/** The flag a feature is read behind, e.g. `acme.sample.enabled`. */
export function settingId(id) {
    return `${id}.enabled`;
}
export function featureSkeleton(request) {
    const directory = `delta/own/${request.name}`;
    const constant = featureConstant(request.name);
    const flag = request.setting ? `\nexport const ${constant}_SETTING = '${settingId(request.id)}';\n` : '';
    const lifetime = request.cold ? 'read once at startup' : 'read on every use';
    return {
        directory,
        modules: [
            {
                path: `${directory}/${request.name}.identifiers.ts`,
                text: `// Identifiers of the ${request.title} feature.\n\nexport const ${constant} = '${request.id}';\n${flag}`,
                role: 'identifiers'
            },
            {
                path: `${directory}/${request.name}.ts`,
                text: `// ${request.title}: own code of this patch set, mirrored into ${request.ownRoot}/ of the tree.\n` +
                    `// The flag of the feature is ${lifetime}.\n\n` +
                    `import { ${constant} } from './${request.name}.identifiers.js';\n\n` +
                    `export function ${request.name}(): string {\n\treturn ${constant};\n}\n`,
                role: 'feature'
            },
            {
                path: `${directory}/test/${request.name}.test.ts`,
                text: `// The contract test of ${request.id}.\n\nsuite('${request.id}', () => {\n\ttest('is named', () => {});\n});\n`,
                role: 'test'
            }
        ],
        importLine: `import { ${request.name} } from './${request.name}/${request.name}.js';`,
        reminders: [
            `import ${directory}/${request.name}.ts from wherever this upstream composes its own code: a plain git upstream has no entry module the tool could name`,
            `declare the contract test ${request.id} in contractTests of the unit that covers ${directory}`
        ]
    };
}
export const generators = { featureSkeleton };
