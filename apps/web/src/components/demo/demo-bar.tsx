import { BookOpen, Cloud, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { CLOUD_TOOLTIP, CLOUD_URL, REPOSITORY_URL, SELF_HOSTING_URL } from "#/lib/demo-links";
import { deletionLabel } from "#/lib/demo-time";
import { useOpenDemo } from "#/lib/use-open-demo";

const HIDDEN_KEY = "agents:demo-bar-hidden";

export interface DemoBarState {
	/** Shown, so the page leaves room for it. */
	visible: boolean;
	hide: () => void;
}

/** Whether the demo bar is up: on the demo, until the visitor hides it for this tab. */
export function useDemoBar(demo: boolean | undefined): DemoBarState {
	const [hidden, setHidden] = useState(() => {
		try {
			return sessionStorage.getItem(HIDDEN_KEY) === "1";
		} catch {
			return false;
		}
	});
	return {
		visible: Boolean(demo) && !hidden,
		hide: () => {
			setHidden(true);
			try {
				sessionStorage.setItem(HIDDEN_KEY, "1");
			} catch {
				// Private mode: it comes back on the next page, which is harmless.
			}
		},
	};
}

/**
 * A pill at the bottom of the public demo: that nothing here lasts, how long it has, and where to
 * go next, whether that is Gateweave Cloud or a deployment of one's own.
 */
export function DemoBar({ bar }: { bar: DemoBarState }) {
	const { demoCreatedAt } = useWorkspace();
	const openDemo = useOpenDemo();
	const [confirming, setConfirming] = useState(false);
	const now = useMinute();
	if (!bar.visible) return null;

	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:left-60">
			<section
				aria-label="Demo"
				className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1.5 rounded-2xl border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg"
			>
				<span className="hidden rounded-full bg-accent px-2 py-0.5 font-medium tracking-wide uppercase sm:inline">
					Demo
				</span>
				{demoCreatedAt !== undefined && (
					<span className="px-1 text-muted-foreground">{deletionLabel(demoCreatedAt, now)}</span>
				)}
				{confirming ? (
					<span className="flex flex-wrap items-center justify-center gap-1">
						<span className="px-1">Start over with a fresh workspace?</span>
						<Button
							size="sm"
							variant="secondary"
							onClick={() => {
								setConfirming(false);
								openDemo();
							}}
						>
							Start over
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
							Cancel
						</Button>
					</span>
				) : (
					<>
						<Button
							size="sm"
							variant="ghost"
							aria-label="Start over"
							title="Start over with a fresh workspace"
							onClick={() => setConfirming(true)}
						>
							<RotateCcw />
							<span className="hidden sm:inline">Start over</span>
						</Button>
						<Button size="sm" asChild title={CLOUD_TOOLTIP}>
							<a href={CLOUD_URL} target="_blank" rel="noreferrer">
								<Cloud />
								Gateweave Cloud
							</a>
						</Button>
						<Button size="sm" variant="outline" asChild>
							<a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
								Deploy your own
							</a>
						</Button>
						<Button size="icon" variant="ghost" className="size-8" asChild>
							<a
								href={SELF_HOSTING_URL}
								target="_blank"
								rel="noreferrer"
								aria-label="Self-hosting guide"
								title="Self-hosting guide"
							>
								<BookOpen />
							</a>
						</Button>
						<Button
							size="icon"
							variant="ghost"
							className="size-8"
							aria-label="Hide this bar"
							title="Hide this bar"
							onClick={bar.hide}
						>
							<X />
						</Button>
					</>
				)}
			</section>
		</div>
	);
}

/** The time, refreshed each minute, for a countdown that only speaks in hours and minutes. */
function useMinute(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, []);
	return now;
}
