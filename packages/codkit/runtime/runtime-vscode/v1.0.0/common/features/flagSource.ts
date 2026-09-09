// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { FeatureId, IFeatureDescriptor } from './featureDescriptor.js';
import type { FlagLayer, FlagReading } from './flagLayers.js';

/**
 * A port: where flag values come from. The configuration, the product, a
 * remote snapshot and its simulator all implement it; the core knows nothing
 * beyond this shape.
 */
export interface IFlagSource extends IDisposable {
	/** The layers this source contributes; `read` returns one reading per layer. */
	readonly layers: readonly FlagLayer[];
	read(descriptor: IFeatureDescriptor): readonly FlagReading[];
	/** The affected feature ids, or `undefined` when everything must be recomputed. */
	readonly onDidChange: Event<readonly FeatureId[] | undefined>;
}
