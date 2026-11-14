import { AuthPage } from "#/components/auth-page";
import { LiveButton } from "#/components/live-button";
import type { LegalLinks } from "#/lib/legal";
import { useOpenDemo } from "#/lib/use-open-demo";

/**
 * The way into the public demo, which has no accounts to sign in to: each visitor gets a private
 * sandbox, and this opens it.
 */
export function DemoStart({
	legal,
	title = "Try Gateweave Agents",
	again = false,
}: {
	legal: LegalLinks | undefined;
	title?: string;
	/** The visitor's sandbox is gone, and they are opening another. */
	again?: boolean;
}) {
	const open = useOpenDemo();

	return (
		<AuthPage
			legal={legal}
			title={title}
			description="See which coding agents work in which repositories, keep what they read in one place, and run teams of agents."
		>
			<div className="space-y-3 text-sm text-muted-foreground">
				{again && <p>Your demo workspace has been deleted. You can open a new one.</p>}
				<p>
					You get a private sample workspace for a made-up company, Acme: repositories with the
					coding agents found in them, a library, a setup, a wiki, and a team of three agents with
					past runs. Change anything you like.
				</p>
				<p>
					The agents answer from a script, so nothing you type reaches a model. Nobody else sees
					your workspace, and it is deleted a day after you open it.
				</p>
			</div>
			<LiveButton className="w-full" onClick={open}>
				Open the demo
			</LiveButton>
			<p className="text-center text-xs text-muted-foreground">
				Or{" "}
				<a
					className="underline underline-offset-4 hover:text-foreground"
					href="https://github.com/gateweavehq/agents"
				>
					deploy your own
				</a>
				, free and open source.
			</p>
		</AuthPage>
	);
}
