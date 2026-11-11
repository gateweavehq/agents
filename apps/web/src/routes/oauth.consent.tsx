import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { LegalLinks } from "#/components/legal-links";
import { Button } from "#/components/ui/button";
import { authClient, inAuthorizationFlow } from "#/lib/auth-client";
import { getConsentRequest } from "#/lib/oauth";
import { getLegalLinks } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

// Better Auth sends people here with the signed authorization request in the query. Loose, so
// none of it is dropped: the OAuth client plugin posts the whole query back with the decision.
const consentSearch = z.looseObject({
	client_id: z.string().catch(""),
	redirect_uri: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/oauth/consent")({
	validateSearch: consentSearch,
	loaderDeps: ({ search }) => ({ clientId: search.client_id }),
	loader: async ({ deps }) => {
		const [request, legal] = await Promise.all([
			deps.clientId ? getConsentRequest({ data: deps.clientId }) : null,
			getLegalLinks(),
		]);
		return { request, legal };
	},
	component: ConsentPage,
});

function ConsentPage() {
	const { request } = Route.useLoaderData();
	const search = Route.useSearch();
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const [pending, setPending] = useState(false);
	useDocumentTitle("Authorize app");

	if (!request || !inAuthorizationFlow(searchStr)) {
		return (
			<Card title="This request is no longer valid">
				<p className="text-sm text-muted-foreground">
					Start again from the app that wants to connect to Gateweave Agents.
				</p>
				<Button asChild variant="outline" className="w-full">
					<Link to="/">Go to Gateweave Agents</Link>
				</Button>
			</Card>
		);
	}

	if (!request.viewer) {
		return (
			<Card title="Your session has ended">
				<p className="text-sm text-muted-foreground">
					Start again from the app that wants to connect to Gateweave Agents, and sign in when
					asked.
				</p>
			</Card>
		);
	}

	async function decide(accept: boolean) {
		setPending(true);
		const { error } = await authClient.$fetch("/oauth2/consent", {
			method: "POST",
			body: { accept },
		});
		// On success the auth client follows the redirect back to the app.
		if (error) {
			setPending(false);
			toast.error("Something went wrong", { description: error.message });
		}
	}

	const { clientName, viewer } = request;
	return (
		<Card title={`Allow ${clientName} to use Gateweave Agents?`}>
			<p className="text-sm text-muted-foreground">
				It will act as you, <span className="text-foreground">{viewer.email}</span>: it can see the
				names of the workspaces you belong to, and nothing else yet.
			</p>
			<p className="text-sm text-muted-foreground">
				Then you go back to{" "}
				<span className="font-medium text-foreground">{destination(search.redirect_uri)}</span>. Any
				app can give itself any name, so only allow this if you just connected {clientName}{" "}
				yourself.
			</p>
			<div className="space-y-2">
				<Button className="w-full" onClick={() => decide(true)} disabled={pending}>
					Allow
				</Button>
				<Button variant="ghost" className="w-full" onClick={() => decide(false)} disabled={pending}>
					Deny
				</Button>
			</div>
		</Card>
	);
}

/** Where the grant goes, in terms a person can check. */
function destination(redirectUri: string | undefined): string {
	if (!redirectUri) return "the app";
	try {
		const url = new URL(redirectUri);
		if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
			return "an app on this computer";
		}
		return url.protocol === "https:" || url.protocol === "http:" ? url.host : url.protocol;
	} catch {
		return "the app";
	}
}

function Card({ title, children }: { title: string; children: ReactNode }) {
	const { legal } = Route.useLoaderData();
	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-sm space-y-6">
				<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
				{children}
				<LegalLinks links={legal} />
			</div>
		</main>
	);
}
