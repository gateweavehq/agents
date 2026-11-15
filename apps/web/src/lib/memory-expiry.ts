/** The last day a memory is recalled, as the Memory page's form reads and writes it. */

/** A day as a date input holds it, in the browser's own time zone. */
export function dayOf(time: number | null): string {
	if (time === null) return "";
	const date = new Date(time);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The end of that day, so a memory lasts through the day someone chose. */
function endOf(day: string): number | null {
	const time = new Date(`${day}T23:59:59`).getTime();
	return day === "" || Number.isNaN(time) ? null : time;
}

/**
 * When a memory stops being recalled, from the form's day. A day nobody changed keeps the time
 * the memory had: reading it again as the end of that day would bring a memory that expired
 * earlier today back until midnight, on an edit of its text alone.
 */
export function expiryOf(day: string, was: number | null): number | null {
	return day === dayOf(was) ? was : endOf(day);
}
