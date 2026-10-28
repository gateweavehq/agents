/** Collects what one adapter finds: assets, the keys its main agent reads, and problems. */
import type { DetectedAsset, ScanProblem } from "@gateweave/agents-model";

export class Findings {
	readonly assets: DetectedAsset[] = [];
	readonly problems: ScanProblem[] = [];
	/** Keys of the assets the runtime's main agent reads. */
	readonly reads: string[] = [];

	/** Adds an asset the main agent reads. */
	read(asset: DetectedAsset | null): void {
		if (!asset) return;
		this.assets.push(asset);
		this.reads.push(asset.key);
	}

	readAll(assets: readonly DetectedAsset[]): void {
		for (const asset of assets) this.read(asset);
	}
}
