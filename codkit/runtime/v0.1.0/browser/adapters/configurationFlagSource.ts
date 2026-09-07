// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { FeatureId, IFeatureDescriptor } from '../../common/features/featureDescriptor.js';
import { FlagLayer, type FlagReading } from '../../common/features/flagLayers.js';
import type { IFlagSource } from '../../common/features/flagSource.js';

/**
 * The policy and user layers, read from the configuration service. A policy
 * value arrives through the same service (`inspect().policyValue`), so no
 * separate policy adapter is needed.
 */
export class ConfigurationFlagSource extends Disposable implements IFlagSource {
	readonly layers: readonly FlagLayer[] = [FlagLayer.Policy, FlagLayer.User];

	private readonly _onDidChange = this._register(new Emitter<readonly FeatureId[] | undefined>());
	readonly onDidChange: Event<readonly FeatureId[] | undefined> = this._onDidChange.event;

	constructor(
		descriptors: readonly IFeatureDescriptor[],
		private readonly _configurationService: IConfigurationService,
	) {
		super();
		const withSetting = descriptors.filter((descriptor) => descriptor.setting !== undefined);
		this._register(_configurationService.onDidChangeConfiguration((event) => {
			const affected = withSetting
				.filter((descriptor) => event.affectsConfiguration(descriptor.setting!.id))
				.map((descriptor) => descriptor.id);
			if (affected.length > 0) {
				this._onDidChange.fire(affected);
			}
		}));
	}

	read(descriptor: IFeatureDescriptor): readonly FlagReading[] {
		if (!descriptor.setting) {
			return [{ layer: FlagLayer.Policy, value: undefined }, { layer: FlagLayer.User, value: undefined }];
		}
		const inspected = this._configurationService.inspect<boolean>(descriptor.setting.id);
		const user = inspected.applicationValue ?? inspected.userValue ?? inspected.userLocalValue ?? inspected.userRemoteValue;
		return [
			{ layer: FlagLayer.Policy, value: asBoolean(inspected.policyValue) },
			{ layer: FlagLayer.User, value: asBoolean(user) },
		];
	}
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}
