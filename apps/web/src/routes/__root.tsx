import { TanStackDevtools } from "@tanstack/react-devtools";
import { createRootRoute, HeadContent, Link, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";
import { DemoOpening, useOpeningActive } from "#/components/demo/demo-opening";
import { Button } from "#/components/ui/button";
import { Toaster } from "#/components/ui/sonner";
import { Notice } from "#/components/workspace/notice";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Gateweave Agents" },
			{
				name: "description",
				content:
					"See which AI agents work in which repositories, and keep their setup in one place.",
			},
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
			{ rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
		],
	}),
	shellComponent: RootDocument,
	notFoundComponent: NotFound,
});

function RootDocument({ children }: { children: ReactNode }) {
	// Behind the demo's opening screen, nothing should take focus or clicks.
	const opening = useOpeningActive();

	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<div className="contents" inert={opening}>
					{children}
				</div>
				<DemoOpening />
				<Toaster />
				{import.meta.env.DEV && (
					<TanStackDevtools
						config={{ position: "bottom-right" }}
						plugins={[{ name: "TanStack Router", render: <TanStackRouterDevtoolsPanel /> }]}
					/>
				)}
				<Scripts />
			</body>
		</html>
	);
}

function NotFound() {
	return (
		<main className="grid min-h-svh place-items-center">
			<Notice
				title="Page not found"
				action={
					<Button asChild variant="outline">
						<Link to="/">Go to Gateweave Agents</Link>
					</Button>
				}
			>
				Check the address, or start from your workspaces.
			</Notice>
		</main>
	);
}
