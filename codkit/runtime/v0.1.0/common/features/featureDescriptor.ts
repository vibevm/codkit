// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import type { IPolicy } from '../../../../base/common/policy.js';
import type { IProductConfiguration } from '../../../../base/common/product.js';
import type { ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';

/**
 * The identifier of a feature: two or more dot-separated camelCase segments,
 * the first of which is the product's prefix (`acme.smartPaste`).
 */
export type FeatureId = string;

const FEATURE_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/**
 * The phase at which a feature's host is created. Mirrors the workbench
 * contribution phases without importing the workbench layer into `common`.
 */
export const enum FeaturePhase {
	BlockStartup = 'blockStartup',
	BlockRestore = 'blockRestore',
	AfterRestored = 'afterRestored',
	Eventually = 'eventually',
}

/** The user-facing setting behind a feature flag. */
export interface IFeatureSettingDeclaration {
	/** Full setting id, prefixed by the product (`acme.smartPaste.enabled`). */
	readonly id: string;
	/** Already localized description; the product calls `localize`. */
	readonly description: string;
	/** Defaults to `ConfigurationScope.APPLICATION`. */
	readonly scope?: ConfigurationScope;
	readonly tags?: readonly string[];
	/** Present for an organisational flag: a system policy may override the user. */
	readonly policy?: IPolicy;
}

/** Everything the runtime knows about a feature: data, no upstream types beyond the setting schema. */
export interface IFeatureDescriptor {
	readonly id: FeatureId;
	/** Already localized title shown by the inspector. */
	readonly title: string;
	/** The value of the declaration layer, used when no other layer decides. */
	readonly default: boolean;
	/**
	 * `true`: the feature is created and disposed live as the flag changes.
	 * `false` ("cold"): the value is frozen at startup and a change asks for a restart.
	 */
	readonly hotToggle: boolean;
	readonly setting?: IFeatureSettingDeclaration;
	/**
	 * The build layer: a typed read of the product configuration (the product
	 * augments `IProductConfiguration`). `undefined` means "the build does not say".
	 */
	readonly product?: (product: IProductConfiguration) => boolean | undefined;
	/** The key in a remote snapshot; defaults to the feature id. */
	readonly remote?: { readonly key?: string };
}

/** Returns the list of violations; an empty list means the descriptor is valid. */
export function validateFeatureDescriptor(descriptor: IFeatureDescriptor): string[] {
	const problems: string[] = [];
	if (!FEATURE_ID_PATTERN.test(descriptor.id)) {
		problems.push(`feature id '${descriptor.id}' must be two or more dot-separated camelCase segments`);
	}
	if (descriptor.title.trim().length === 0) {
		problems.push(`feature '${descriptor.id}' has an empty title`);
	}
	if (descriptor.setting) {
		if (descriptor.setting.id.trim().length === 0) {
			problems.push(`feature '${descriptor.id}' declares a setting with an empty id`);
		}
		if (descriptor.setting.description.trim().length === 0) {
			problems.push(`feature '${descriptor.id}' declares a setting without a description`);
		}
	}
	if (descriptor.remote?.key !== undefined && descriptor.remote.key.trim().length === 0) {
		problems.push(`feature '${descriptor.id}' declares an empty remote key`);
	}
	return problems;
}

/** The key of a feature in a remote snapshot. */
export function remoteKeyOf(descriptor: IFeatureDescriptor): string {
	return descriptor.remote?.key ?? descriptor.id;
}

/** The context key that follows the feature's enablement. */
export function contextKeyOf(descriptor: IFeatureDescriptor): string {
	return `${descriptor.id}.enabled`;
}
