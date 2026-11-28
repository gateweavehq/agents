import { countWouldRefuse, type RunSpan } from "@gateweave/agents-model";
import type { ReactNode } from "react";

export function RunTrace({ trace, children }: { trace: RunSpan[] | null; children?: ReactNode }) {
	if (trace === null) {
		return (
			<p className="text-sm text-muted-foreground">
				The conversation this run belonged to was deleted, and its trace with it.
			</p>
		);
	}
	if (trace.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">The run ended before it called the model.</p>
		);
	}
	const flagged = countWouldRefuse(trace).total;
	const refused = trace.filter((span) => span.status === "refused").length;
	return (
		<>
			{(flagged > 0 || refused > 0) && (
				<p className="mb-3 text-sm">
					{flagged > 0 &&
						`${flagged === 1 ? "1 call" : `${flagged} calls`} would be refused by the target rule. `}
					{refused > 0 &&
						`${refused === 1 ? "1 call was" : `${refused} calls were`} refused by the target rule. `}
					After receiving outside content, the agent used a target without a trusted source.
				</p>
			)}
			{children}
		</>
	);
}
