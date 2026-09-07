// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IProductConfiguration } from '../../../../base/common/product.js';
import type { FeatureId, IFeatureDescriptor } from '../../common/features/featureDescriptor.js';
import { FlagLayer, type FlagReading } from '../../common/features/flagLayers.js';
import type { IFlagSource } from '../../common/features/flagSource.js';

/**
 * The build layer: what `product.json` says through the descriptor's typed
 * accessor. The product configuration never changes at runtime, so this
 * source never fires.
 */
export class ProductFlagSource extends Disposable implements IFlagSource {
	readonly layers: readonly FlagLayer[] = [FlagLayer.Build];
	readonly onDidChange: Event<readonly FeatureId[] | undefined> = Event.None;

	constructor(private readonly _product: IProductConfiguration) {
		super();
	}

	read(descriptor: IFeatureDescriptor): readonly FlagReading[] {
		return [{ layer: FlagLayer.Build, value: descriptor.product?.(this._product) }];
	}
}
