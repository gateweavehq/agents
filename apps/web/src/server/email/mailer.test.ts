import { describe, expect, it, vi } from "vitest";
import { createMailer, parseSender } from "./mailer";

describe("parseSender", () => {
	it("reads a named or a bare address", () => {
		expect(parseSender("Gateweave Agents <agents@example.com>")).toEqual({
			name: "Gateweave Agents",
			email: "agents@example.com",
		});
		expect(parseSender('"Agents, by Gateweave" <agents@example.com>')).toEqual({
			name: "Agents, by Gateweave",
			email: "agents@example.com",
		});
		expect(parseSender(" agents@example.com ")).toBe("agents@example.com");
		expect(parseSender("<agents@example.com>")).toBe("agents@example.com");
	});

	it("rejects anything that is not an address", () => {
		expect(parseSender("Gateweave Agents")).toBeUndefined();
		expect(parseSender("Agents <not an address>")).toBeUndefined();
		expect(parseSender("")).toBeUndefined();
	});
});

describe("createMailer", () => {
	const email = { to: "maya@example.com", subject: "Hi", text: "Hello", html: "<p>Hello</p>" };

	it("sends from the configured sender", async () => {
		const send = vi.fn(async () => ({ messageId: "1" }));
		const mailer = createMailer({ send } as unknown as SendEmail, "Agents <agents@example.com>");
		await mailer?.send(email);
		expect(send).toHaveBeenCalledWith({
			from: { name: "Agents", email: "agents@example.com" },
			...email,
		});
	});

	it("is off without a binding or a valid sender", () => {
		const binding = { send: vi.fn() } as unknown as SendEmail;
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(createMailer(undefined, "agents@example.com")).toBeUndefined();
		expect(createMailer(binding, undefined)).toBeUndefined();
		expect(createMailer(binding, "not an address")).toBeUndefined();
	});
});
