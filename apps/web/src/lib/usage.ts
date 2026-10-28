/** What runs used, as the Runs pages and the Overview show it. */

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const cents = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const fractions = new Intl.NumberFormat(undefined, {
	style: "currency",
	currency: "USD",
	maximumSignificantDigits: 2,
});

/** "980", "12.3K". */
export function formatTokens(count: number): string {
	return compact.format(count);
}

/**
 * An estimate in millionths of a dollar, in dollars: "$4.20", or "$0.016" and "$0.0012" below a
 * dime, where most runs fall and cents would round them all alike.
 */
export function formatCost(micros: number): string {
	const amount = micros / 1_000_000;
	return amount === 0 || amount >= 0.1 ? cents.format(amount) : fractions.format(amount);
}

/** "850 ms", "12.4 s", "3 min 5 s". */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const seconds = Math.floor(ms / 1000);
	return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
