// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

/**
 * What a remote source says. `force` is a kill switch above the user's choice;
 * `defaults` sits below it. Keys are remote keys of features (`remoteKeyOf`).
 */
export interface RemoteFlagsSnapshot {
	readonly version: 1;
	readonly force: Readonly<Record<string, boolean>>;
	readonly defaults: Readonly<Record<string, boolean>>;
	readonly issuedAt?: string;
}

export const EMPTY_REMOTE_SNAPSHOT: RemoteFlagsSnapshot = { version: 1, force: {}, defaults: {} };

/** A port: the current snapshot and the event that it changed. A server and the simulator both implement it. */
export interface IRemoteFlagsProvider extends IDisposable {
	current(): RemoteFlagsSnapshot | undefined;
	readonly onDidChangeSnapshot: Event<void>;
}

/** A patch to a simulated snapshot; `null` removes the key. */
export interface RemoteFlagsPatch {
	readonly force?: Readonly<Record<string, boolean | null>>;
	readonly defaults?: Readonly<Record<string, boolean | null>>;
}

/** A port: editing the simulated remote snapshot (the inspector uses it). */
export interface IRemoteFlagsSimulator {
	simulate(patch: RemoteFlagsPatch): void;
	clear(): void;
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((entry) => typeof entry === 'boolean');
}

/**
 * Parses a snapshot strictly: version 1, boolean values, string keys. Anything
 * else yields `undefined`; the parser never throws, so a broken snapshot
 * degrades to "the remote does not decide".
 */
export function parseRemoteFlagsSnapshot(text: string): RemoteFlagsSnapshot | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	if (record['version'] !== 1) {
		return undefined;
	}
	const force = record['force'] ?? {};
	const defaults = record['defaults'] ?? {};
	if (!isBooleanRecord(force) || !isBooleanRecord(defaults)) {
		return undefined;
	}
	const issuedAt = record['issuedAt'];
	if (issuedAt !== undefined && typeof issuedAt !== 'string') {
		return undefined;
	}
	return issuedAt === undefined
		? { version: 1, force: { ...force }, defaults: { ...defaults } }
		: { version: 1, force: { ...force }, defaults: { ...defaults }, issuedAt };
}

/** Applies a patch to a snapshot; `null` removes a key. Pure. */
export function applyRemoteFlagsPatch(snapshot: RemoteFlagsSnapshot, patch: RemoteFlagsPatch): RemoteFlagsSnapshot {
	const apply = (current: Readonly<Record<string, boolean>>, changes: Readonly<Record<string, boolean | null>> | undefined): Record<string, boolean> => {
		const next: Record<string, boolean> = { ...current };
		for (const [key, value] of Object.entries(changes ?? {})) {
			if (value === null) {
				delete next[key];
			} else {
				next[key] = value;
			}
		}
		return next;
	};
	return { version: 1, force: apply(snapshot.force, patch.force), defaults: apply(snapshot.defaults, patch.defaults) };
}

export function serializeRemoteFlagsSnapshot(snapshot: RemoteFlagsSnapshot): string {
	return JSON.stringify(snapshot);
}
