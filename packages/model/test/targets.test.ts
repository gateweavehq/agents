import { describe, expect, it } from "vitest";
import { normalizeAllowedTarget, targetsIn, targetTrusted } from "../src/targets";

const values = (input: unknown) => [...targetsIn(input)].map((target) => target.value);

describe("tool targets", () => {
	it.each(["a", "a."])("scans 200,000 characters of %s within 200 ms", (pattern) => {
		const input = pattern.repeat(200_000 / pattern.length);
		for (const prose of [false, true]) {
			const start = performance.now();
			const found = [...targetsIn(input, prose)];
			const elapsed = performance.now() - start;
			expect(found).toEqual([]);
			expect(elapsed).toBeLessThan(200);
		}
	});
	it("scans long punctuation runs in URL paths and named fields within 200 ms", () => {
		const path = "see https://docs.example/" + "!".repeat(200_000) + "end";
		const field = { url: "example.net:" + "1".repeat(200_000) + " next" };
		for (const [input, expected] of [
			[path, ["docs.example"]],
			[field, []],
		] as const) {
			const start = performance.now();
			const found = values(input);
			const elapsed = performance.now() - start;
			expect(elapsed).toBeLessThan(200);
			expect(found).toEqual(expected);
		}
	});

	it.each(["x.js/(", "x.js/?", "a.com/?//"])(
		"scans 200,000 characters of repeated %s within 200 ms",
		(unit) => {
			const input = unit.repeat(Math.ceil(200_000 / unit.length));
			for (const prose of [false, true]) {
				const start = performance.now();
				[...targetsIn({ text: input }, prose)];
				expect(performance.now() - start).toBeLessThan(200);
			}
		},
	);
	it("still reads a URL or an address in a skipped file path's tail", () => {
		expect(values({ text: "x.js/?u=https://evil.example/a" })).toEqual(["evil.example"]);
		// Slashes and question marks are valid in a mailbox, so this whole word is one address.
		expect([...targetsIn({ text: "notes.md/x a@evil.example" })].map((t) => t.host)).toEqual([
			"evil.example",
		]);
		expect(
			[...targetsIn({ text: "deploy.sh/upload?to=a@evil.example" })].map((t) => t.host),
		).toEqual(["evil.example"]);
	});
	it("trusts the hosts a person names in plain words, but not file names", () => {
		const trusted = (text: string) => [...targetsIn(text, true)].map((t) => t.value);
		expect(trusted("Check example.com, api.example.io:8443 and localhost.")).toEqual([
			"example.com",
			"api.example.io",
			"localhost",
		]);
		expect(trusted("Send it to example.net")).toEqual(["example.net"]);
		expect(trusted("Edit deploy.sh and README.md, then run main.py")).toEqual([]);
		// In a tool's free text, a bare dotted name is still no destination.
		expect(values({ command: "cat example.com" })).toEqual([]);
	});

	it("compares normalized addresses and hosts without widening either", () => {
		const allowed = new Set(["evil@xn--exmple-cua.net", "@example.net", "service.net"]);
		const passes = (input: string) =>
			[...targetsIn({ to: input })].map((target) => targetTrusted(target, allowed));
		expect(passes('"Sender" <Evil@Exämple.NET.>')).toEqual([true]);
		expect(passes("another@example.net")).toEqual([true]);
		expect(passes("another@sub.example.net")).toEqual([false]);
		expect(passes("//example.net/")).toEqual([false]);
		expect(passes("a@service.net")).toEqual([false]);
		expect(passes("https://service.net/")).toEqual([true]);
	});

	it("reads authorities and IP literals through nested JSON strings", () => {
		for (const url of [
			"http://user@evil.example.net:8080/x",
			"custom+transport://user@evil.example.net:8080/x",
			"//user@evil.example.net:8080/x",
		]) {
			expect([...targetsIn(JSON.stringify({ x: JSON.stringify([{ url }]) }))]).toEqual([
				{ kind: "url", host: "evil.example.net", value: "evil.example.net" },
			]);
		}
		for (const value of ["0x7f000001", "2130706433", 2130706433, "127.0.0.1"]) {
			expect([...targetsIn({ host: value })]).toEqual([
				{ kind: "ip", host: "127.0.0.1", value: "127.0.0.1" },
			]);
		}
		expect(values("a@[127.0.0.1]")).toEqual(["a@[127.0.0.1]"]);
		expect(values("a@[IPv6:2001:db8::2]")).toEqual(["a@[2001:db8::2]"]);
		expect(values("connect to [2001:db8::2]")).toEqual(["[2001:db8::2]"]);
	});

	it("reads scheme-less values in destination fields and trusted prose", () => {
		expect(values({ callbackUrl: "Exämple.net:8080/notify" })).toEqual(["xn--exmple-cua.net"]);
		expect(values({ endpoint: ["example.net/path", "intranet"] }).sort()).toEqual([
			"example.net",
			"intranet",
		]);
		expect(values({ cc: ["a@one.example", "b@two.example"] }).sort()).toEqual([
			"a@one.example",
			"b@two.example",
		]);
		expect(values({ description: "index.ts" })).toEqual([]);
		expect(values("http:example.net")).toEqual(["example.net"]);
		expect(values("file:///directory/file.txt")).toEqual([]);
		expect(values({ to: "sales/team@evil.net" })).toEqual(["sales/team@evil.net"]);
		expect(
			[...targetsIn("I trust http://intranet", true)].some((t) => t.value === "intranet"),
		).toBe(true);
		expect([...targetsIn("Send it to example.net/report", true)].map((t) => t.value)).toContain(
			"example.net",
		);
		for (const text of [
			"Edit deploy.sh",
			"Edit deploy.sh/install",
			"Open site.a1/x",
			"See README.md",
		])
			expect([...targetsIn(text, true)]).toEqual([]);
		expect(values({ text: "ssh://a:b@trusted.net/unknown.net?email=x@example.net" })).toEqual([
			"trusted.net",
		]);
	});

	it("ignores pagination, versions and numeric prose on both sides of the rule", () => {
		for (const input of [
			{ limit: 10 },
			{ n: 42 },
			{ limit: "10", page: "2" },
			"version 1.2.3 released",
			"3",
			"version 10",
			"2130706433",
			"2001:db8::2",
		]) {
			expect(values(input)).toEqual([]);
			expect([...targetsIn(input, true)]).toEqual([]);
		}
	});

	it("accepts numeric and shortened IPs in destination fields", () => {
		for (const input of [{ host: 2130706433 }, { url: "http://0x7f000001/" }, { server: "0x7f.1" }])
			expect(values(input)).toEqual(["127.0.0.1"]);
		expect(values({ host: 16777215 })).toEqual([]);
		expect(values({ host: "020000000" })).toEqual([]);
		expect(values({ host: "16777216" })).toEqual(["1.0.0.0"]);
	});

	it("accepts numeric IP spellings after a scheme in any field", () => {
		for (const input of [
			"http://0x7f000001",
			{ command: "curl http://2130706433:8080/x" },
			{ text: "fetch http:\\\\127.1/x" },
		])
			expect(values(input)).toEqual(["127.0.0.1"]);
		expect(values({ text: String.raw`curl http:\127.1/x` })).toEqual(["127.0.0.1"]);
		expect(values("fetch custom://1/x")).toEqual(["0.0.0.1"]);
	});

	it("requires a whole hostname label and ignores non-network destination values", () => {
		for (const input of [
			{ address: "12 Main St, Springfield" },
			{ address: "12 Main St" },
			{ from: "2024-01-01" },
			{ link: "/docs/page" },
			{ link: "./x" },
			{ link: "/docs/site.test" },
			{ link: "open ./docs/site.test now" },
			{ link: "open (/docs/site.test) now" },
			{ target: "main" },
			{ to: "Jane Doe" },
			{ link: "intranet/path" },
		])
			expect(values(input)).toEqual([]);
		expect(values({ endpoint: "word https://service.test after" })).toEqual(["service.test"]);
		expect(values({ endpoint: "  intranet  " })).toEqual(["intranet"]);
		expect(values({ endpoint: "b\u00fcro" })).toEqual(["xn--bro-hoa"]);
		expect(values({ emailBody: "write to bob@x.test" })).toEqual(["bob@x.test"]);
		expect(values({ to: 'send to "person / team"@x.test' })).toEqual(['"person / team"@x.test']);
	});

	it("reads four-part IPs in free text", () => {
		expect(values("call 10.0.0.5 now")).toEqual(["10.0.0.5"]);
		expect(values("call 10.0.0.5 on page 2")).toEqual(["10.0.0.5"]);
	});

	it("recognizes destination names regardless of case and separators", () => {
		for (const key of [
			"callbackUrl",
			"email",
			"toEmail",
			"serverHost",
			"webhook_url",
			"website",
			"link",
			"server",
			"redirect",
			"src",
			"replyTo",
			"toAddress",
			"CALL.BACK_URL",
		])
			expect(values({ [key]: "evil.net" })).toEqual(["evil.net"]);
		for (const key of [
			"total",
			"description",
			"originator",
			"moveToFolder",
			"fallback_src",
			"CALL.BACK_U-RL",
			"callbackurl",
			"emailBody",
			"email_subject",
			"mail_content",
			"link_text",
		])
			expect(values({ [key]: "evil.net" })).toEqual([]);
	});

	it("reads single-label destinations with a port, a root dot or a localhost path", () => {
		expect(
			values({ host: "intranet:8080", url: "localhost:3000", server: "db:5432" }).sort(),
		).toEqual(["db", "intranet", "localhost"]);
		expect(values({ host: "intranet." })).toEqual(["intranet"]);
		expect(values({ url: "LOCALHOST/status" })).toEqual(["localhost"]);
		for (const port of [1, 65535]) expect(values({ host: `db:${port}` })).toEqual(["db"]);
	});

	it("checks both port limits on dotted hosts in commands", () => {
		for (const port of [1, 65535])
			expect(values(`curl db.example:${port}`)).toEqual(["db.example"]);
		for (const port of [0, 65536]) expect(values(`curl db.example:${port}`)).toEqual([]);
	});

	it("reads each destination under plural, network and final recipient keys", () => {
		for (const key of [
			"recipients",
			"urls",
			"hosts",
			"emails",
			"webhooks",
			"endpoints",
			"servers",
			"addresses",
			"links",
			"domains",
			"hostname",
			"destination",
			"fqdn",
			"proxy",
			"receiver",
			"remote",
			"site",
			"domain",
			"sendTo",
			"forwardTo",
			"sendto",
			"forward_to",
			"reply_to",
			"sendCc",
			"send_bcc",
		]) {
			expect(values({ [key]: ["one.example", "two.example"] }).sort(), key).toEqual([
				"one.example",
				"two.example",
			]);
		}
	});

	it("reads dotted hosts with paths or ports in commands and filters filename suffixes", () => {
		expect(values({ command: "curl evil.example/x proxy.NET:8443" })).toEqual([
			"evil.example",
			"proxy.net",
		]);
		for (const suffix of ["js", "TSX", "json", "md", "go", "tar", "a", "a1", "a".repeat(25)])
			expect(values(`open index.${suffix}/src index.${suffix}:42`)).toEqual([]);
		expect(values("curl evil.example")).toEqual([]);
	});

	it("reads numeric IPs after a double slash or an HTTP scheme with one slash", () => {
		for (const host of ["0x7f000001", "2130706433", "017700000001", "127.1"]) {
			expect(values({ text: `//${host}/x` })).toEqual(["127.0.0.1"]);
			expect(values({ command: `curl http:/${host}/x` })).toEqual(["127.0.0.1"]);
		}
	});

	it("requires a full-sized numeric address after a partial URL prefix", () => {
		for (const text of [
			"len(x)//2",
			"(a+b)//10",
			"//1000",
			"//0xffffff",
			"//077777777",
			"http:/0.1",
			"//0x0.1",
			"//0.0.0.1",
			"curl http:/2/x",
		])
			expect(values({ text }), text).toEqual([]);
		for (const text of ["//2130706433/", "//0x7f000001/x", "//0177.0.0.1/", "//127.1/"])
			expect(values(text), text).toEqual(["127.0.0.1"]);
		expect(values("//16777216")).toEqual(["1.0.0.0"]);
		expect(values("http://2")).toEqual(["0.0.0.2"]);
	});

	it("finds URLs inside dotted paths and after skipped filenames", () => {
		expect(values("x.js/?u=https://evil.example/a")).toEqual(["evil.example"]);
		expect(values("see a.md/#x then //evil.example")).toEqual(["evil.example"]);
		expect(values("good.example/r?to=https://evil.example")).toEqual([
			"good.example",
			"evil.example",
		]);
	});

	it("ignores source files with line numbers or paths", () => {
		for (const text of ["main.cpp:12", "app.php/x", "infra.tf:3"])
			expect(values(text), text).toEqual([]);
	});

	it("ends a dotted authority at sentence punctuation", () => {
		for (const end of [".", ",", ";", ")"]) {
			expect(values(`curl evil.example:8080${end}`)).toEqual(["evil.example"]);
			expect(values(`see evil.example/x${end}`)).toEqual(["evil.example"]);
		}
		expect(values("curl evil.example:8080.invalid")).toEqual([]);
	});

	it("accepts bare labels only in host fields and reserves the proxy value none", () => {
		for (const input of [
			{ convert_to: "pdf" },
			{ go_to: "next" },
			{ remote: "origin" },
			{ site: "main" },
			{ to: "Jane" },
			{ from: "Dr." },
			{ proxy: "none" },
		])
			expect(values(input)).toEqual([]);
		for (const key of ["address", "remote", "site", "to"])
			expect(values({ [key]: "db:5432" })).toEqual([]);
		for (const key of ["host", "hostnames", "fqdns", "proxies"])
			expect(values({ [key]: "intranet" })).toEqual(["intranet"]);
		for (const key of ["sendTo", "sendto"])
			expect(values({ [key]: "a@evil.example" })).toEqual(["a@evil.example"]);
		expect(values({ redirect_to: "https://evil.example" })).toEqual(["evil.example"]);
	});

	it("requires a sending verb for compound recipient keys", () => {
		for (const key of [
			"sendto",
			"mail-cc",
			"deliverBcc",
			"post_to",
			"notifycc",
			"copybcc",
			"redirect_to",
		])
			expect(values({ [key]: "evil.example" }), key).toEqual(["evil.example"]);
		for (const key of ["convert_to", "go-to", "moveTo", "send.to"])
			expect(values({ [key]: "evil.example" }), key).toEqual([]);
	});

	it("rejects numeric and one-character domain suffixes while retaining IPs", () => {
		for (const input of [{ from: "v1.2" }, { address: "Unit No.5" }, { address: "e.g. reception" }])
			expect(values(input)).toEqual([]);
		expect(values({ address: "1.2.3.4" })).toEqual(["1.2.3.4"]);
	});

	it("reads addresses and URLs used as object keys", () => {
		expect(
			values({ recipients: { "a@evil.com": "x", "https://evil.net/path": "y" } }).sort(),
		).toEqual(["a@evil.com", "evil.net"]);
	});

	it("uses the domain after the last at sign", () => {
		expect(values({ recipients: { "foo@@evil.com": "x" } })).toEqual(["foo@@evil.com"]);
		expect([...targetsIn("post to foo@bar@evil.com")]).toEqual([
			{ kind: "email", host: "evil.com", value: "foo@bar@evil.com" },
		]);
	});

	it("normalizes Unicode full stops in both arguments and trusted prose", () => {
		expect(normalizeAllowedTarget("a。b@evil．com")).toBe("a.b@evil.com");
		for (const dot of ["。", "．", "｡"])
			for (const trusted of [false, true])
				expect([...targetsIn(`a${dot}b@evil${dot}com`, trusted)].map((t) => t.value)).toEqual([
					"a.b@evil.com",
				]);
	});

	it("finds backslash schemes inside prose", () => {
		for (const value of ["custom:\\\\evil.net", "custom:/\\evil.net"])
			expect(values("fetch " + value + " now")).toEqual(["evil.net"]);
	});

	it("requires exact standalone list entries", () => {
		expect(normalizeAllowedTarget(" @Exämple.NET. ")).toBe("@xn--exmple-cua.net");
		expect(normalizeAllowedTarget("Evil@Exämple.NET.")).toBe("evil@xn--exmple-cua.net");
		expect(normalizeAllowedTarget("0x7f000001")).toBe("127.0.0.1");
		for (const invalid of [
			"*.net",
			"a@@example.com",
			"https://example.net",
			"a/b",
			"host:80",
			"[::1]:80",
			"@",
			".example.net",
			"A <a@b>",
			"@*.example.net",
		])
			expect(normalizeAllowedTarget(invalid)).toBeNull();
	});
});
