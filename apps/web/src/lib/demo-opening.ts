import { useSyncExternalStore } from "react";

// The screen shown while the demo makes a visitor's sandbox. Its state lives here, outside the
// routes, because it has to stay up across the client navigation from /login to the workspace.

/**
 * The server's real phases, in the order `startDemoSandbox` and `fillDemo` go through them, then
 * the browser's own.
 */
export const OPENING_STEPS = [
	"Making you a private account",
	"Creating the Acme workspace",
	"Scanning three sample repositories",
	"Setting up a team of three agents",
	"Writing their past conversations",
	"Opening it on this device",
] as const;

export type StepState = "idle" | "active" | "done";

/**
 * When the first four steps turn done on their own, tuned to a sandbox taking about 7.4 s. The
 * fifth has no timer: it is the server's last phase, and the longest, so only the server's answer
 * finishes it.
 */
export const STEP_TIMERS_MS = [900, 2200, 4200, 6000] as const;

/** How long after the server answers the last step waits for the workspace before giving up. */
export const WORKSPACE_WAIT_CAP_MS = 5000;

/** How long "Ready" stays before the screen goes. */
export const READY_HOLD_MS = 700;

export interface OpeningProgress {
	/** Time since the request began. */
	elapsedMs: number;
	/** Time since the server answered, or null while it has not. */
	sinceServerMs: number | null;
	/** The workspace's first page has been on screen. */
	workspaceShown: boolean;
}

/**
 * Each step's state. A step never completes before what it stands for: the first four follow
 * timers (or the server, if it is quicker), the fifth needs the server, and the last needs the
 * workspace's first page, or the cap so a slow device never hangs on it.
 */
export function stepStates({
	elapsedMs,
	sinceServerMs,
	workspaceShown,
}: OpeningProgress): StepState[] {
	const serverDone = sinceServerMs !== null;
	const done = [
		...STEP_TIMERS_MS.map((at) => serverDone || elapsedMs >= at),
		serverDone,
		serverDone && (workspaceShown || sinceServerMs >= WORKSPACE_WAIT_CAP_MS),
	];
	const active = done.indexOf(false);
	return done.map((isDone, index) => (isDone ? "done" : index === active ? "active" : "idle"));
}

export type OpeningState =
	| { status: "idle" }
	| {
			status: "running";
			startedAt: number;
			serverDoneAt: number | null;
			slug: string | null;
			workspaceShown: boolean;
	  }
	| { status: "failed"; message: string };

const IDLE: OpeningState = { status: "idle" };

let state = IDLE as OpeningState;
let retry: (() => void) | null = null;
const listeners = new Set<() => void>();

function set(next: OpeningState) {
	state = next;
	for (const listener of listeners) listener();
}

/** The state as it is now, for code that has awaited since it last looked. */
function current(): OpeningState {
	return state;
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useOpening(): OpeningState {
	return useSyncExternalStore(
		subscribe,
		() => state,
		() => IDLE,
	);
}

export const GENERIC_FAILURE = "Could not open the demo. Try again in a moment.";

/**
 * Makes a sandbox and goes into it. `enter` navigates to the new workspace; the screen stays up
 * until its first page shows.
 */
export function openDemoSandbox(enter: (slug: string) => Promise<void>): void {
	if (state.status === "running") return;
	retry = () => openDemoSandbox(enter);
	set({
		status: "running",
		startedAt: Date.now(),
		serverDoneAt: null,
		slug: null,
		workspaceShown: false,
	});
	void (async () => {
		try {
			// Loaded here, not at the top: the root imports this module, and the server function would
			// otherwise ride in the main bundle of every deployment.
			const { startDemo } = await import("#/lib/demo");
			const { slug } = await startDemo();
			const now = current();
			if (now.status !== "running") return;
			set({ ...now, serverDoneAt: Date.now(), slug });
			await enter(slug);
		} catch (caught) {
			set({
				status: "failed",
				message: caught instanceof Error && caught.message ? caught.message : GENERIC_FAILURE,
			});
		}
	})();
}

export function retryOpening(): void {
	const again = retry;
	set(IDLE);
	again?.();
}

export function closeOpening(): void {
	set(IDLE);
}

/** Called by a workspace's overview once it is on screen; only the workspace being opened counts. */
export function noteWorkspaceShown(slug: string): void {
	if (state.status !== "running" || state.slug !== slug || state.workspaceShown) return;
	set({ ...state, workspaceShown: true });
}
