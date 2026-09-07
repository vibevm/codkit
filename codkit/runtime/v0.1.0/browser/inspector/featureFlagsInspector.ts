// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { remoteKeyOf } from '../../common/features/featureDescriptor.js';
import { IFeatureFlagsService, type FeatureExplanation } from '../../common/features/featureFlagsService.js';
import { featureHosts } from '../../common/features/featureHost.js';
import type { FlagReading } from '../../common/features/flagLayers.js';

type InspectorAction =
	| { readonly kind: 'user'; readonly value: boolean | undefined }
	| { readonly kind: 'remote'; readonly bucket: 'force' | 'defaults'; readonly value: boolean | null }
	| { readonly kind: 'clearRemote' };

interface FeaturePick extends IQuickPickItem {
	readonly featureId: string;
}

interface ActionPick extends IQuickPickItem {
	readonly action: InspectorAction;
}

function readingText(reading: FlagReading): string {
	return `${reading.layer}=${reading.value === undefined ? '-' : reading.value ? 'on' : 'off'}`;
}

function describe(explanation: FeatureExplanation): string {
	const parts = [
		`decided by ${explanation.effective.decidedBy}`,
		...explanation.readings.map(readingText),
	];
	const hostState = featureHosts.stateOf(explanation.descriptor.id);
	if (hostState) {
		parts.push(`instance ${hostState}`);
	}
	if (explanation.restartPending) {
		parts.push('restart pending');
	}
	return parts.join('; ');
}

/**
 * Lists every declared feature with its effective state and the layer that
 * decided it, and lets the operator flip the user setting or the simulated
 * remote snapshot. The same path a server would take, exercised by hand.
 */
export class InspectFeatureFlagsAction extends Action2 {
	static readonly ID = 'codkit.features.inspect';

	constructor() {
		super({
			id: InspectFeatureFlagsAction.ID,
			title: localize2('codkit.features.inspect', "Feature Flags: Inspect"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const flags = accessor.get(IFeatureFlagsService);
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);

		const picks: FeaturePick[] = flags.features.map((descriptor) => {
			const explanation = flags.explain(descriptor.id);
			return {
				featureId: descriptor.id,
				label: `${explanation.effective.enabled ? '$(check)' : '$(circle-slash)'} ${descriptor.title}`,
				description: descriptor.id,
				detail: describe(explanation),
			};
		});
		const picked = await quickInputService.pick(picks, {
			placeHolder: localize('codkit.features.pickFeature', "Pick a feature to inspect or change"),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked) {
			return;
		}
		const explanation = flags.explain(picked.featureId);
		const descriptor = explanation.descriptor;

		const actions: ActionPick[] = [];
		if (descriptor.setting) {
			actions.push(
				{ label: localize('codkit.features.userOn', "Enable via user setting"), action: { kind: 'user', value: true } },
				{ label: localize('codkit.features.userOff', "Disable via user setting"), action: { kind: 'user', value: false } },
				{ label: localize('codkit.features.userReset', "Reset user setting"), action: { kind: 'user', value: undefined } },
			);
		}
		if (flags.remoteSimulator) {
			actions.push(
				{ label: localize('codkit.features.remoteForceOn', "Simulate remote force: on"), action: { kind: 'remote', bucket: 'force', value: true } },
				{ label: localize('codkit.features.remoteForceOff', "Simulate remote force: off"), action: { kind: 'remote', bucket: 'force', value: false } },
				{ label: localize('codkit.features.remoteForceClear', "Simulate remote force: clear"), action: { kind: 'remote', bucket: 'force', value: null } },
				{ label: localize('codkit.features.remoteDefaultOn', "Simulate remote default: on"), action: { kind: 'remote', bucket: 'defaults', value: true } },
				{ label: localize('codkit.features.remoteDefaultOff', "Simulate remote default: off"), action: { kind: 'remote', bucket: 'defaults', value: false } },
				{ label: localize('codkit.features.remoteDefaultClear', "Simulate remote default: clear"), action: { kind: 'remote', bucket: 'defaults', value: null } },
				{ label: localize('codkit.features.remoteClearAll', "Clear the simulated remote snapshot"), action: { kind: 'clearRemote' } },
			);
		}
		if (actions.length === 0) {
			return;
		}
		const chosen = await quickInputService.pick(actions, {
			placeHolder: localize('codkit.features.pickAction', "{0}: {1}", descriptor.title, describe(explanation)),
		});
		if (!chosen) {
			return;
		}
		switch (chosen.action.kind) {
			case 'user':
				await configurationService.updateValue(descriptor.setting!.id, chosen.action.value, ConfigurationTarget.USER);
				return;
			case 'remote':
				flags.remoteSimulator!.simulate({ [chosen.action.bucket]: { [remoteKeyOf(descriptor)]: chosen.action.value } });
				return;
			case 'clearRemote':
				flags.remoteSimulator!.clear();
				return;
		}
	}
}
