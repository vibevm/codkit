// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { FeatureId, IFeatureDescriptor } from '../../common/features/featureDescriptor.js';
import type { IContextKeyPublisher, IRestartPort } from '../../common/features/featureFlagsService.js';
import type { FlagLayer, FlagReading } from '../../common/features/flagLayers.js';
import type { IFlagSource } from '../../common/features/flagSource.js';

/** A source whose readings the test sets by hand. */
export class FakeSource extends Disposable implements IFlagSource {
	private readonly _onDidChange = this._register(new Emitter<readonly FeatureId[] | undefined>());
	readonly onDidChange: Event<readonly FeatureId[] | undefined> = this._onDidChange.event;
	private readonly _values = new Map<string, boolean | undefined>();

	constructor(readonly layers: readonly FlagLayer[]) {
		super();
	}

	set(layer: FlagLayer, id: FeatureId, value: boolean | undefined): void {
		this._values.set(`${layer}\n${id}`, value);
	}

	fire(ids: readonly FeatureId[] | undefined): void {
		this._onDidChange.fire(ids);
	}

	read(descriptor: IFeatureDescriptor): readonly FlagReading[] {
		return this.layers.map((layer) => ({ layer, value: this._values.get(`${layer}\n${descriptor.id}`) }));
	}
}

export class RecordingPublisher extends Disposable implements IContextKeyPublisher {
	readonly published: [FeatureId, boolean][] = [];
	publish(id: FeatureId, enabled: boolean): void {
		this.published.push([id, enabled]);
	}
}

export class RecordingRestart extends Disposable implements IRestartPort {
	readonly requests: (readonly FeatureId[])[] = [];
	requestRestart(pending: readonly FeatureId[]): void {
		this.requests.push(pending);
	}
}

export function descriptor(id: string, overrides: Partial<IFeatureDescriptor> = {}): IFeatureDescriptor {
	return { id, title: id, default: false, hotToggle: true, ...overrides };
}
