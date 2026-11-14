import { Link } from "@tanstack/react-router";
import { Activity, FolderGit2, MessagesSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { useWorkspace } from "#/components/workspace/context";
import { CLOUD_URL, REPOSITORY_URL } from "#/lib/demo-links";
import { useOpening } from "#/lib/demo-opening";

const link = "font-medium text-foreground underline underline-offset-4";

/**
 * Shown once per sandbox, the first time it is on screen: what Agents does that is worth trying.
 * It waits for the opening screen to go, and is marked seen when it appears, so a reload or a
 * second tab does not bring it back.
 */
export function DemoWelcome() {
	const { id, slug } = useWorkspace();
	const opening = useOpening();
	const [open, setOpen] = useState(false);
	const waiting = opening.status !== "idle";

	useEffect(() => {
		if (waiting) return;
		const key = `agents:demo-welcome:${id}`;
		try {
			if (localStorage.getItem(key)) return;
			localStorage.setItem(key, "1");
		} catch {
			// Without storage it would show on every load; better not to show it at all.
			return;
		}
		setOpen(true);
	}, [waiting, id]);

	const close = () => setOpen(false);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>This workspace is yours for a day</DialogTitle>
					<DialogDescription>
						Nobody else can see it, and it is deleted a day after you opened it. Acme is made up and
						its agents answer from a script, so nothing you type reaches a model. Three things worth
						trying:
					</DialogDescription>
				</DialogHeader>
				<ul className="space-y-4 text-sm">
					<li className="flex gap-3">
						<MessagesSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
						<p>
							<Link
								to="/$workspace/chat"
								params={{ workspace: slug }}
								className={link}
								onClick={close}
							>
								Chat
							</Link>{" "}
							with the Release crew, and watch its lead hand work to the reviewer and the writer.
						</p>
					</li>
					<li className="flex gap-3">
						<Activity className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
						<p>
							Open a past{" "}
							<Link
								to="/$workspace/runs"
								params={{ workspace: slug }}
								className={link}
								onClick={close}
							>
								run
							</Link>{" "}
							to see each step, its tokens and what it cost.
						</p>
					</li>
					<li className="flex gap-3">
						<FolderGit2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
						<p>
							See which coding agents{" "}
							<Link
								to="/$workspace/repositories"
								params={{ workspace: slug }}
								className={link}
								onClick={close}
							>
								each repository
							</Link>{" "}
							has, and how far storefront has drifted from its setup.
						</p>
					</li>
				</ul>
				<p className="text-sm text-muted-foreground">
					Like it?{" "}
					<a href={CLOUD_URL} className={link} target="_blank" rel="noreferrer">
						Use it on Gateweave Cloud
					</a>
					, or{" "}
					<a href={REPOSITORY_URL} className={link} target="_blank" rel="noreferrer">
						deploy your own
					</a>
					.
				</p>
				<Button onClick={close}>Start exploring</Button>
			</DialogContent>
		</Dialog>
	);
}
