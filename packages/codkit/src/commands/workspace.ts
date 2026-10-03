/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-CLI */
// Thin lifecycle surfaces; registry authority is fixed to the user's Codkit home.
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { createWorkspace } from '../lib/workspaceCreate.ts';
import { finishWorkspace } from '../lib/workspaceFinish.ts';
import { removeWorkspace } from '../lib/workspaceRemove.ts';
import { findWorkspace, readWorkspaceRegistry, workspaceRegistryRoot } from '../lib/workspaceRegistry.ts';
import { resolveWorkspaceType } from '../lib/workspaceType.ts';
import type { WorkspaceRecord } from '../lib/workspaceRegistry.ts';
import { commandFlagValue, EXIT_OK, forkResolution, patchesRoot } from '../lib/command.ts';
import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { ckError } from '../lib/messages.ts';

function name(ctx: CommandContext): string {
	const value = ctx.args[0];
	if (value === undefined) throw ckError('CONFIG', 'workspace name or UUID is required');
	return value;
}
function required(ctx: CommandContext, flag: string): string {
	const value = commandFlagValue(ctx.commandFlags, flag);
	if (value === null || value.trim() === '') throw ckError('CONFIG', `workspace create requires ${flag}`);
	return value;
}
function emit(ctx: CommandContext, record: WorkspaceRecord): number {
	ctx.out.info(`${record.name}: ${record.state} (${record.id})`);
	ctx.out.info(`patchset: ${record.patchset.path}`);
	ctx.out.info(`fork: ${record.fork.path}`);
	ctx.out.setData({ workspace: z.json().parse(record) });
	return EXIT_OK;
}
async function create(ctx: CommandContext): Promise<number> {
	const workspaceName = name(ctx);
	const directory = required(ctx, '--dir');
	const owner = { id: required(ctx, '--owner'), session: required(ctx, '--session') };
	const patchesRepository = patchesRoot(ctx);
	const forkRepository = forkResolution(ctx).path;
	const ref = commandFlagValue(ctx.commandFlags, '--ref');
	const registryRoot = workspaceRegistryRoot();
	mkdirSync(registryRoot, { recursive: true });
	return emit(
		ctx,
		createWorkspace({
			registryRoot,
			name: workspaceName,
			directory,
			owner,
			patchesRepository,
			forkRepository,
			...(ref === null ? {} : { patchsetRef: ref })
		})
	);
}
async function list(ctx: CommandContext): Promise<number> {
	const registry = readWorkspaceRegistry(workspaceRegistryRoot());
	for (const record of registry.workspaces) ctx.out.info(`${record.name}: ${record.state} (${record.id})`);
	ctx.out.setData(z.json().parse(registry));
	return EXIT_OK;
}
async function show(ctx: CommandContext): Promise<number> {
	return emit(ctx, findWorkspace(readWorkspaceRegistry(workspaceRegistryRoot()), name(ctx)));
}
async function finish(ctx: CommandContext): Promise<number> {
	const registryRoot = workspaceRegistryRoot();
	const workspaceName = name(ctx);
	const record = findWorkspace(readWorkspaceRegistry(registryRoot), workspaceName);
	const type = await resolveWorkspaceType(record);
	ctx.out.setProjectType(type.id);
	return emit(ctx, finishWorkspace({ registryRoot, name: workspaceName, type }));
}
async function remove(ctx: CommandContext): Promise<number> {
	return emit(ctx, removeWorkspace({ registryRoot: workspaceRegistryRoot(), name: name(ctx) }));
}

const management = { configMode: 'none', roots: 'none', resolveRoots: false, maxArgs: 1 } as const;
export const workspaceCommands: readonly CommandDefinition[] = [
	{ ...management, name: 'workspace', summary: 'manage named local patchset/fork worktree pairs', namespace: true, maxArgs: 0, run: list },
	{
		configMode: 'none',
		name: 'workspace create',
		summary: 'create or resume an isolated worktree pair',
		maxArgs: 1,
		commandFlags: ['--dir', '--owner', '--session', '--ref'],
		run: create
	},
	{ ...management, name: 'workspace list', summary: 'list the user-controlled workspace registry', maxArgs: 0, run: list },
	{ ...management, name: 'workspace show', summary: 'show a workspace record by name or UUID', run: show },
	{ ...management, name: 'workspace finish', summary: 'seal clean/save proof for a workspace pair', run: finish },
	{ ...management, name: 'workspace remove', summary: 'remove a finished pair while retaining its heads and journal', run: remove }
];
