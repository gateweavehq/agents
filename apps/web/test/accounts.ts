import { expect } from "vitest";
import type { startAgents } from "./agents-worker";

type Agents = Awaited<ReturnType<typeof startAgents>>;

let clients = 0;

/** Signs up a new person, from an address of their own so sign-up limits stay out of the way. */
export async function signUp(agents: Agents, origin: string, name: string) {
	const headers = {
		"content-type": "application/json",
		origin,
		"cf-connecting-ip": `203.0.113.${++clients}`,
	};
	const response = await agents.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers,
		body: JSON.stringify({ name, email: `${name}@example.com`, password: "a-long-password" }),
	});
	expect(response.status).toBe(200);
	const { user } = (await response.json()) as { user: { id: string } };
	const cookie = response.headers
		.getSetCookie()
		.map((header) => header.split(";")[0])
		.join("; ");
	return { userId: user.id, headers: { ...headers, cookie } };
}

/** Creates a workspace as the person whose headers these are. Returns its id. */
export async function createWorkspace(
	agents: Agents,
	origin: string,
	headers: Record<string, string>,
	slug: string,
) {
	const response = await agents.fetch(`${origin}/api/auth/organization/create`, {
		method: "POST",
		headers,
		body: JSON.stringify({ name: slug, slug }),
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as { id: string }).id;
}
