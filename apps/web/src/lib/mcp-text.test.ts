// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${VAR}" references are what is under test
import { expect, it } from "vitest";
import { formatHeaders, parseHeaders } from "./mcp-text";

it("reads headers as a request writes them, and back", () => {
	const text = "Authorization: Bearer ${ACME_TOKEN}\n\n# the team\n  X-Team:${ACME_TEAM}  \n";
	const parsed = parseHeaders(text);
	expect(parsed).toEqual({
		ok: true,
		headers: [
			{ name: "Authorization", value: "Bearer ${ACME_TOKEN}" },
			{ name: "X-Team", value: "${ACME_TEAM}" },
		],
	});
	if (parsed.ok) {
		expect(formatHeaders(parsed.headers)).toBe(
			"Authorization: Bearer ${ACME_TOKEN}\nX-Team: ${ACME_TEAM}",
		);
	}
});

it("says which line is not a header", () => {
	expect(parseHeaders("X-Team: ${A}\nBearer ${TOKEN}")).toEqual({
		ok: false,
		error: "Line 2: write Name: value",
	});
	expect(parseHeaders(": ${A}")).toEqual({ ok: false, error: "Line 1: write Name: value" });
});
