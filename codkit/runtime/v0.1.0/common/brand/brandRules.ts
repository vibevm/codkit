// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import { LRUCache } from '../../../../base/common/map.js';

/**
 * One brand rule: every occurrence of `find` becomes `replace`, unless the
 * message contains one of the `except` substrings (a foreign product name that
 * happens to contain the upstream name, a documented variable, ...).
 */
export interface IBrandRule {
	readonly find: string;
	readonly replace: string;
	readonly except?: readonly string[];
}

export type BrandTransform = (message: string) => string;

const CACHE_SIZE = 2048;

/**
 * Builds a pure message transform from brand rules. It is meant to sit after
 * the localized message lookup, so it brands the English defaults and every
 * language pack alike. Results are cached; the function never throws.
 */
export function createBrandTransform(rules: readonly IBrandRule[]): BrandTransform {
	const active = rules.filter((rule) => rule.find.length > 0 && rule.find !== rule.replace);
	if (active.length === 0) {
		return (message) => message;
	}
	const cache = new LRUCache<string, string>(CACHE_SIZE);
	return (message: string): string => {
		if (!active.some((rule) => message.includes(rule.find))) {
			return message;
		}
		const cached = cache.get(message);
		if (cached !== undefined) {
			return cached;
		}
		let result = message;
		for (const rule of active) {
			if (!result.includes(rule.find)) {
				continue;
			}
			if (rule.except?.some((exception) => result.includes(exception))) {
				continue;
			}
			result = result.split(rule.find).join(rule.replace);
		}
		cache.set(message, result);
		return result;
	};
}

/**
 * The keys whose message the transform changes. A product's guard test feeds
 * it the upstream message table and snapshots the result, so a new upstream
 * string that the brand rules would touch shows up as a reviewed diff, not as
 * a silent change.
 */
export function affectedEntries(transform: BrandTransform, entries: Iterable<readonly [key: string, message: string]>): string[] {
	const affected: string[] = [];
	for (const [key, message] of entries) {
		if (transform(message) !== message) {
			affected.push(key);
		}
	}
	return affected;
}
