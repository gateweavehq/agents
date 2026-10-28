import { expect, it } from "vitest";
import { formatBytes, formatDuration } from "./usage";

it("says how long a run took in the unit that reads best", () => {
	expect(formatDuration(0)).toBe("0 ms");
	expect(formatDuration(850.4)).toBe("850 ms");
	expect(formatDuration(1_000)).toBe("1.0 s");
	expect(formatDuration(12_449)).toBe("12.4 s");
	expect(formatDuration(60_000)).toBe("1 min 0 s");
	expect(formatDuration(185_900)).toBe("3 min 5 s");
});

it("says how big a tool's input and output were", () => {
	expect(formatBytes(0)).toBe("0 B");
	expect(formatBytes(999)).toBe("999 B");
	expect(formatBytes(3_449)).toBe("3.4 kB");
	expect(formatBytes(1_250_000)).toBe("1.3 MB");
});
