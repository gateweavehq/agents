// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${VAR}" references are what is under test
import { describe, expect, it } from "vitest";
import { canonicalJson, redact } from "../src/redaction";

describe("redact", () => {
	it("replaces every value under env and headers, at any depth", () => {
		expect(
			redact({
				env: { A: "secret", B: 1, C: { nested: "secret" } },
				outer: { headers: { Authorization: "Bearer secret" } },
				http_headers: { "X-Key": "secret" },
				list: [{ env: { D: "secret" } }],
			}),
		).toEqual({
			env: { A: "<redacted>", B: "<redacted>", C: "<redacted>" },
			outer: { headers: { Authorization: "<redacted>" } },
			http_headers: { "X-Key": "<redacted>" },
			list: [{ env: { D: "<redacted>" } }],
		});
	});

	it("replaces an env that is not an object as a whole", () => {
		expect(redact({ env: "A=secret" })).toEqual({ env: "<redacted>" });
	});

	it("replaces credentials by key name but keeps references to them", () => {
		expect(
			redact({
				clientSecret: "secret",
				CLIENT_SECRET: "secret",
				apiKey: "secret",
				token: "${TOKEN}",
				bearer_token_env_var: "FIGMA_TOKEN",
				scopes: ["read"],
			}),
		).toEqual({
			clientSecret: "<redacted>",
			CLIENT_SECRET: "<redacted>",
			apiKey: "<redacted>",
			token: "${TOKEN}",
			bearer_token_env_var: "FIGMA_TOKEN",
			scopes: ["read"],
		});
	});

	it("redacts credentials in arguments and URLs", () => {
		expect(
			redact({
				args: [
					"--token",
					"secret",
					"--verbose",
					"-e",
					"API_KEY=secret",
					"--password=secret",
					"--key",
					"${KEY}",
					"plain",
				],
				url: "https://user:secret@example.com/mcp?token=secret&q=1&sig=${SIG}",
			}),
		).toEqual({
			args: [
				"--token",
				"<redacted>",
				"--verbose",
				"-e",
				"API_KEY=<redacted>",
				"--password=<redacted>",
				"--key",
				"${KEY}",
				"plain",
			],
			url: "https://<redacted>@example.com/mcp?token=<redacted>&q=1&sig=${SIG}",
		});
	});
});

describe("canonicalJson", () => {
	it("sorts keys, indents by two and ends with a newline", () => {
		expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
			'{\n  "a": {\n    "c": null,\n    "d": [\n      2,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
		);
	});
});
