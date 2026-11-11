import { describe, expect, it } from "vitest";
import { domainOf, isDomainName, signUpEntry, signUpNote } from "./sign-up-allow";

describe("signUpEntry", () => {
	it("takes an address in lowercase, trimmed", () => {
		expect(signUpEntry.parse("  Ada@Example.COM ")).toBe("ada@example.com");
	});

	it("takes a domain with a leading @", () => {
		expect(signUpEntry.parse("@Example.com")).toBe("@example.com");
		expect(signUpEntry.parse("@mail.example.co.uk")).toBe("@mail.example.co.uk");
		expect(signUpEntry.parse("@xn--bcher-kva.example")).toBe("@xn--bcher-kva.example");
	});

	it.each([
		"",
		"   ",
		"ada",
		"@",
		"@localhost",
		"@example",
		"@1.2.3.4",
		"@exa mple.com",
		"@-example.com",
		"@example-.com",
		"@exa_mple.com",
		"@*.example.com",
		"@@example.com",
		"example.com",
		"ada@",
		"ada@@example.com",
		"a b@example.com",
		`@${"a".repeat(64)}.com`,
		`@${"a.".repeat(130)}com`,
	])("refuses %j", (entry) => {
		expect(signUpEntry.safeParse(entry).success).toBe(false);
	});

	it("refuses what is not text", () => {
		expect(signUpEntry.safeParse(undefined).success).toBe(false);
		expect(signUpEntry.safeParse(7).success).toBe(false);
	});
});

describe("signUpNote", () => {
	it("keeps the owner's words, trimmed, and treats nothing as none", () => {
		expect(signUpNote.parse("  from the waitlist ")).toBe("from the waitlist");
		expect(signUpNote.parse("   ")).toBeNull();
		expect(signUpNote.parse("")).toBeNull();
		expect(signUpNote.parse(undefined)).toBeNull();
		expect(signUpNote.parse(null)).toBeNull();
	});

	it("holds a note to 200 characters", () => {
		expect(signUpNote.safeParse("x".repeat(200)).success).toBe(true);
		expect(signUpNote.safeParse("x".repeat(201)).success).toBe(false);
	});
});

describe("domainOf", () => {
	it("is the part from the last @", () => {
		expect(domainOf("ada@example.com")).toBe("@example.com");
		expect(domainOf("ada@mail.example.com")).toBe("@mail.example.com");
		expect(domainOf("a@b@example.com")).toBe("@example.com");
	});
});

describe("isDomainName", () => {
	it("wants at least two labels and a top level that is not a number", () => {
		expect(isDomainName("example.com")).toBe(true);
		expect(isDomainName("localhost")).toBe(false);
		expect(isDomainName("1.2.3.4")).toBe(false);
		expect(isDomainName("a.b.c.d.example.com")).toBe(true);
	});
});
