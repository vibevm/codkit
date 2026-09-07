// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { remoteKeyOf, type FeatureId, type IFeatureDescriptor } from '../../common/features/featureDescriptor.js';
import { FlagLayer, type FlagReading } from '../../common/features/flagLayers.js';
import type { IFlagSource } from '../../common/features/flagSource.js';
import type { IRemoteFlagsProvider } from '../../common/features/remoteFlags.js';

/**
 * The two remote layers over any provider: a server, or the simulator. A new
 * snapshot may touch any feature, so the source asks for a full recompute.
 */
export class RemoteFlagSource extends Disposable implements IFlagSource {
	readonly layers: readonly FlagLayer[] = [FlagLayer.RemoteForce, FlagLayer.RemoteDefault];
	readonly onDidChange: Event<readonly FeatureId[] | undefined>;

	constructor(private readonly _provider: IRemoteFlagsProvider) {
		super();
		this.onDidChange = Event.map(_provider.onDidChangeSnapshot, () => undefined, this._store);
	}

	read(descriptor: IFeatureDescriptor): readonly FlagReading[] {
		const snapshot = this._provider.current();
		const key = remoteKeyOf(descriptor);
		return [
			{ layer: FlagLayer.RemoteForce, value: snapshot?.force[key] },
			{ layer: FlagLayer.RemoteDefault, value: snapshot?.defaults[key] },
		];
	}
}
