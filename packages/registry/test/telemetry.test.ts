import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";
import { tracesUrl } from "../src/telemetry";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

const API_KEY = "hcaik_secret_value_1234567890";

describe("telemetry settings", () => {
	it("keep the headers sealed: pages see their names, the runtime their values", async () => {
		const stub = registry();
		expect(await stub.getTelemetry()).toBeNull();
		expect(await stub.telemetryTarget()).toBeNull();

		const saved = await stub.setTelemetry(
			{
				endpoint: "https://api.honeycomb.io/",
				headers: [{ name: "x-honeycomb-team", value: API_KEY }],
			},
			"Ada",
		);
		expect(saved).toMatchObject({
			endpoint: "https://api.honeycomb.io/",
			headers: ["x-honeycomb-team"],
			setBy: "Ada",
			lastExport: null,
		});
		expect(JSON.stringify(saved)).not.toContain(API_KEY);
		expect(JSON.stringify(await stub.getTelemetry())).not.toContain(API_KEY);

		const target = await stub.telemetryTarget();
		expect(target).toEqual({
			url: "https://api.honeycomb.io/v1/traces",
			headers: { "x-honeycomb-team": API_KEY },
			setAt: expect.any(Number),
		});

		expect(await stub.removeTelemetry()).toBe(true);
		expect(await stub.getTelemetry()).toBeNull();
		expect(await stub.telemetryTarget()).toBeNull();
		expect(await stub.removeTelemetry()).toBe(false);
	});

	it("keep how the last export went, but not against settings saved since", async () => {
		const stub = registry();
		await stub.setTelemetry({ endpoint: "https://otel.acme.dev", headers: [] }, "Ada");
		const first = await stub.telemetryTarget();
		if (!first) throw new Error("Expected a target");
		expect(first.headers).toEqual({});

		expect(await stub.recordTelemetryExport(first.setAt, { ok: false, error: "HTTP 503" })).toBe(
			true,
		);
		expect((await stub.getTelemetry())?.lastExport).toEqual({
			at: expect.any(Number),
			ok: false,
			error: "HTTP 503",
		});
		expect(await stub.recordTelemetryExport(first.setAt, { ok: true })).toBe(true);
		expect((await stub.getTelemetry())?.lastExport).toMatchObject({ ok: true, error: null });

		// New settings start with no export, and an export of the old ones is not kept.
		await new Promise((resolve) => setTimeout(resolve, 2));
		await stub.setTelemetry({ endpoint: "https://otel.acme.dev/v2", headers: [] }, "Grace");
		expect(await stub.recordTelemetryExport(first.setAt, { ok: false, error: "Old" })).toBe(false);
		expect(await stub.getTelemetry()).toMatchObject({ setBy: "Grace", lastExport: null });
	});

	it("refuse endpoints and headers that could leak or break", async () => {
		const stub = registry();
		const refused = async (input: unknown) =>
			runInDurableObject(stub, async (instance: RegistryDO) => {
				try {
					await instance.setTelemetry(input as never, "Ada");
					return null;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			});
		expect(await refused({ endpoint: "http://otel.acme.dev", headers: [] })).toContain("https://");
		expect(await refused({ endpoint: "https://otel.acme.dev?key=1", headers: [] })).toContain(
			"not in the URL",
		);
		expect(
			await refused({
				endpoint: "https://otel.acme.dev",
				headers: [
					{ name: "X-Key", value: "a" },
					{ name: "x-key", value: "b" },
				],
			}),
		).toContain("A header is set twice");
		expect(
			await refused({
				endpoint: "https://otel.acme.dev",
				headers: [{ name: "X Key", value: "a" }],
			}),
		).toContain("no spaces");
		expect(await stub.getTelemetry()).toBeNull();
	});

	it("post to /v1/traces under the endpoint, unless it names it", () => {
		expect(tracesUrl("https://otel.acme.dev")).toBe("https://otel.acme.dev/v1/traces");
		expect(tracesUrl("https://otel.acme.dev/otlp/")).toBe("https://otel.acme.dev/otlp/v1/traces");
		expect(tracesUrl("https://otel.acme.dev/v1/traces")).toBe("https://otel.acme.dev/v1/traces");
	});
});
