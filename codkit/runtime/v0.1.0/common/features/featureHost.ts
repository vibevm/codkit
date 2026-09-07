// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { Disposable, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue, type IObservable } from '../../../../base/common/observable.js';
import type { FeatureId, IFeatureDescriptor } from './featureDescriptor.js';
import type { FeatureConstructor } from './featureDeclarations.js';
import type { IFeatureFlagsService } from './featureFlagsService.js';

export type FeatureHostState = 'inactive' | 'active' | 'failed';

/**
 * Keeps one feature alive exactly while its flag is on: enabling creates the
 * feature instance through the factory (dependency injection in the browser),
 * disabling disposes it. A constructor that throws marks the feature `failed`
 * and is logged; it never reaches the workbench.
 */
export class FeatureHost extends Disposable {
	private readonly _instance = this._register(new MutableDisposable<IDisposable>());
	private readonly _state = observableValue<FeatureHostState>(this, 'inactive');
	readonly state: IObservable<FeatureHostState> = this._state;

	constructor(
		readonly descriptor: IFeatureDescriptor,
		ctor: FeatureConstructor,
		flags: IFeatureFlagsService,
		create: (ctor: FeatureConstructor) => IDisposable,
		log: (error: unknown) => void,
	) {
		super();
		const enablement = flags.enablement(descriptor.id);
		this._register(autorun((reader) => {
			const enabled = enablement.read(reader).enabled;
			if (!enabled) {
				this._instance.clear();
				this._state.set('inactive', undefined);
				return;
			}
			if (this._state.get() === 'active') {
				return;
			}
			try {
				this._instance.value = create(ctor);
				this._state.set('active', undefined);
			} catch (error) {
				this._instance.clear();
				this._state.set('failed', undefined);
				log(error);
			}
		}));
	}
}

/** Hosts by feature id, so the inspector can show instance states. */
export class FeatureHostRegistry {
	private readonly _hosts = new Map<FeatureId, FeatureHost>();

	register(host: FeatureHost): IDisposable {
		this._hosts.set(host.descriptor.id, host);
		return { dispose: () => this._hosts.delete(host.descriptor.id) };
	}

	stateOf(id: FeatureId): FeatureHostState | undefined {
		return this._hosts.get(id)?.state.get();
	}
}

export const featureHosts = new FeatureHostRegistry();
