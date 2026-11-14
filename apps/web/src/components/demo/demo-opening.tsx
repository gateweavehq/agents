import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	closeOpening,
	OPENING_STEPS,
	type OpeningState,
	READY_HOLD_MS,
	retryOpening,
	type StepState,
	stepStates,
	useOpening,
} from "#/lib/demo-opening";
import { cn } from "#/lib/utils";

/** Whether the opening screen is up, so the page behind it can be made inert. */
export function useOpeningActive(): boolean {
	return useOpening().status !== "idle";
}

/**
 * Covers the page while the demo makes a visitor's sandbox, and shows the phases the server goes
 * through. It lives in the root so it survives the move from the login page to the workspace.
 */
export function DemoOpening() {
	const opening = useOpening();
	if (opening.status === "idle") return null;
	return <OpeningPanel opening={opening} />;
}

function OpeningPanel({ opening }: { opening: Exclude<OpeningState, { status: "idle" }> }) {
	const now = useNow(opening.status === "running");
	const failed = opening.status === "failed";
	const states =
		opening.status === "running"
			? stepStates({
					elapsedMs: now - opening.startedAt,
					sinceServerMs: opening.serverDoneAt === null ? null : now - opening.serverDoneAt,
					workspaceShown: opening.workspaceShown,
				})
			: [];
	const ready = states.length > 0 && states.every((step) => step === "done");
	const current = states.indexOf("active");

	useEffect(() => {
		if (!ready) return;
		const timer = setTimeout(closeOpening, READY_HOLD_MS);
		return () => clearTimeout(timer);
	}, [ready]);

	// Focus goes to the screen, and to the retry button when it fails, so keys never land behind it.
	const panel = useRef<HTMLDivElement>(null);
	const retry = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		(failed ? retry.current : panel.current)?.focus();
	}, [failed]);

	const line = failed
		? opening.message
		: ready
			? "Ready"
			: current === -1
				? "Opening your demo workspace…"
				: `${OPENING_STEPS[current]}…`;

	return (
		<div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-background p-6">
			<div
				ref={panel}
				tabIndex={-1}
				className="w-full max-w-sm space-y-6 outline-none"
				aria-busy={!failed && !ready}
			>
				<div className="flex flex-col items-center gap-3 text-center">
					<AgentsMark className="size-12" />
					<div className="space-y-1">
						<p className="text-lg font-semibold tracking-tight">Gateweave Agents</p>
						<p className="text-sm text-muted-foreground">
							{failed ? "We could not open your workspace" : "Opening your demo workspace…"}
						</p>
					</div>
				</div>

				{/* One live region, so a screen reader hears the step that began, not the whole list. */}
				<p
					role={failed ? "alert" : "status"}
					aria-live={failed ? "assertive" : "polite"}
					className={cn("text-center text-sm", failed ? "text-destructive" : "sr-only")}
				>
					{line}
				</p>

				{failed ? (
					<div className="flex justify-center gap-2">
						<Button ref={retry} onClick={retryOpening}>
							Try again
						</Button>
						<Button variant="outline" onClick={closeOpening}>
							Back
						</Button>
					</div>
				) : (
					<ol className="mx-auto w-fit space-y-3" aria-label="Progress">
						{OPENING_STEPS.map((label, index) => (
							<Step key={label} label={label} state={states[index] ?? "idle"} />
						))}
					</ol>
				)}
			</div>
		</div>
	);
}

function Step({ label, state }: { label: string; state: StepState }) {
	return (
		<li
			className={cn(
				"flex items-center gap-3 text-sm transition-colors",
				state === "idle" && "text-muted-foreground",
				state === "active" && "font-medium text-foreground",
				state === "done" && "text-foreground/80",
			)}
			aria-current={state === "active" ? "step" : undefined}
		>
			<Marker state={state} />
			<span>{label}</span>
		</li>
	);
}

/** Idle is a grey ring, active an indigo one that fills, done a green disc with a check. */
function Marker({ state }: { state: StepState }) {
	if (state === "done") {
		return (
			<span className="grid size-5 shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
				<Check className="size-3" strokeWidth={3} />
			</span>
		);
	}
	return (
		<svg viewBox="0 0 20 20" className="size-5 shrink-0 -rotate-90" aria-hidden="true">
			<title>{state === "active" ? "In progress" : "Waiting"}</title>
			<circle
				cx="10"
				cy="10"
				r="8"
				fill="none"
				strokeWidth="2.5"
				className="stroke-muted-foreground/30"
			/>
			{state === "active" && (
				<circle
					cx="10"
					cy="10"
					r="8"
					fill="none"
					strokeWidth="2.5"
					strokeLinecap="round"
					pathLength="100"
					className="demo-ring stroke-indigo-500"
				/>
			)}
		</svg>
	);
}

/** Agents' own mark, as in favicon.svg. */
function AgentsMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 32 32" className={className} role="img" aria-label="Gateweave Agents">
			<rect width="32" height="32" rx="8" fill="#18181b" />
			<path
				d="M16 9.5L9.5 21.5H22.5Z"
				fill="none"
				stroke="#8b93ff"
				strokeWidth="2.6"
				strokeLinejoin="round"
			/>
			<circle cx="16" cy="9.5" r="3.6" fill="#fafafa" />
			<circle cx="9.5" cy="21.5" r="3.6" fill="#fafafa" />
			<circle cx="22.5" cy="21.5" r="3.6" fill="#fafafa" />
		</svg>
	);
}

/** The current time, refreshed while `running`, so the steps follow their timers. */
function useNow(running: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 100);
		return () => clearInterval(timer);
	}, [running]);
	return now;
}
