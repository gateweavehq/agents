import { z } from "zod";

/** The owner's list of who may make an account. "Who owns a server" in docs/architecture.md. */

export const MAX_ALLOW_ENTRIES = 5000;
export const MAX_NOTE_LENGTH = 200;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A name a mail server could be at: letters, digits and hyphens in dot-separated labels, with a top
 * level that is not all digits, so that an IP address is not taken for one. Names with other letters
 * are written the way a mail server knows them, in punycode (`xn--...`).
 */
export function isDomainName(domain: string): boolean {
	if (domain.length > 253) return false;
	const labels = domain.split(".");
	const top = labels[labels.length - 1] ?? "";
	return labels.length >= 2 && labels.every((label) => LABEL.test(label)) && !/^\d+$/.test(top);
}

const address = z.email().max(254);

const ASK = "Enter an email address such as ada@example.com, or a domain such as @example.com.";

/**
 * One line of the list: an address, or `@` and a domain, in lowercase. A domain covers addresses at
 * exactly that domain and not its subdomains.
 */
export const signUpEntry = z
	.string(ASK)
	.trim()
	.toLowerCase()
	.refine(
		(entry) =>
			entry.startsWith("@") ? isDomainName(entry.slice(1)) : address.safeParse(entry).success,
		ASK,
	);

/** The owner's own words about an entry. Blank counts as none. */
export const signUpNote = z
	.string()
	.trim()
	.max(MAX_NOTE_LENGTH, `Keep the note to ${MAX_NOTE_LENGTH} characters.`)
	.transform((note) => note || null)
	.nullish()
	.transform((note) => note ?? null);

/** The part of an address the list's domain entries name, from its last `@`: `@example.com`. */
export function domainOf(email: string): string {
	return email.slice(email.lastIndexOf("@"));
}
