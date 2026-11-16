import { describe, expect, it } from "vitest";
import { type PendingTurn, pendingTurnAfter, stopFrame } from "./pending-turn";

const frame = (data: object) => JSON.stringify(data);
const waiting: PendingTurn = { id: "request-1" };

describe("a turn whose reply has not begun", () => {
	it("is the one the server says is pending, by its request's id", () => {
		expect(
			pendingTurnAfter(null, frame({ type: "cf_agent_stream_pending", id: "request-1" })),
		).toEqual({ id: "request-1" });
		// The server names it when it can; a turn without a name is still under way.
		expect(pendingTurnAfter(null, frame({ type: "cf_agent_stream_pending" }))).toEqual({
			id: null,
		});
	});

	it("stays the same turn when the server says so again", () => {
		const again = frame({ type: "cf_agent_stream_pending", id: "request-1", probeId: "p" });
		expect(pendingTurnAfter(waiting, again)).toBe(waiting);
	});

	it("is over once its reply begins, or the turn ends without one", () => {
		for (const type of ["cf_agent_stream_resuming", "cf_agent_stream_resume_none"]) {
			expect(pendingTurnAfter(waiting, frame({ type, id: "request-1" }))).toBeNull();
		}
		const reply = { type: "cf_agent_use_chat_response", id: "request-1", body: "", done: true };
		expect(pendingTurnAfter(waiting, frame(reply))).toBeNull();
		expect(pendingTurnAfter({ id: null }, frame(reply))).toBeNull();
	});

	it("is not ended by another turn's reply, nor by frames about anything else", () => {
		const other = { type: "cf_agent_use_chat_response", id: "request-0", body: "", done: true };
		expect(pendingTurnAfter(waiting, frame(other))).toBe(waiting);
		expect(pendingTurnAfter(waiting, frame({ type: "cf_agent_mcp_servers" }))).toBe(waiting);
		expect(pendingTurnAfter(waiting, "not JSON")).toBe(waiting);
		expect(pendingTurnAfter(waiting, "null")).toBe(waiting);
		expect(pendingTurnAfter(null, frame(other))).toBeNull();
	});

	it("is stopped with the frame that stops a turn under way", () => {
		expect(JSON.parse(stopFrame("request-1"))).toEqual({
			type: "cf_agent_chat_request_cancel",
			id: "request-1",
		});
	});
});
