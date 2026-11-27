import { describe, expect, it } from "vitest";
import {
	DISPOSAL_PENDING_KEY,
	DISPOSAL_REFUSED,
	DisposalGuard,
	type DisposalStorage,
} from "../src/disposal";

function setup(running = true) {
	const marks = new Map<string, unknown>();
	const container = {
		running,
		fail: false,
		destroys: 0,
		async destroy() {
			this.destroys++;
			if (this.fail) throw new Error("container would not stop");
		},
	};
	return { marks, guard: new DisposalGuard(storageOf(marks)), container };
}

describe("a condemned container", () => {
	it("is usable when nothing was condemned, and destroys nothing", async () => {
		const { guard, container } = setup();
		await guard.assertReusable(container);
		expect(container.destroys).toBe(0);
	});
	it("is destroyed and then usable again", async () => {
		const { guard, container, marks } = setup();
		await guard.discard(container);
		expect(container.destroys).toBe(1);
		expect(marks.has(DISPOSAL_PENDING_KEY)).toBe(false);
		await guard.assertReusable(container);
		expect(container.destroys).toBe(1);
	});
	it("is refused while its destroy keeps failing, and usable after one succeeds", async () => {
		const { guard, container, marks } = setup();
		container.fail = true;
		await expect(guard.discard(container)).rejects.toThrow("container would not stop");
		expect(marks.has(DISPOSAL_PENDING_KEY)).toBe(true);
		await expect(guard.assertReusable(container)).rejects.toThrow(DISPOSAL_REFUSED);
		await expect(guard.assertReusable(container)).rejects.toThrow(DISPOSAL_REFUSED);
		expect(container.destroys).toBe(3);
		container.fail = false;
		await guard.assertReusable(container);
		expect(marks.has(DISPOSAL_PENDING_KEY)).toBe(false);
	});
	it("stays refused after the instance restarts, as the mark is in storage", async () => {
		const { marks, container } = setup();
		container.fail = true;
		await expect(new DisposalGuard(storageOf(marks)).discard(container)).rejects.toThrow();
		const restarted = new DisposalGuard(storageOf(marks));
		await expect(restarted.assertReusable(container)).rejects.toThrow(DISPOSAL_REFUSED);
	});
	it("clears the mark when the container is not running, as there is nothing to destroy", async () => {
		const { guard, container } = setup(false);
		await guard.discard(container);
		expect(container.destroys).toBe(0);
		expect(guard.pending).toBe(false);
	});
	it("a plain destroy that succeeds also clears a pending mark", async () => {
		const { guard, container } = setup();
		container.fail = true;
		await expect(guard.discard(container)).rejects.toThrow();
		container.fail = false;
		await guard.destroy(container);
		expect(guard.pending).toBe(false);
	});
});

function storageOf(marks: Map<string, unknown>): DisposalStorage {
	return {
		get: (key) => marks.get(key),
		put: (key, value) => void marks.set(key, value),
		delete: (key) => void marks.delete(key),
	};
}
