// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue, transaction, type IObservable, type ISettableObservable } from '../../../../base/common/observable.js';
import type { FeatureId, IFeatureDescriptor } from './featureDescriptor.js';
import { resolveFeature, sameState, type FeatureState, type FlagReading } from './flagLayers.js';
import type { FeatureExplanation, IContextKeyPublisher, IFeatureFlagsService, IRestartPort } from './featureFlagsService.js';
import type { IFlagSource } from './flagSource.js';
import type { IRemoteFlagsSimulator } from './remoteFlags.js';

interface FeatureEntry {
	readonly descriptor: IFeatureDescriptor;
	/** What the sources say right now. */
	readonly live: ISettableObservable<FeatureState>;
	/** For a cold feature: the state frozen at the first computation; for a hot one the same observable as `live`. */
	readonly effective: ISettableObservable<FeatureState>;
}

/**
 * The core of the feature-flag service. It depends only on ports: sources,
 * the context-key publisher and the restart port are handed in, so the same
 * class runs under DI in the browser and against fakes in tests.
 */
export class FeatureFlagsServiceBase extends Disposable implements IFeatureFlagsService {
	declare readonly _serviceBrand: undefined;

	private readonly _entries = new Map<FeatureId, FeatureEntry>();
	private readonly _order: FeatureId[] = [];

	private readonly _onDidChangeEnablement = this._register(new Emitter<readonly FeatureId[]>());
	readonly onDidChangeEnablement: Event<readonly FeatureId[]> = this._onDidChangeEnablement.event;

	private readonly _restartPending = observableValue<readonly FeatureId[]>(this, []);
	readonly restartPending: IObservable<readonly FeatureId[]> = this._restartPending;

	private _lastRestartRequest = '';

	constructor(
		descriptors: readonly IFeatureDescriptor[],
		private readonly _sources: readonly IFlagSource[],
		private readonly _publisher: IContextKeyPublisher,
		private readonly _restart: IRestartPort,
		readonly remoteSimulator: IRemoteFlagsSimulator | undefined,
	) {
		super();
		for (const source of _sources) {
			this._register(source);
		}
		this._register(_publisher);
		this._register(_restart);

		for (const descriptor of descriptors) {
			const state = this._compute(descriptor);
			const live = observableValue<FeatureState>(this, state);
			const effective = descriptor.hotToggle ? live : observableValue<FeatureState>(this, state);
			this._entries.set(descriptor.id, { descriptor, live, effective });
			this._order.push(descriptor.id);
			this._publisher.publish(descriptor.id, state.enabled);
		}

		for (const source of _sources) {
			this._register(source.onDidChange((ids) => this._recompute(ids)));
		}
	}

	get features(): readonly IFeatureDescriptor[] {
		return this._order.map((id) => this._entry(id).descriptor);
	}

	enablement(id: FeatureId): IObservable<FeatureState> {
		return this._entry(id).effective;
	}

	liveState(id: FeatureId): IObservable<FeatureState> {
		return this._entry(id).live;
	}

	isEnabled(id: FeatureId): boolean {
		return this._entry(id).effective.get().enabled;
	}

	explain(id: FeatureId): FeatureExplanation {
		const entry = this._entry(id);
		const live = entry.live.get();
		const effective = entry.effective.get();
		return {
			descriptor: entry.descriptor,
			readings: this._readings(entry.descriptor),
			live,
			effective,
			restartPending: !entry.descriptor.hotToggle && !sameState(live, effective),
		};
	}

	private _entry(id: FeatureId): FeatureEntry {
		const entry = this._entries.get(id);
		if (!entry) {
			throw new Error(`codkit: unknown feature id '${id}'`);
		}
		return entry;
	}

	private _readings(descriptor: IFeatureDescriptor): FlagReading[] {
		const readings: FlagReading[] = [];
		for (const source of this._sources) {
			readings.push(...source.read(descriptor));
		}
		return readings;
	}

	private _compute(descriptor: IFeatureDescriptor): FeatureState {
		return resolveFeature(descriptor, this._readings(descriptor));
	}

	/** Recomputes the affected features inside one transaction; observers never see an intermediate state. */
	private _recompute(ids: readonly FeatureId[] | undefined): void {
		const affected = ids === undefined ? this._order : ids.filter((id) => this._entries.has(id));
		const changedEffective: FeatureId[] = [];
		const changedLive: { entry: FeatureEntry; state: FeatureState }[] = [];
		for (const id of affected) {
			const entry = this._entry(id);
			const state = this._compute(entry.descriptor);
			if (!sameState(state, entry.live.get())) {
				changedLive.push({ entry, state });
				if (entry.descriptor.hotToggle) {
					changedEffective.push(id);
				}
			}
		}
		if (changedLive.length === 0) {
			return;
		}
		transaction((tx) => {
			for (const { entry, state } of changedLive) {
				entry.live.set(state, tx);
			}
			this._restartPending.set(this._pendingRestarts(), tx);
		});
		for (const id of changedEffective) {
			this._publisher.publish(id, this._entry(id).effective.get().enabled);
		}
		if (changedEffective.length > 0) {
			this._onDidChangeEnablement.fire(changedEffective);
		}
		this._requestRestartIfNeeded();
	}

	private _pendingRestarts(): FeatureId[] {
		const pending: FeatureId[] = [];
		for (const id of this._order) {
			const entry = this._entry(id);
			if (!entry.descriptor.hotToggle && !sameState(entry.live.get(), entry.effective.get())) {
				pending.push(id);
			}
		}
		return pending;
	}

	/** Asks once per distinct set of pending features; a dismissed prompt is not repeated for the same set. */
	private _requestRestartIfNeeded(): void {
		const pending = this._restartPending.get();
		const key = pending.join('\n');
		if (pending.length === 0 || key === this._lastRestartRequest) {
			return;
		}
		this._lastRestartRequest = key;
		this._restart.requestRestart(pending);
	}
}
