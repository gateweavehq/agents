import type { Email } from "./mailer";

/** An email before it is addressed. */
export type Message = Omit<Email, "to">;

const PRODUCT = "Gateweave Agents";
const DAY = 24 * 60 * 60 * 1000;

export function passwordResetEmail({ url }: { url: string }): Message {
	return compose({
		subject: `Reset your ${PRODUCT} password`,
		heading: "Reset your password",
		body: [
			`Someone asked to reset the password of your ${PRODUCT} account. If it was you, choose a new password below. The link works for one hour, once.`,
			"Resetting it signs you out on every device.",
		],
		action: { label: "Choose a new password", url },
		footer: "If you did not ask for this, ignore this email. Your password stays as it is.",
	});
}

export function verificationEmail({ url }: { url: string }): Message {
	return compose({
		subject: `Verify your email for ${PRODUCT}`,
		heading: "Verify your email",
		body: [
			`Confirm that this address is yours to finish setting up your ${PRODUCT} account. Workspaces you are invited to need it before you can join. The link works for 24 hours.`,
		],
		action: { label: "Verify email", url },
		footer: `If you did not create a ${PRODUCT} account, ignore this email.`,
	});
}

export function invitationEmail({
	inviter,
	workspace,
	url,
	expiresAt,
	now = Date.now(),
}: {
	inviter: { name: string; email: string };
	workspace: string;
	url: string;
	expiresAt: number;
	now?: number;
}): Message {
	// Names are typed by whoever sends the invitation, so they are kept short and on one line.
	const name = clip(inviter.name, 60);
	const space = clip(workspace, 60);
	const days = Math.max(1, Math.round((expiresAt - now) / DAY));
	return compose({
		subject: `${name} invited you to ${space} on ${PRODUCT}`,
		heading: `Join ${space}`,
		body: [
			`${name} (${inviter.email}) invited you to the ${space} workspace on ${PRODUCT}, where your team keeps track of its AI agents.`,
		],
		action: { label: `Join ${space}`, url },
		footer: `The invitation works only for this email address and expires in ${days} ${days === 1 ? "day" : "days"}. If you were not expecting it, ignore this email.`,
	});
}

/** To whoever runs the server, when its sandboxes have spent a share of the month's budget. */
export function sandboxBudgetEmail({
	share,
	spent,
	budget,
	month,
	server,
}: {
	share: number;
	spent: number;
	budget: number;
	month: string;
	server: string;
}): Message {
	const used = `$${spent.toFixed(2)} of its $${budget} budget for ${month}`;
	return compose({
		subject:
			share >= 100
				? `Sandboxes stopped on ${server}: the budget for ${month} is spent`
				: `Sandboxes on ${server} have used ${share}% of the budget for ${month}`,
		heading: share >= 100 ? "Sandboxes stopped" : `${share}% of the sandbox budget used`,
		body: [
			share >= 100
				? `Sandboxes on ${server} have spent ${used}, so agents that need one cannot answer until the month ends (UTC).`
				: `Sandboxes on ${server} have spent ${used}. They stop when all of it is spent, until the month ends (UTC).`,
			`${PRODUCT} prices sandbox time at the most its machine costs, so Cloudflare's bill is lower. Raise SANDBOX_MONTHLY_BUDGET to give them more.`,
		],
		action: {
			label: "See containers in Cloudflare",
			url: "https://dash.cloudflare.com/?to=/:account/workers/containers",
		},
		footer: "You get this email because this address is the server's SANDBOX_ALERT_EMAIL.",
	});
}

function compose({
	subject,
	heading,
	body,
	action,
	footer,
}: {
	subject: string;
	heading: string;
	body: string[];
	action: { label: string; url: string };
	footer: string;
}): Message {
	const text = [...body, `${action.label}: ${action.url}`, footer, `— ${PRODUCT}`].join("\n\n");
	const paragraphs = body
		.map((line) => `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`)
		.join("");
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f5f5f5;color:#171717;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:32px;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px">
<p style="margin:0 0 24px;font-size:13px;font-weight:600;color:#525252">${PRODUCT}</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>
${paragraphs}
<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:10px 16px;background:#171717;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#525252">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(action.url)}</span></p>
<p style="margin:24px 0 0;font-size:13px;color:#737373">${escapeHtml(footer)}</p>
</div>
</body>
</html>`;
	return { subject: oneLine(subject), text, html };
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
	const line = oneLine(value);
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
