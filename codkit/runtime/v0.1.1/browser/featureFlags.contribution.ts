// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

// The runtime's composition root for the renderer. A product imports this
// module once from its own composition root, after its feature declarations
// are imported, and the runtime takes care of the rest.

import { registerAction2 } from '../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../workbench/common/contributions.js';
import { IFeatureFlagsService } from '../common/features/featureFlagsService.js';
import { BrowserFeatureFlagsService } from './browserFeatureFlagsService.js';
import { FeaturesHostContribution } from './featuresHost.contribution.js';
import { InspectFeatureFlagsAction } from './inspector/featureFlagsInspector.js';

registerSingleton(IFeatureFlagsService, BrowserFeatureFlagsService, InstantiationType.Delayed);
registerWorkbenchContribution2(FeaturesHostContribution.ID, FeaturesHostContribution, WorkbenchPhase.BlockRestore);
registerAction2(InspectFeatureFlagsAction);
