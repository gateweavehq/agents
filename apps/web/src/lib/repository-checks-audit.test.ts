import { describe, expect, it } from "vitest";
import { saveChecksWithAudit } from "./repository-checks-audit";

describe("repository checks audit", () => {
	it("records a changed list exactly once when the first audit write is lost", async () => {
		for (const desired of [["pnpm test"], []]) {
			let stored = ["pnpm lint"];
			let digest: string | null = null;
			let writes = 0;
			const save = () =>
				saveChecksWithAudit(
					desired,
					async () => {
						const before = stored;
						stored = desired;
						return { repository: "acme/site", before, checks: stored };
					},
					async () => digest,
					async (_set, next) => {
						writes += 1;
						if (writes > 1) digest = next;
					},
				);
			await save();
			expect(digest).toBeNull();
			await save();
			expect(digest).toMatch(/^[0-9a-f]{64}$/);
			await save();
			expect(writes).toBe(2);
		}
	});
});
