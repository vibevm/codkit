// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { featureDeclarations } from '../common/features/featureDeclarations.js';
import { FeatureFlagsServiceBase } from '../common/features/featureFlagsServiceBase.js';
import { ConfigurationFlagSource } from './adapters/configurationFlagSource.js';
import { ContextKeyPublisher } from './adapters/contextKeyPublisher.js';
import { HostRestart } from './adapters/hostRestart.js';
import { ProductFlagSource } from './adapters/productFlagSource.js';
import { RemoteFlagSource } from './adapters/remoteFlagSource.js';
import { StorageRemoteFlagsProvider } from './adapters/storageRemoteFlagsProvider.js';

/**
 * The service as the renderer sees it: the core wired to the upstream
 * adapters through dependency injection. Every upstream API the runtime
 * touches is reachable from this file and the `adapters/` folder.
 */
export class BrowserFeatureFlagsService extends FeatureFlagsServiceBase {
	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IProductService productService: IProductService,
		@IStorageService storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@INotificationService notificationService: INotificationService,
	) {
		const descriptors = featureDeclarations.all().map((declaration) => declaration.descriptor);
		const simulator = new StorageRemoteFlagsProvider(storageService);
		super(
			descriptors,
			[
				new ProductFlagSource(productService),
				new ConfigurationFlagSource(descriptors, configurationService),
				new RemoteFlagSource(simulator),
			],
			new ContextKeyPublisher(contextKeyService),
			new HostRestart(hostService, notificationService),
			simulator,
		);
		this._register(simulator);
	}
}
