/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-ENGINE-IS-BLIND */
// The seam of the extraction that is still open.
//
// Two areas of the contract are answered here as data and not yet as behaviour:
// the codecs of the brand-image containers and the readers of the upgrade
// advisory. Their behaviour still lives inside the engine - `imageset*.ts`
// branch on the container by name, and `cycleAdvisory.ts` is typed by the
// literal paths it reads - and moving it is the re-architecture of phase P2-3,
// where the blindness gate of ##TYPE-ENGINE-IS-BLIND is measured.
//
// Until then the type states the data half of both answers, which is what the
// engine consults, and the behaviour half refuses loudly. Nothing in the engine
// calls it: a call would mean the engine believed the extraction was finished,
// and a silent wrong answer would be far worse than this refusal.

/** The one marker the open half of the extraction is named by. */
export const DEFERRED_PHASE = 'P2-3';

/**
 * Refuse an answer whose behaviour has not been extracted yet, naming the area
 * and the engine module that still owns it.
 */
export function notAnsweredHereYet(area: string, engineModule: string): never {
	throw new Error(
		`@codkit/type-vscode: ${area} is still answered inside the engine (${engineModule}); ` +
			`moving it into the type is phase ${DEFERRED_PHASE}, so this function must not be called yet`
	);
}
