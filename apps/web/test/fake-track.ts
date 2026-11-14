import { createHash, randomBytes } from "node:crypto";
import { TRACK_WORK_TOOLS } from "@gateweave/agents-model";
import { FakeMcpServer, type FakeTool } from "./fake-mcp";

/** What the fake made for one approval, which the tests check never leaves the server. */
export interface Issued {
	agentKey: string;
	webhookSecret: string;
	undo: string;
	agentId: string;
	agentName: string;
	workspace: { id: string; slug: string; name: string };
	webhook: string;
	state: string;
}

const MORE_TOOLS = ["list_workspaces", "create_issue", "create_label", "create_team"];

/**
 * Gateweave Track as the Agents half of connecting it sees it: the approval page's two answers
 * (`approve`, `deny`), `POST /api/connect/exchange` and `/undo` as built in gateweavehq/track#306
 * (the one-time code checked against the challenge, deleted whatever the outcome; every failure
 * `invalid_code`), and its MCP server, which names the agent member as `get_workspace`'s `you`.
 * Pass `handle` to `startAgents` under the host.
 */
export class FakeTrack {
	/** What was asked of the exchange and the undo, in order. */
	readonly exchanges: { code: string; verifier: string }[] = [];
	readonly undos: string[] = [];
	/** Everything made, for checking where it went. */
	readonly issued: Issued[] = [];
	/** How the exchange answers: well, wrongly, or not at all. */
	exchangeMode: "ok" | "invalid_code" | "too_many" | "garbage" | "unusable" = "ok";
	/** How the undo answers; `try_again` is a 500 that is safe to repeat. */
	undoMode: "ok" | "try_again" | "invalid_undo" = "ok";
	/** What `get_workspace` says the key's member is, when it is not the agent made. */
	youId: string | null = null;
	readonly mcp: FakeMcpServer;
	readonly #pending = new Map<string, { challenge: string; issued: Issued }>();

	constructor(readonly origin: string) {
		const tools: FakeTool[] = [...TRACK_WORK_TOOLS, ...MORE_TOOLS].map((name) => ({
			name,
			description: `Track's ${name}`,
			inputSchema: { type: "object", properties: {} },
		}));
		this.mcp = new FakeMcpServer(tools, (name) => {
			const made = this.issued.at(-1);
			const text = (value: unknown) => ({
				content: [{ type: "text" as const, text: JSON.stringify(value) }],
				structuredContent: value,
			});
			if (name === "list_workspaces") {
				return text({ workspaces: [{ slug: made?.workspace.slug ?? "acme", role: "agent" }] });
			}
			if (name === "get_workspace") {
				return text({
					you: { id: this.youId ?? made?.agentId, name: made?.agentName, role: "agent" },
				});
			}
			return text({});
		});
	}

	/**
	 * The person presses Allow on the page the address leads to: Track checks the address as
	 * `/connect/agent` does, makes the agent member and the webhook, and answers with where the
	 * browser goes back to.
	 */
	approve(
		address: string,
		{ workspace = "acme", name }: { workspace?: string; name?: string } = {},
	) {
		const url = new URL(address);
		if (url.origin !== this.origin || url.pathname !== "/connect/agent") {
			throw new Error(`Not Track's approval page: ${address}`);
		}
		const query = url.searchParams;
		const webhook = new URL(query.get("webhook") ?? "");
		const back = new URL(query.get("return") ?? "");
		// Track refuses a webhook and a return address on two origins.
		if (webhook.origin !== back.origin) throw new Error("webhook and return differ in origin");
		// And a state or a challenge outside these, as `checkConnectRequest` in Track does.
		if (!/^[A-Za-z0-9_-]{1,200}$/.test(query.get("state") ?? "")) {
			throw new Error("The request's state is missing or malformed.");
		}
		if (!/^[A-Za-z0-9_-]{43}$/.test(query.get("challenge") ?? "")) {
			throw new Error("The request's challenge is missing or malformed.");
		}
		const code = randomBytes(32).toString("base64url");
		const issued: Issued = {
			agentKey: `gwt_${randomBytes(32).toString("base64url")}`.slice(0, 47),
			webhookSecret: `whsec_${randomBytes(24).toString("base64")}`,
			undo: `undo.${randomBytes(24).toString("base64url")}`,
			agentId: crypto.randomUUID(),
			agentName: name ?? query.get("name") ?? "Agent",
			workspace: { id: `w_${workspace}`, slug: workspace, name: workspace.toUpperCase() },
			webhook: webhook.href,
			state: query.get("state") ?? "",
		};
		this.issued.push(issued);
		this.#pending.set(code, { challenge: query.get("challenge") ?? "", issued });
		back.searchParams.set("code", code);
		back.searchParams.set("state", issued.state);
		return back.href;
	}

	/** The person presses Cancel. */
	deny(address: string) {
		const query = new URL(address).searchParams;
		const back = new URL(query.get("return") ?? "");
		back.searchParams.set("error", "denied");
		back.searchParams.set("state", query.get("state") ?? "");
		return back.href;
	}

	handle = async (request: Request): Promise<Response> => {
		const path = new URL(request.url).pathname;
		if (path === "/mcp") return this.mcp.handle(request);
		if (request.method !== "POST") return new Response(null, { status: 404 });
		if (path === "/api/connect/exchange") return this.#exchange(request);
		if (path === "/api/connect/undo") return this.#undo(request);
		return new Response(null, { status: 404 });
	};

	async #exchange(request: Request): Promise<Response> {
		const { code, verifier } = (await request.json()) as { code: string; verifier: string };
		this.exchanges.push({ code, verifier });
		if (this.exchangeMode === "too_many") {
			return Response.json(
				{ error: "too_many_requests" },
				{ status: 429, headers: { "retry-after": "30" } },
			);
		}
		// Deleted whatever the outcome, as Track does.
		const found = this.#pending.get(code);
		this.#pending.delete(code);
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		if (!found || found.challenge !== challenge || this.exchangeMode === "invalid_code") {
			return Response.json({ error: "invalid_code" }, { status: 400 });
		}
		const { issued } = found;
		if (this.exchangeMode === "garbage") return new Response("<html>", { status: 200 });
		const answer = {
			agentKey: this.exchangeMode === "unusable" ? "not-a-key" : issued.agentKey,
			webhookSecret: issued.webhookSecret,
			agent: {
				id: issued.agentId,
				memberId: `m_${issued.agentId.slice(0, 8)}`,
				name: issued.agentName,
			},
			workspace: issued.workspace,
			webhook: { id: "h_1" },
			undo: issued.undo,
		};
		return Response.json(answer);
	}

	async #undo(request: Request): Promise<Response> {
		const { undo } = (await request.json()) as { undo: string };
		this.undos.push(undo);
		if (this.undoMode === "try_again")
			return Response.json({ error: "try_again" }, { status: 500 });
		if (this.undoMode === "invalid_undo") {
			return Response.json({ error: "invalid_undo" }, { status: 400 });
		}
		return Response.json({ ok: true });
	}
}
