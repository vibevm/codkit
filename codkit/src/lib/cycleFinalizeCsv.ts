/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Fixed-schema, strict and deterministic cycle metrics history.

import type { CycleJournalEntry } from './cycleJournal.ts';
import { CYCLE_ARTIFACT_OUTCOMES } from './cycleState.ts';
import type { CycleArtifactOutcome, CycleState } from './cycleState.ts';
import type { InventoryMetrics } from './inventory.ts';
import { ckError } from './messages.ts';
import { safeBasenameProblem } from './pathSafety.ts';

export const CYCLE_METRICS_PATH = 'docs/codkit/metrics/inventory-history.csv';
export const CYCLE_METRICS_HEADER = [
	'completed_at',
	'source_tag',
	'source_sha',
	'target_tag',
	'target_sha',
	'duration_seconds',
	'artifacts',
	'clean',
	'shifted',
	'merged',
	'conflict',
	'target_deleted',
	'target_renamed',
	'rule_broken',
	'contract_failed',
	'resolved',
	'renames',
	'journal_entries',
	'agent_entries',
	'inventory_entries',
	'patch_and_rule',
	'hunks',
	'patch_lines',
	'coverage_covered',
	'coverage_required_covered',
	'coverage_required_total',
	'by_layer_json',
	'by_subsystem_json'
] as const;

export type CycleFinalizationInventory = {
	readonly entryCount: number;
	readonly metrics: InventoryMetrics;
};

export function canonicalFinalizationInventory(inventory: CycleFinalizationInventory): CycleFinalizationInventory {
	assertCount(inventory.entryCount, 'inventory entryCount');
	const metrics = inventory.metrics;
	assertCountMap(metrics.byLayer, 'byLayer');
	assertCountMap(metrics.bySubsystem, 'bySubsystem');
	for (const [name, value] of [
		['patchAndRuleCount', metrics.patchAndRuleCount],
		['hunks', metrics.hunks],
		['patchLineTotal', metrics.patchLineTotal],
		['coverage.covered', metrics.contractCoverage.covered],
		['coverage.requiredCovered', metrics.contractCoverage.requiredCovered],
		['coverage.requiredTotal', metrics.contractCoverage.requiredTotal]
	] as const)
		assertCount(value, name);
	if (sum(metrics.byLayer) !== inventory.entryCount || sum(metrics.bySubsystem) !== inventory.entryCount)
		throw csvError('inventory count does not equal byLayer/bySubsystem totals');
	if (metrics.patchAndRuleCount !== (metrics.byLayer['patch'] ?? 0) + (metrics.byLayer['rewrite-rule'] ?? 0))
		throw csvError('patchAndRuleCount disagrees with byLayer');
	if (
		metrics.contractCoverage.requiredCovered > metrics.contractCoverage.requiredTotal ||
		metrics.contractCoverage.covered > inventory.entryCount
	)
		throw csvError('contract coverage counts are inconsistent');
	return {
		entryCount: inventory.entryCount,
		metrics: {
			byLayer: sortedRecord(metrics.byLayer),
			bySubsystem: sortedRecord(metrics.bySubsystem),
			patchAndRuleCount: metrics.patchAndRuleCount,
			hunks: metrics.hunks,
			patchLineTotal: metrics.patchLineTotal,
			contractCoverage: metrics.contractCoverage
		}
	};
}

export function cycleDurationSeconds(state: CycleState): string {
	const milliseconds = Date.parse(state.updatedAt) - Date.parse(state.startedAt);
	if (!Number.isFinite(milliseconds) || milliseconds < 0) throw csvError('cycle duration is invalid');
	return (milliseconds / 1000)
		.toFixed(3)
		.replace(/\.0+$/, '')
		.replace(/(\.\d*?)0+$/, '$1');
}

export function updateCycleMetricsDocument(
	existing: string | null,
	state: CycleState,
	entries: readonly CycleJournalEntry[],
	inventory: CycleFinalizationInventory
): string {
	const row = metricsRow(state, entries, canonicalFinalizationInventory(inventory));
	const header = serializeCsvRow(CYCLE_METRICS_HEADER);
	const rows = existing === null ? [] : parseMetricsDocument(existing, header);
	const key = cycleKey(row);
	const sameCycle = rows.find((candidate) => cycleKey(candidate) === key);
	if (sameCycle !== undefined) {
		if (serializeCsvRow(sameCycle) !== serializeCsvRow(row)) throw csvError(`metrics already contain conflicting cycle ${key}`);
		return existing ?? `${header}\n${serializeCsvRow(row)}\n`;
	}
	return `${existing ?? `${header}\n`}${serializeCsvRow(row)}\n`;
}

function metricsRow(state: CycleState, entries: readonly CycleJournalEntry[], inventory: CycleFinalizationInventory): readonly string[] {
	const counts = Object.fromEntries(CYCLE_ARTIFACT_OUTCOMES.map((outcome) => [outcome, state.artifacts[outcome].length])) as Record<
		CycleArtifactOutcome,
		number
	>;
	const total = CYCLE_ARTIFACT_OUTCOMES.reduce((value, outcome) => value + counts[outcome], 0);
	const coverage = inventory.metrics.contractCoverage;
	return [
		state.updatedAt,
		state.sourcePin.tag,
		state.sourcePin.sha,
		state.targetPin.tag,
		state.targetPin.sha,
		cycleDurationSeconds(state),
		String(total),
		...CYCLE_ARTIFACT_OUTCOMES.map((outcome) => String(counts[outcome])),
		String(state.resolved.length),
		String(state.renames.length),
		String(entries.length),
		String(entries.filter((entry) => entry.by.startsWith('agent:')).length),
		String(inventory.entryCount),
		String(inventory.metrics.patchAndRuleCount),
		String(inventory.metrics.hunks),
		String(inventory.metrics.patchLineTotal),
		String(coverage.covered),
		String(coverage.requiredCovered),
		String(coverage.requiredTotal),
		JSON.stringify(inventory.metrics.byLayer),
		JSON.stringify(inventory.metrics.bySubsystem)
	];
}

function parseMetricsDocument(document: string, header: string): readonly (readonly string[])[] {
	if (document.includes('\r') || !document.endsWith('\n') || document.endsWith('\n\n'))
		throw csvError('metrics CSV must use LF and one final newline');
	const lines = document.slice(0, -1).split('\n');
	if (lines[0] !== header) throw csvError('metrics CSV header does not match the fixed schema');
	const rows = lines.slice(1).map((line, index) => {
		const fields = parseCsvRow(line);
		if (fields.length !== CYCLE_METRICS_HEADER.length || serializeCsvRow(fields) !== line)
			throw csvError(`metrics CSV row ${index + 2} is malformed or noncanonical`);
		validateMetricsFields(fields, index + 2);
		return fields;
	});
	const keys = new Set<string>();
	for (const row of rows) {
		const key = cycleKey(row);
		if (keys.has(key)) throw csvError(`metrics CSV duplicates cycle ${key}`);
		keys.add(key);
	}
	return rows;
}

function validateMetricsFields(fields: readonly string[], line: number): void {
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(fields[0] ?? '') ||
		!Number.isFinite(Date.parse(fields[0] ?? ''))
	)
		throw csvError(`metrics CSV row ${line} has invalid completed_at`);
	for (const index of [1, 3])
		if (safeBasenameProblem(fields[index] ?? '') !== null) throw csvError(`metrics CSV row ${line} has unsafe tag`);
	for (const index of [2, 4]) if (!/^[0-9a-f]{40}$/.test(fields[index] ?? '')) throw csvError(`metrics CSV row ${line} has invalid sha`);
	if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(fields[5] ?? '')) throw csvError(`metrics CSV row ${line} has invalid duration`);
	for (let index = 6; index <= 25; index += 1)
		if (!/^(?:0|[1-9]\d*)$/.test(fields[index] ?? '')) throw csvError(`metrics CSV row ${line} has invalid count`);
	const counts = fields.slice(6, 26).map(Number);
	if (counts[0] !== counts.slice(1, 9).reduce((total, value) => total + value, 0))
		throw csvError(`metrics CSV row ${line} artifact total is inconsistent`);
	if ((counts[9] ?? 0) > (counts[4] ?? 0) + (counts[5] ?? 0) + (counts[7] ?? 0) + (counts[8] ?? 0))
		throw csvError(`metrics CSV row ${line} resolved total is inconsistent`);
	if ((counts[12] ?? 0) > (counts[11] ?? 0) || (counts[18] ?? 0) > (counts[19] ?? 0) || (counts[17] ?? 0) > (counts[13] ?? 0))
		throw csvError(`metrics CSV row ${line} journal or coverage totals are inconsistent`);
	const byLayer = canonicalMap(fields[26] ?? '', line);
	const bySubsystem = canonicalMap(fields[27] ?? '', line);
	if (sum(byLayer) !== (counts[13] ?? 0) || sum(bySubsystem) !== (counts[13] ?? 0))
		throw csvError(`metrics CSV row ${line} inventory totals are inconsistent`);
	if ((counts[14] ?? 0) !== (byLayer['patch'] ?? 0) + (byLayer['rewrite-rule'] ?? 0))
		throw csvError(`metrics CSV row ${line} patch_and_rule is inconsistent`);
}

function canonicalMap(document: string, line: number): Readonly<Record<string, number>> {
	let value: unknown;
	try {
		value = JSON.parse(document);
	} catch {
		throw csvError(`metrics CSV row ${line} has invalid metric map`);
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw csvError(`metrics CSV row ${line} metric map is not an object`);
	const record = value as Record<string, unknown>;
	for (const [key, count] of Object.entries(record))
		if (key === '' || !Number.isInteger(count) || (count as number) < 0) throw csvError(`metrics CSV row ${line} has invalid metric map`);
	if (document !== JSON.stringify(sortedRecord(record as Record<string, number>)))
		throw csvError(`metrics CSV row ${line} metric map is noncanonical`);
	return record as Record<string, number>;
}

function parseCsvRow(line: string): readonly string[] {
	const fields: string[] = [];
	let value = '';
	let quoted = false;
	let closed = false;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index] ?? '';
		if (quoted) {
			if (character === '"' && line[index + 1] === '"') {
				value += '"';
				index += 1;
			} else if (character === '"') {
				quoted = false;
				closed = true;
			} else value += character;
		} else if (character === ',') {
			fields.push(value);
			value = '';
			closed = false;
		} else if (character === '"' && value === '' && !closed) quoted = true;
		else if (closed || character === '"') throw csvError('metrics CSV has malformed quoting');
		else value += character;
	}
	if (quoted) throw csvError('metrics CSV has an unterminated quoted field');
	fields.push(value);
	return fields;
}

function serializeCsvRow(fields: readonly string[]): string {
	return fields.map((field) => (/[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field)).join(',');
}

function sortedRecord(record: Readonly<Record<string, number>>): Record<string, number> {
	return Object.fromEntries(Object.entries(record).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right))));
}

function assertCountMap(record: Readonly<Record<string, number>>, name: string): void {
	for (const [key, value] of Object.entries(record)) {
		if (key === '') throw csvError(`${name} has an empty key`);
		assertCount(value, `${name}.${key}`);
	}
}

function assertCount(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 0) throw csvError(`${name} must be a non-negative integer`);
}

function sum(record: Readonly<Record<string, number>>): number {
	return Object.values(record).reduce((total, value) => total + value, 0);
}

function cycleKey(row: readonly string[]): string {
	return `${row[3] ?? ''}@${row[4] ?? ''}`;
}

function csvError(message: string): Error {
	return ckError('CONFIG', message, 'restore the fixed canonical metrics history and retry', CYCLE_METRICS_PATH);
}
