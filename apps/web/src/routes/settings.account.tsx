import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { LegalLinks } from "#/components/legal-links";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { getAccount } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

// Under /settings because no workspace can be called that, so this takes no workspace's address.
export const Route = createFileRoute("/settings/account")({
	beforeLoad: async () => {
		const { account, legal } = await getAccount();
		if (!account) throw redirect({ to: "/login" });
		return { account, legal };
	},
	component: AccountPage,
});

function AccountPage() {
	const { account, legal } = Route.useRouteContext();
	const [deleted, setDeleted] = useState(false);
	useDocumentTitle(deleted ? "Account deleted" : "Your account");

	if (deleted) {
		return (
			<main className="mx-auto max-w-lg space-y-4 p-6 pt-24">
				<h1 className="text-xl font-semibold tracking-tight">Your account is deleted</h1>
				<p className="text-sm text-muted-foreground">
					Your conversations with agents are being deleted, with their sandboxes.
				</p>
				<Button variant="outline" size="sm" asChild>
					<Link to="/login">Back to sign-in</Link>
				</Button>
				<LegalLinks links={legal} />
			</main>
		);
	}

	return (
		<main className="mx-auto max-w-lg space-y-10 p-6 pt-24">
			<header className="flex items-center justify-between gap-4">
				<div className="min-w-0">
					<h1 className="text-xl font-semibold tracking-tight">Your account</h1>
					<p className="break-words text-sm text-muted-foreground">{account.name}</p>
					<p className="break-words text-sm text-muted-foreground">{account.email}</p>
				</div>
				<Button variant="ghost" size="sm" asChild>
					<Link to="/">Workspaces</Link>
				</Button>
			</header>

			<DeleteAccount
				email={account.email}
				hasPassword={account.hasPassword}
				onDeleted={() => setDeleted(true)}
			/>

			<LegalLinks links={legal} />
		</main>
	);
}

/** What to say about a refusal, where the server's own words are not for people. */
function failure(error: { code?: string | undefined; message?: string | undefined }) {
	if (error.code === "SESSION_NOT_FRESH") {
		return "You signed in a while ago. Sign out and sign in again, then try this again.";
	}
	return error.message || "Something went wrong";
}

/**
 * Asks for the password where there is one, which the server insists on. An account without one
 * types its address, which guards only against a slip: for those, a recent session is all the proof
 * there is.
 */
function DeleteAccount({
	email,
	hasPassword,
	onDeleted,
}: {
	email: string;
	hasPassword: boolean;
	onDeleted: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setError(null);
		if (!hasPassword && String(form.get("address")).trim().toLowerCase() !== email.toLowerCase()) {
			setError("That is not the address of this account.");
			return;
		}
		setPending(true);
		const result = await authClient.$fetch("/account/delete", {
			method: "POST",
			body: hasPassword ? { password: String(form.get("password")) } : {},
		});
		if (result.error) {
			setPending(false);
			setError(failure(result.error));
			return;
		}
		onDeleted();
	}

	return (
		<section aria-labelledby="delete-heading" className="space-y-4">
			<h2 id="delete-heading" className="text-sm font-semibold">
				Delete account
			</h2>
			{open ? (
				<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
					<p className="text-sm text-muted-foreground">
						This removes your account and takes you out of your workspaces. It cannot be undone.
					</p>
					<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
						<li>Your conversations with agents go, with their messages and sandboxes.</li>
						<li>
							Your runs stay in each workspace's usage, under "A former member". They hold no words.
						</li>
						<li>
							What you set up for a workspace stays with it: agents, triggers, keys, secrets and
							connections, including tokens you connected. To stop one, disconnect it first or
							revoke it at the service.
						</li>
						<li>Invitations you sent that nobody has taken stop working.</li>
					</ul>
					{hasPassword ? (
						<>
							{/* Tells a password manager which account this password belongs to. */}
							<input
								type="email"
								name="username"
								autoComplete="username"
								value={email}
								readOnly
								hidden
							/>
							<div className="space-y-2">
								<Label htmlFor="delete-password">Your password</Label>
								<Input
									id="delete-password"
									name="password"
									type="password"
									autoComplete="current-password"
									required
								/>
							</div>
						</>
					) : (
						<div className="space-y-2">
							<Label htmlFor="delete-address">Type your email address to confirm</Label>
							<Input id="delete-address" name="address" type="email" autoComplete="off" required />
						</div>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<LiveButton type="submit" variant="destructive" size="sm" disabled={pending}>
							Delete my account
						</LiveButton>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => {
								setOpen(false);
								setError(null);
							}}
						>
							Keep it
						</Button>
					</div>
				</form>
			) : (
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border p-4">
					<p className="text-sm text-muted-foreground">Remove this account for good.</p>
					<LiveButton variant="outline" size="sm" onClick={() => setOpen(true)}>
						Delete account
					</LiveButton>
				</div>
			)}
		</section>
	);
}
