// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IObservable } from '../../../../base/common/observable.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { FeatureId, IFeatureDescriptor } from './featureDescriptor.js';
import type { FeatureState, FlagReading } from './flagLayers.js';
import type { IRemoteFlagsSimulator } from './remoteFlags.js';

export const IFeatureFlagsService = createDecorator<IFeatureFlagsService>('codkitFeatureFlagsService');

/** Everything the inspector shows about one feature. */
export interface FeatureExplanation {
	readonly descriptor: IFeatureDescriptor;
	/** One reading per layer of every source, in source order. */
	readonly readings: readonly FlagReading[];
	/** The state the sources give right now. */
	readonly live: FeatureState;
	/** The state the feature runs with (frozen at startup for a cold feature). */
	readonly effective: FeatureState;
	readonly restartPending: boolean;
}

export interface IFeatureFlagsService {
	readonly _serviceBrand: undefined;

	/** Every declared feature, in declaration order. */
	readonly features: readonly IFeatureDescriptor[];

	/**
	 * The state a feature runs with: live for a hot feature, frozen at the
	 * first computation of this session for a cold one. Throws on an unknown id.
	 */
	enablement(id: FeatureId): IObservable<FeatureState>;

	/** The state the sources give right now, never frozen. Throws on an unknown id. */
	liveState(id: FeatureId): IObservable<FeatureState>;

	/** `enablement(id).get().enabled` */
	isEnabled(id: FeatureId): boolean;

	/** Cold features whose live state differs from the frozen one. */
	readonly restartPending: IObservable<readonly FeatureId[]>;

	/** Fired once per change with the ids whose effective state changed; an adapter for code without observables. */
	readonly onDidChangeEnablement: Event<readonly FeatureId[]>;

	explain(id: FeatureId): FeatureExplanation;

	/** The simulated remote source, when this build has one. */
	readonly remoteSimulator: IRemoteFlagsSimulator | undefined;
}

/** A port: publishing enablement as a context key so `when` clauses follow the flag. */
export interface IContextKeyPublisher extends IDisposable {
	publish(id: FeatureId, enabled: boolean): void;
}

/** A port: asking the user to restart because a cold feature changed. */
export interface IRestartPort extends IDisposable {
	requestRestart(pending: readonly FeatureId[]): void;
}
