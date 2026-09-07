// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { BrandedService, IConstructorSignature } from '../../../../platform/instantiation/common/instantiation.js';
import type { FeatureId, FeaturePhase, IFeatureDescriptor } from './featureDescriptor.js';

/** A feature class as a declaration stores it: an ordinary disposable created through dependency injection. */
export type FeatureConstructor = IConstructorSignature<IDisposable>;

/**
 * A feature class as a product writes it: a constructor whose parameters are
 * all services. The public registration takes this shape and narrows it to
 * `FeatureConstructor`, the same way upstream's `registerWorkbenchContribution2`
 * takes its contribution signature.
 */
export type FeatureSignature<Services extends BrandedService[]> = new (...services: Services) => IDisposable;

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
