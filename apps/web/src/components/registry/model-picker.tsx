import { type ModelProvider, type ProviderModel, workersAiRemoved } from "@gateweave/agents-model";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";

/** The offered models matching a name or id, in the provider's order. */
export function matchingModels(
	models: ProviderModel[],
	provider: ModelProvider,
	query: string,
): ProviderModel[] {
	const term = query.trim().toLowerCase();
	return models.filter(
		(model) =>
			(provider !== "workers-ai" || !workersAiRemoved(model.id)) &&
			(model.id.toLowerCase().includes(term) || model.name.toLowerCase().includes(term)),
	);
}

/** Search Enter chooses a model without submitting the surrounding agent form. */
export function chooseFirstMatch(
	event: { preventDefault: () => void },
	matching: ProviderModel[],
	onChange: (model: string) => void,
) {
	event.preventDefault();
	const first = matching[0];
	if (first) onChange(first.id);
}

export function ModelPicker({
	provider,
	models,
	value,
	current,
	onChange,
}: {
	provider: ModelProvider;
	models: ProviderModel[] | string | null;
	value: string;
	/** The saved agent model, which may have left the provider's list. */
	current?: string;
	onChange: (model: string) => void;
}) {
	const [query, setQuery] = useState("");
	const offered = Array.isArray(models) ? matchingModels(models, provider, "") : [];
	const matching = matchingModels(offered, provider, query);
	const notOffered =
		current === value && Array.isArray(models) && !offered.some((model) => model.id === current);
	const knownRemoved = provider === "workers-ai" && workersAiRemoved(value);

	return (
		<div className="space-y-2">
			<Label htmlFor="agent-model">Model</Label>
			<Input
				id="agent-model"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				maxLength={200}
				spellCheck={false}
				autoComplete="off"
				required
			/>
			{notOffered && (
				<p className="text-xs text-muted-foreground">
					{knownRemoved
						? "Current model (no longer offered)"
						: "Current model (not in the provider's list)"}
				</p>
			)}
			{Array.isArray(models) && offered.length > 0 && (
				<>
					<Label htmlFor="agent-model-search">Search models</Label>
					<Input
						id="agent-model-search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							// Enter that ends an IME composition confirms the composed text, not a model.
							if (event.key === "Enter" && !event.nativeEvent.isComposing)
								chooseFirstMatch(event, matching, onChange);
						}}
						placeholder="Search by name or id"
						spellCheck={false}
					/>
					<ul aria-label="Available models" className="max-h-40 overflow-y-auto rounded-md border">
						{matching.slice(0, 50).map((model) => (
							<li key={model.id}>
								<Button
									type="button"
									variant="ghost"
									aria-pressed={value === model.id}
									className="h-auto w-full justify-start px-2 py-1 text-left font-normal"
									onClick={() => onChange(model.id)}
								>
									<span className="min-w-0 truncate">
										{model.name}
										{model.name !== model.id && (
											<span className="block text-xs text-muted-foreground">{model.id}</span>
										)}
									</span>
									{value === model.id && <span className="ml-auto text-xs">Selected</span>}
								</Button>
							</li>
						))}
					</ul>
					{matching.length > 50 && (
						<p className="text-xs text-muted-foreground">Search to narrow the list.</p>
					)}
				</>
			)}
			<p className="text-xs text-muted-foreground">You can also type a model id above.</p>
		</div>
	);
}
