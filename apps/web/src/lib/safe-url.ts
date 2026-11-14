/**
 * The address as a link may carry it, or null: only `http:` and `https:` pass, so a model's or a
 * sender's `javascript:` or `data:` address never becomes a link. Relative addresses are refused
 * too, since nothing in a message points into the app.
 */
export function httpUrl(value: string): string | null {
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.length > 2000) return null;
	try {
		const url = new URL(trimmed);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}
