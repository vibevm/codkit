// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import type { IProductConfiguration } from '../../../base/common/product.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import product from '../../../platform/product/common/product.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { FeaturePhase, validateFeatureDescriptor, type IFeatureDescriptor } from '../common/features/featureDescriptor.js';
import { featureDeclarations, type FeatureConstructor, type FeatureDeclarations } from '../common/features/featureDeclarations.js';

/**
 * Declares a feature at module evaluation: records it, registers its setting
 * (unless the build forces a value) and leaves creation to the features host.
 * A descriptor that violates its shape throws here: that is an author error,
 * caught by the product's tests before any UI exists.
 */
export function registerFeature(descriptor: IFeatureDescriptor, ctor: FeatureConstructor, phase: FeaturePhase = FeaturePhase.AfterRestored): void {
	declareFeatureWith(featureDeclarations, Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration), product, descriptor, ctor, phase);
}

/** The testable form of `registerFeature`: every collaborator is a parameter. */
export function declareFeatureWith(
	declarations: FeatureDeclarations,
	configurationRegistry: IConfigurationRegistry,
	productConfiguration: IProductConfiguration,
	descriptor: IFeatureDescriptor,
	ctor: FeatureConstructor,
	phase: FeaturePhase,
): void {
	const problems = validateFeatureDescriptor(descriptor);
	if (problems.length > 0) {
		throw new Error(`codkit: invalid feature declaration: ${problems.join('; ')}`);
	}
	declarations.add({ descriptor, ctor, phase });

	const setting = descriptor.setting;
	if (!setting) {
		return;
	}
	if (descriptor.product?.(productConfiguration) !== undefined) {
		// The build decides: a setting would promise a choice the user does not have.
		return;
	}
	configurationRegistry.registerConfiguration({
		id: setting.id,
		properties: {
			[setting.id]: {
				type: 'boolean',
				default: descriptor.default,
				description: setting.description,
				scope: setting.scope ?? ConfigurationScope.APPLICATION,
				tags: setting.tags ? [...setting.tags] : undefined,
				policy: setting.policy,
			},
		},
	});
}
