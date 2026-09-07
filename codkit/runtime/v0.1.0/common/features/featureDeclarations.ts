// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IConstructorSignature } from '../../../../platform/instantiation/common/instantiation.js';
import type { FeatureId, FeaturePhase, IFeatureDescriptor } from './featureDescriptor.js';

/** A feature class: an ordinary disposable with its dependencies injected through the constructor. */
export type FeatureConstructor = IConstructorSignature<IDisposable>;

export interface IFeatureDeclaration {
	readonly descriptor: IFeatureDescriptor;
	readonly ctor: FeatureConstructor;
	readonly phase: FeaturePhase;
}

/**
 * The declarations collected while the product's contribution modules are
 * evaluated. A module-level instance plays the role upstream registries play;
 * tests build their own instance.
 */
export class FeatureDeclarations {
	private readonly _byId = new Map<FeatureId, IFeatureDeclaration>();

	add(declaration: IFeatureDeclaration): void {
		const id = declaration.descriptor.id;
		if (this._byId.has(id)) {
			throw new Error(`codkit: feature '${id}' is declared twice`);
		}
		this._byId.set(id, declaration);
	}

	all(): readonly IFeatureDeclaration[] {
		return [...this._byId.values()];
	}

	byId(id: FeatureId): IFeatureDeclaration | undefined {
		return this._byId.get(id);
	}
}

export const featureDeclarations = new FeatureDeclarations();
