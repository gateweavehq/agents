import { describe, expect, it } from "vitest";
import { trackMcpUrl, trackTriageInput } from "../src";

const KEY = `gwt_${"a".repeat(43)}`;
const input = (trackUrl: string, agentKey = KEY) =>
	trackTriageInput.safeParse({
		trackUrl,
		agentKey,
		provider: "anthropic",
		model: "claude-haiku-5-5",
	});

describe("Track triage input", () => {
	it("keeps only where Track is, whatever was pasted after it", () => {
		for (const pasted of [
			"https://track.gateweave.com",
			"https://track.gateweave.com/",
			"https://Track.Gateweave.com/acme/issues?view=board#top",
			"https://someone@track.gateweave.com/acme",
		]) {
			expect(input(pasted).data?.trackUrl).toBe("https://track.gateweave.com");
		}
		expect(input("http://localhost:4710/acme").data?.trackUrl).toBe("http://localhost:4710");
		expect(trackMcpUrl("https://track.gateweave.com")).toBe("https://track.gateweave.com/mcp");
	});

	it("names the agent Triage unless told otherwise", () => {
		expect(input("https://track.gateweave.com").data?.name).toBe("Triage");
	});

	it("refuses Track over plain HTTP, and keys that are not a whole Track key", () => {
		expect(input("http://track.example.com").success).toBe(false);
		for (const key of [`gwt_${"a".repeat(42)}`, `sk-${"a".repeat(43)}`, `gwt_${"a".repeat(42)}!`]) {
			expect(input("https://track.gateweave.com", key).error?.issues[0]?.message).toBe(
				"Paste the whole key, starting with gwt_, as Track shows it",
			);
		}
	});
});
