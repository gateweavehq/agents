// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${VAR}" references are what is under test
import { expect, it } from "vitest";
import { detect, readMcpConnection } from "../src";
import { assetOf, repo } from "./support";

/** The connection of the server `key` found in `files`, read from what a scan stores. */
function connectionOf(files: Record<string, string>, key: string) {
	const asset = assetOf(detect(repo(files)), key);
	return readMcpConnection(
		asset.files.map(({ path, content }) => ({ path, content: content ?? null })),
	);
}

it("reads a remote server, with each redacted header as the variable named after it", () => {
	const config = JSON.stringify({
		mcpServers: {
			acme: {
				type: "http",
				url: "https://mcp.acme.dev/mcp",
				headers: { Authorization: "Bearer ${ACME_TOKEN}", "X-Team": "platform" },
			},
		},
	});
	expect(connectionOf({ ".mcp.json": config }, ".mcp.json#acme")).toEqual({
		ok: true,
		connection: {
			transport: "http",
			url: "https://mcp.acme.dev/mcp",
			// A scan keeps no header value, so even the reference is gone; the name is what is left.
			headers: [
				{ name: "Authorization", value: { variable: "AUTHORIZATION", prefix: "" } },
				{ name: "X-Team", value: { variable: "X_TEAM", prefix: "" } },
			],
		},
	});
});

it("reads each coding agent's own way of naming the variable behind a header", () => {
	const codex = `[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_TOKEN"
`;
	expect(connectionOf({ ".codex/config.toml": codex }, ".codex/config.toml#figma")).toEqual({
		ok: true,
		connection: {
			transport: "http",
			url: "https://mcp.figma.com/mcp",
			headers: [{ name: "Authorization", value: { variable: "FIGMA_TOKEN", prefix: "Bearer " } }],
		},
	});

	const gemini = JSON.stringify({ mcpServers: { events: { url: "https://events.acme.dev/sse" } } });
	expect(connectionOf({ ".gemini/settings.json": gemini }, ".gemini/settings.json#events")).toEqual(
		{
			ok: true,
			connection: { transport: "sse", url: "https://events.acme.dev/sse", headers: [] },
		},
	);
});

it("reads a reference that a stored header still has", () => {
	const stored = JSON.stringify({
		type: "sse",
		url: "https://mcp.acme.dev/sse",
		headers: { Authorization: "Bearer ${ACME_TOKEN}", "X-Team": "platform" },
	});
	expect(readMcpConnection([{ path: ".mcp.json", content: stored }])).toEqual({
		ok: true,
		connection: {
			transport: "sse",
			url: "https://mcp.acme.dev/sse",
			headers: [
				{ name: "Authorization", value: { variable: "ACME_TOKEN", prefix: "Bearer " } },
				{ name: "X-Team", value: "platform" },
			],
		},
	});
});

it("says what a local server runs, and why a server cannot be read", () => {
	const config = JSON.stringify({
		mcpServers: {
			local: { command: "npx", args: ["-y", "@acme/mcp"] },
			leaky: { url: "https://mcp.acme.dev/mcp?token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
		},
	});
	expect(connectionOf({ ".mcp.json": config }, ".mcp.json#local")).toEqual({
		ok: true,
		connection: { transport: "stdio", command: "npx" },
	});
	expect(connectionOf({ ".mcp.json": config }, ".mcp.json#leaky")).toEqual({
		ok: false,
		message: "url was redacted and has no variable name",
	});
	expect(readMcpConnection([{ path: ".mcp.json", content: null }])).toEqual({
		ok: false,
		message: "The registry did not keep this asset's text",
	});
});
