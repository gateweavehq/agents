import { describe, expect, it } from "vitest";
import { trackConnectInput, trackConnectVerifier, trackExchangeAnswer } from "../src";

const ANSWER = {
	agentKey: `gwt_${"k".repeat(43)}`,
	webhookSecret: "whsec_c3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nz",
	agent: { id: "1ffbe6d5-0000-4000-8000-000000000001", memberId: "m_1", name: "Coder" },
	workspace: { id: "w_1", slug: "acme", name: "Acme" },
	webhook: { id: "h_1" },
	undo: "undo.token",
};

describe("a verifier", () => {
	it("is what PKCE allows", () => {
		expect(trackConnectVerifier.safeParse("a".repeat(64)).success).toBe(true);
		expect(trackConnectVerifier.safeParse("short").success).toBe(false);
		expect(trackConnectVerifier.safeParse(`${"a".repeat(42)}!`).success).toBe(false);
		expect(trackConnectVerifier.safeParse("a".repeat(129)).success).toBe(false);
	});
});

describe("what is chosen before leaving", () => {
	it("takes a repository and an engine for work, and neither for triage", () => {
		const base = {
			trackUrl: "https://track.example.com/anything",
			provider: "anthropic",
			model: "m",
		};
		expect(
			trackConnectInput.safeParse({
				...base,
				purpose: "work",
				engine: "gateweave",
				repositoryId: "r",
			}).success,
		).toBe(true);
		expect(
			trackConnectInput.safeParse({ ...base, purpose: "work", engine: "gateweave" }).success,
		).toBe(false);
		const triage = trackConnectInput.parse({ ...base, purpose: "triage" });
		expect(triage.trackUrl).toBe("https://track.example.com");
		expect(trackConnectInput.safeParse({ ...base, purpose: "mail" }).success).toBe(false);
	});
});

describe("Track's answer to the exchange", () => {
	it("accepts what Track makes", () => {
		expect(trackExchangeAnswer.parse(ANSWER).agent.id).toBe(ANSWER.agent.id);
	});

	it.each([
		["agentKey", undefined],
		["webhookSecret", undefined],
		["agent", undefined],
		["workspace", undefined],
		["webhook", undefined],
		["undo", undefined],
	])("refuses an answer without %s", (field) => {
		const { [field]: _gone, ...rest } = ANSWER as Record<string, unknown>;
		expect(trackExchangeAnswer.safeParse(rest).success).toBe(false);
	});

	it("refuses a key or a secret in another shape, and wrong types", () => {
		const refuses = (patch: Record<string, unknown>) =>
			expect(trackExchangeAnswer.safeParse({ ...ANSWER, ...patch }).success).toBe(false);
		refuses({ agentKey: "sk-ant-api03-nope" });
		refuses({ agentKey: `gwt_${"k".repeat(42)}` });
		refuses({ webhookSecret: "whsec_short" });
		refuses({ webhookSecret: "plain" });
		refuses({ agent: { ...ANSWER.agent, id: 7 } });
		refuses({ agent: { ...ANSWER.agent, id: "" } });
		refuses({ workspace: { ...ANSWER.workspace, slug: null } });
		refuses({ undo: "" });
		refuses({ undo: "u".repeat(5000) });
		refuses({ webhook: { id: "h".repeat(65) } });
	});
});
