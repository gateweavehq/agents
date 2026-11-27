/**
 * The sandbox's own mark that its container was condemned: a review proof left it in a state that
 * must not be reused, and destroying it has not been confirmed yet. It stays until a destroy
 * succeeds, so a failed disposal never leaves a checkout that the next call can pick up.
 */
export const DISPOSAL_PENDING_KEY = "sandbox.disposal-pending";

/** The least a mark needs: the Durable Object's `storage.kv`, or a Map in a test. */
export interface DisposalStorage {
	get(key: string): unknown;
	put(key: string, value: unknown): void;
	delete(key: string): void;
}

/** The part of a container that a disposal uses. */
export interface DisposableContainer {
	readonly running: boolean;
	destroy(): Promise<void>;
}

export const DISPOSAL_REFUSED =
	"The sandbox's checkout was condemned and could not be destroyed yet, so it is not reused. Try again in a few minutes.";

/**
 * Throws a condemned container away. The mark is written before the destroy and cleared only by
 * a destroy that succeeded; `assertReusable` retries a pending one and refuses the container
 * until it does, which is what stops a failed disposal from leaving a reusable checkout.
 */
export class DisposalGuard {
	readonly #storage: DisposalStorage;

	constructor(storage: DisposalStorage) {
		this.#storage = storage;
	}

	get pending(): boolean {
		return this.#storage.get(DISPOSAL_PENDING_KEY) !== undefined;
	}

	/** Marks the container as condemned, then destroys it; rejects when the destroy does. */
	async discard(container: DisposableContainer | undefined): Promise<void> {
		this.#storage.put(DISPOSAL_PENDING_KEY, true);
		await this.#destroy(container);
	}

	/** Stops the container, and clears a pending mark once that is confirmed. */
	async destroy(container: DisposableContainer | undefined): Promise<void> {
		await this.#destroy(container);
	}

	/** Passes when nothing is pending, or when a pending destroy now succeeds; throws otherwise. */
	async assertReusable(container: DisposableContainer | undefined): Promise<void> {
		if (!this.pending) return;
		try {
			await this.#destroy(container);
		} catch {
			throw new Error(DISPOSAL_REFUSED);
		}
	}

	async #destroy(container: DisposableContainer | undefined): Promise<void> {
		if (container?.running) await container.destroy();
		this.#storage.delete(DISPOSAL_PENDING_KEY);
	}
}
