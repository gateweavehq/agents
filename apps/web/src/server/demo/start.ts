import { eq } from "drizzle-orm";
import { slugProblem } from "../../lib/slug";
import { db, getAuth } from "../auth";
import { schema } from "../db";
import { limitDemoStarts } from "../rate-limit";
import { findRegistry } from "../registry";
import { deleteWorkspaceData } from "../workspace-deletion";
import { assertDemo, DemoError, VISITOR_DOMAIN } from "./mode";
import { WORKSPACE_NAME } from "./sample-data";

/**
 * Gives a visitor a private sandbox: an account only the server can sign in to, and a workspace
 * named Acme with the sample repositories, library, team and history, which cleanup deletes after
 * a day. Returns the workspace slug. The visitor's session cookie is set on the response of the
 * server function that calls this.
 */
export async function startDemoSandbox(headers: Headers): Promise<{ slug: string }> {
	assertDemo();

	// Cloudflare sets this to the address it saw; clients cannot choose it.
	const address = headers.get("cf-connecting-ip") ?? "unknown";
	const allowance = await limitDemoStarts(address);
	if (!allowance.allowed) {
		throw new DemoError(
			"You have opened a lot of demo workspaces. Try again in a little while, or deploy your own.",
		);
	}

	const auth = getAuth();
	// Direct `auth.api` calls skip HTTP: no per-client rate limit and none of the paths the demo
	// refuses, and tanstackStartCookies puts the new session's cookie on the response. The password
	// is never shown to anyone; this account is only ever signed in to by this call.
	const { user } = await auth.api.signUpEmail({
		body: {
			name: "You",
			email: `${crypto.randomUUID()}@${VISITOR_DOMAIN}`,
			password: randomSecret(),
		},
	});

	let workspaceId: string | undefined;
	try {
		const slug = `acme-${randomSuffix(6)}`;
		const problem = slugProblem(slug);
		if (problem) throw new Error(`Demo slug ${slug} is not valid: ${problem}`);
		// Through Better Auth, so its hooks note where the workspace's objects go. No headers: a
		// server call names the owner in the body.
		const workspace = await auth.api.createOrganization({
			body: { name: WORKSPACE_NAME, slug, userId: user.id, keepCurrentActiveOrganization: true },
		});
		workspaceId = workspace.id;
		// One call: the registry fills itself and its past conversations, which are beside it, so
		// the ocean between this Worker and the workspace is crossed once.
		const registry = await findRegistry(db, workspace.id);
		await registry.fillDemo(user.id);
		return { slug };
	} catch (error) {
		// A half-built sandbox is worse than none. Take it all back: the visitor's new session goes
		// with their account, and the page shows the error instead of an empty workspace.
		await discardSandbox(user.id, workspaceId).catch((cleanup: unknown) =>
			console.error("demo: could not discard a failed sandbox", cleanup),
		);
		throw error;
	}
}

async function discardSandbox(userId: string, workspaceId: string | undefined) {
	if (workspaceId) {
		await deleteWorkspaceData(db, workspaceId);
		await db.delete(schema.organization).where(eq(schema.organization.id, workspaceId));
	}
	await db.delete(schema.user).where(eq(schema.user.id, userId));
}

function randomSecret(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function randomSuffix(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	return Array.from(
		crypto.getRandomValues(new Uint8Array(length)),
		(byte) => alphabet[byte % alphabet.length],
	).join("");
}

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
