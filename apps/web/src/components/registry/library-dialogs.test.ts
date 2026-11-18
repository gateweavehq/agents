import { createElement, type PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NewLibraryAssetDialog } from "./library-dialogs";

vi.mock("#/components/workspace/context", () => ({
	useWorkspace: () => ({ slug: "workspace" }),
}));
vi.mock("#/lib/registry", () => ({}));
vi.mock("#/components/ui/dialog", () => {
	const Part = ({ children }: PropsWithChildren) => createElement("div", null, children);
	return {
		Dialog: Part,
		DialogContent: Part,
		DialogDescription: Part,
		DialogFooter: Part,
		DialogHeader: Part,
		DialogTitle: Part,
	};
});

describe("NewLibraryAssetDialog", () => {
	it("starts without a kind, explains the choices, and blocks creation", () => {
		const html = renderToStaticMarkup(
			createElement(NewLibraryAssetDialog, {
				onCreated: async () => {},
				onClose: () => {},
			}),
		);
		expect(html).toContain("What an agent always reads, such as AGENTS.md, CLAUDE.md or rules.");
		expect(html).toContain("A prompt or slash command an agent can use.");
		expect(html).toContain("Steps for a specific task. Cannot be pinned as agent instructions.");
		expect(html).not.toContain('checked=""');
		expect(html).not.toContain('id="new-asset-name"');
		expect(html).not.toContain('id="new-asset-text"');
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Create<\/button>/);
	});
});
