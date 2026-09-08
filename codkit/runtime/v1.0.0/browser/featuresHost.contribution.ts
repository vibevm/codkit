// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import type { IWorkbenchContribution } from '../../../workbench/common/contributions.js';
import { ILifecycleService, LifecyclePhase } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { FeaturePhase } from '../common/features/featureDescriptor.js';
import { featureDeclarations, type IFeatureDeclaration } from '../common/features/featureDeclarations.js';
import { IFeatureFlagsService } from '../common/features/featureFlagsService.js';
import { FeatureHost, featureHosts } from '../common/features/featureHost.js';

export function toLifecyclePhase(phase: FeaturePhase): LifecyclePhase {
	switch (phase) {
		case FeaturePhase.BlockStartup: return LifecyclePhase.Starting;
		case FeaturePhase.BlockRestore: return LifecyclePhase.Ready;
		case FeaturePhase.AfterRestored: return LifecyclePhase.Restored;
		case FeaturePhase.Eventually: return LifecyclePhase.Eventually;
	}
}

/**
 * The one workbench contribution of the runtime: it raises a host for every
 * declared feature once that feature's phase is reached, the way upstream's
 * own contributions registry waits for lifecycle phases.
 */
export class FeaturesHostContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'codkit.features.host';

	private readonly _hosts = this._register(new DisposableStore());

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IFeatureFlagsService private readonly _featureFlagsService: IFeatureFlagsService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		for (const declaration of featureDeclarations.all()) {
			lifecycleService.when(toLifecyclePhase(declaration.phase)).then(() => this._raise(declaration));
		}
	}

	private _raise(declaration: IFeatureDeclaration): void {
		if (this._store.isDisposed) {
			return;
		}
		const host = new FeatureHost(
			declaration.descriptor,
			declaration.ctor,
			this._featureFlagsService,
			(ctor) => this._instantiationService.createInstance(ctor),
			(error) => this._logService.error(`codkit: feature '${declaration.descriptor.id}' failed to start`, error),
		);
		this._hosts.add(host);
		this._hosts.add(featureHosts.register(host));
	}
}
