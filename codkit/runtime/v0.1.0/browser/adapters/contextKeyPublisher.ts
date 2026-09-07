// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { FeatureId } from '../../common/features/featureDescriptor.js';
import type { IContextKeyPublisher } from '../../common/features/featureFlagsService.js';

/** Publishes `<id>.enabled` context keys, created lazily on first publish. */
export class ContextKeyPublisher extends Disposable implements IContextKeyPublisher {
	private readonly _keys = new Map<FeatureId, IContextKey<boolean>>();

	constructor(private readonly _contextKeyService: IContextKeyService) {
		super();
	}

	publish(id: FeatureId, enabled: boolean): void {
		let key = this._keys.get(id);
		if (!key) {
			key = this._contextKeyService.createKey<boolean>(`${id}.enabled`, enabled);
			this._keys.set(id, key);
			return;
		}
		key.set(enabled);
	}
}
