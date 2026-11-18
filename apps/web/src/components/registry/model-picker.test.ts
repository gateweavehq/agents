import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chooseFirstMatch, ModelPicker, matchingModels } from "./model-picker";

const REMOVED = "@cf/moonshotai/kimi-k2.6";
const LLAMA = { id: "@cf/meta/llama-4", name: "Llama Four" };
const QWEN = { id: "@cf/qwen/qwen-new", name: "Qwen New" };
const models = [LLAMA, QWEN, { id: REMOVED, name: "Kimi Old" }];

describe("ModelPicker", () => {
	it("searches provider models by name or id and excludes removed Workers AI models", () => {
		expect(matchingModels(models, "workers-ai", "llama")).toEqual([LLAMA]);
		expect(matchingModels(models, "workers-ai", "QWEN-NEW")).toEqual([QWEN]);
		expect(matchingModels(models, "workers-ai", "")).toEqual(models.slice(0, 2));
	});

	it("keeps a current removed model visibly marked and allows a typed id", () => {
		const html = renderToStaticMarkup(
			createElement(ModelPicker, {
				provider: "workers-ai",
				models,
				value: REMOVED,
				current: REMOVED,
				onChange: () => {},
			}),
		);
		expect(html).toContain(`value="${REMOVED}"`);
		expect(html).toContain("Current model (no longer offered)");
		expect(html).toContain("Search models");
		expect(html).toContain("Llama Four");
		expect(html).not.toContain("Kimi Old");
		expect(html).toContain("You can also type a model id above.");
	});

	it("marks the selected model and identifies an unknown saved id accurately", () => {
		const selected = renderToStaticMarkup(
			createElement(ModelPicker, {
				provider: "workers-ai",
				models,
				value: LLAMA.id,
				current: LLAMA.id,
				onChange: () => {},
			}),
		);
		expect(selected).toContain('aria-pressed="true"');
		expect(selected).toContain("Selected");
		const unknown = renderToStaticMarkup(
			createElement(ModelPicker, {
				provider: "workers-ai",
				models,
				value: "custom-id",
				current: "custom-id",
				onChange: () => {},
			}),
		);
		expect(unknown).toContain("not in the provider&#x27;s list");
		expect(unknown).not.toContain("no longer offered");
	});

	it("Enter prevents form submission and chooses the first search match", () => {
		let prevented = false;
		let chosen = "";
		chooseFirstMatch(
			{
				preventDefault: () => {
					prevented = true;
				},
			},
			matchingModels(models, "workers-ai", "qwen"),
			(id) => {
				chosen = id;
			},
		);
		expect(prevented).toBe(true);
		expect(chosen).toBe(QWEN.id);
	});
});
