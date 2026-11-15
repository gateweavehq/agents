import { expect, it } from "vitest";
import { dayOf, expiryOf } from "./memory-expiry";

it("keeps a memory's end as it was unless someone chooses another day", () => {
	// It expired at noon. Saving the form without touching the day leaves it expired.
	const noon = new Date(2026, 10, 15, 12, 0, 0).getTime();
	expect(dayOf(noon)).toBe("2026-11-15");
	expect(expiryOf("2026-11-15", noon)).toBe(noon);
	// Another day lasts through that day, and none means it is recalled until deleted.
	expect(expiryOf("2026-11-16", noon)).toBe(new Date(2026, 10, 16, 23, 59, 59).getTime());
	expect(expiryOf("", noon)).toBeNull();
	expect(expiryOf("", null)).toBeNull();
	expect(expiryOf("2026-11-15", null)).toBe(new Date(2026, 10, 15, 23, 59, 59).getTime());
});
