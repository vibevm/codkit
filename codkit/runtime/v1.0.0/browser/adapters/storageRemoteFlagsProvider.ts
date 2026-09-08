// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';
import {
	applyRemoteFlagsPatch,
	EMPTY_REMOTE_SNAPSHOT,
	parseRemoteFlagsSnapshot,
	serializeRemoteFlagsSnapshot,
	type IRemoteFlagsProvider,
	type IRemoteFlagsSimulator,
	type RemoteFlagsPatch,
	type RemoteFlagsSnapshot,
} from '../../common/features/remoteFlags.js';

export const REMOTE_SNAPSHOT_STORAGE_KEY = 'codkit.features.remoteSnapshot';

/**
 * The simulated remote source: a snapshot kept in application storage and
 * edited through the inspector. It walks the same port a server would, so the
 * whole path (snapshot, transaction, observables, features, `when` clauses)
 * is exercised before any server exists.
 */
export class StorageRemoteFlagsProvider extends Disposable implements IRemoteFlagsProvider, IRemoteFlagsSimulator {
	readonly onDidChangeSnapshot: Event<void>;

	constructor(private readonly _storageService: IStorageService) {
		super();
		this.onDidChangeSnapshot = Event.map(
			_storageService.onDidChangeValue(StorageScope.APPLICATION, REMOTE_SNAPSHOT_STORAGE_KEY, this._store),
			() => undefined,
			this._store,
		);
	}

	current(): RemoteFlagsSnapshot | undefined {
		const text = this._storageService.get(REMOTE_SNAPSHOT_STORAGE_KEY, StorageScope.APPLICATION);
		return text === undefined ? undefined : parseRemoteFlagsSnapshot(text);
	}

	simulate(patch: RemoteFlagsPatch): void {
		const next = applyRemoteFlagsPatch(this.current() ?? EMPTY_REMOTE_SNAPSHOT, patch);
		this._storageService.store(REMOTE_SNAPSHOT_STORAGE_KEY, serializeRemoteFlagsSnapshot(next), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	clear(): void {
		this._storageService.remove(REMOTE_SNAPSHOT_STORAGE_KEY, StorageScope.APPLICATION);
	}
}
