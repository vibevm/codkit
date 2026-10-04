// Executable specification examples only. No production coordinator is installed.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

type State = 'pending' | 'prepared' | 'applied' | 'recorded' | 'failed';
type Vector = { name: string; steps: readonly [State, string | null][]; state?: State; lastProven?: State; refuse?: boolean };
const document = readFileSync(
	new URL('../../../../vibevm/vibespecs/modules/codkit/PROP-022-coordinator-contract.xml', import.meta.url),
	'utf8'
);
const json = document.match(/<fence lang="json"><!\[CDATA\[([\s\S]*?)\]\]><\/fence>/)?.[1];
if (json === undefined) throw new Error('coordinator contract examples missing');
const examples = JSON.parse(json) as { transitions: Record<State, readonly State[]>; cases: readonly Vector[] };

function trace(steps: Vector['steps']): { state: State; lastProven: State } {
	let state: State = 'pending';
	let lastProven: State = 'pending';
	const proof = { prepared: 'prepare', applied: 'delivery', recorded: 'receipt', failed: 'error' };
	for (const [next, witness] of steps) {
		if (!examples.transitions[state].includes(next) || next === 'pending' || witness !== proof[next])
			throw new Error('unproven or forbidden transition');
		state = next;
		if (next !== 'failed') lastProven = next;
	}
	return { state, lastProven };
}
for (const vector of examples.cases)
	it(`coordinator contract example: ${vector.name}`, () => {
		if (vector.refuse) expect(() => trace(vector.steps)).toThrow('unproven or forbidden transition');
		else expect(trace(vector.steps)).toEqual({ state: vector.state, lastProven: vector.lastProven });
	});

it('reports partial results without reversing the recorded component', () => {
	const complete = examples.cases.find((v) => v.name === 'complete')!;
	const failed = examples.cases.find((v) => v.name === 'recording-failure-preserves-delivery')!;
	expect([trace(complete.steps), trace(failed.steps)]).toEqual([
		{ state: 'recorded', lastProven: 'recorded' },
		{ state: 'failed', lastProven: 'applied' }
	]);
});
