// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { Disposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IHostService } from '../../../../workbench/services/host/browser/host.js';
import type { FeatureId } from '../../common/features/featureDescriptor.js';
import type { IRestartPort } from '../../common/features/featureFlagsService.js';

/** Asks for a restart the way upstream does: a prompt with a Restart choice. */
export class HostRestart extends Disposable implements IRestartPort {
	constructor(
		private readonly _hostService: IHostService,
		private readonly _notificationService: INotificationService,
	) {
		super();
	}

	requestRestart(pending: readonly FeatureId[]): void {
		this._notificationService.prompt(
			Severity.Info,
			localize('codkit.features.restartRequired', "Feature flags changed for {0}. Restart to apply the change.", pending.join(', ')),
			[{
				label: localize('codkit.features.restart', "Restart"),
				run: () => this._hostService.restart(),
			}],
		);
	}
}
