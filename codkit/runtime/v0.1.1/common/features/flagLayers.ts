// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import type { IFeatureDescriptor } from './featureDescriptor.js';

/**
 * The layers a flag value can come from. A build value cannot be undone by any
 * other layer: that is what makes a security feature a property of the build.
 */
export const enum FlagLayer {
	Build = 'build',
	Policy = 'policy',
	RemoteForce = 'remote-force',
	User = 'user',
	RemoteDefault = 'remote-default',
	Default = 'default',
}

/** Highest precedence first. */
export const FLAG_LAYER_PRECEDENCE: readonly FlagLayer[] = [
	FlagLayer.Build,
	FlagLayer.Policy,
	FlagLayer.RemoteForce,
	FlagLayer.User,
	FlagLayer.RemoteDefault,
	FlagLayer.Default,
];

/** What one layer says about one feature; `undefined` means "this layer does not decide". */
export interface FlagReading {
	readonly layer: FlagLayer;
	readonly value: boolean | undefined;
}

/** The resolved state of a feature and the layer that decided it. */
export interface FeatureState {
	readonly enabled: boolean;
	readonly decidedBy: FlagLayer;
}

/**
 * Resolves a feature from the readings of its sources: the first layer in
 * precedence order with a defined value wins; the declaration default always
 * decides when nothing else does.
 */
export function resolveFeature(descriptor: IFeatureDescriptor, readings: readonly FlagReading[]): FeatureState {
	for (const layer of FLAG_LAYER_PRECEDENCE) {
		if (layer === FlagLayer.Default) {
			break;
		}
		for (const reading of readings) {
			if (reading.layer === layer && reading.value !== undefined) {
				return { enabled: reading.value, decidedBy: layer };
			}
		}
	}
	return { enabled: descriptor.default, decidedBy: FlagLayer.Default };
}

export function sameState(left: FeatureState, right: FeatureState): boolean {
	return left.enabled === right.enabled && left.decidedBy === right.decidedBy;
}
