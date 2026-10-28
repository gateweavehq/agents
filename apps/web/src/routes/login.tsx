import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { safeRedirect } from "#/lib/redirect";
import { getAuthOptions, getSession } from "#/lib/session";

const loginSearch = z.object({
	/** Where to go once signed in, such as the invitation that sent the user here. */
	redirect: z.string().optional().catch(undefined),
	/** Prefills the email field, for example with the address an invitation was sent to. */
	email: z.string().optional().catch(undefined),
	mode: z.enum(["sign-in", "sign-up"]).optional().catch(undefined),
});

export const Route = createFileRoute("/login")({
	validateSearch: loginSearch,
	beforeLoad: async ({ search }) => {
		if (await getSession()) throw redirect({ href: safeRedirect(search.redirect) ?? "/" });
	},
	loader: () => getAuthOptions(),
	component: SignInForm,
});

function SignInForm() {
	const options = Route.useLoaderData();
	const search = Route.useSearch();
	const next = safeRedirect(search.redirect) ?? "/";
	const router = useRouter();
	const [mode, setMode] = useState<"sign-in" | "sign-up">(search.mode ?? "sign-in");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const email = String(form.get("email"));
		const password = String(form.get("password"));
		setPending(true);
		setError(null);
		const result =
			mode === "sign-in"
				? await authClient.signIn.email({ email, password })
				: await authClient.signUp.email({
						email,
						password,
						name: String(form.get("name")),
						// Where the verification email brings them back to, such as an invitation.
						callbackURL: next,
					});
		if (result.error) {
			setPending(false);
			setError(result.error.message ?? "Something went wrong");
			return;
		}
		if (mode === "sign-up" && options.email) {
			toast.success("Check your email", {
				description: `We sent a link to verify ${email}.`,
			});
		}
		setPending(false);
		await router.invalidate();
		await router.navigate({ href: next });
	}

	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-sm space-y-6">
				<div className="space-y-1.5 text-center">
					<h1 className="text-xl font-semibold tracking-tight">
						{mode === "sign-in" ? "Sign in to Gateweave Agents" : "Create your account"}
					</h1>
					<p className="text-sm text-muted-foreground">
						Every AI agent across your repositories, in one place.
					</p>
				</div>

				{options.github && (
					<>
						<Button
							variant="outline"
							className="w-full"
							onClick={() => authClient.signIn.social({ provider: "github", callbackURL: next })}
						>
							Continue with GitHub
						</Button>
						<div className="flex items-center gap-3 text-xs text-muted-foreground">
							<span className="h-px flex-1 bg-border" />
							or
							<span className="h-px flex-1 bg-border" />
						</div>
					</>
				)}

				<form onSubmit={onSubmit} className="space-y-4">
					{mode === "sign-up" && (
						<div className="space-y-2">
							<Label htmlFor="name">Name</Label>
							<Input id="name" name="name" autoComplete="name" required />
						</div>
					)}
					<div className="space-y-2">
						<Label htmlFor="email">Email</Label>
						<Input
							id="email"
							name="email"
							type="email"
							autoComplete="email"
							defaultValue={search.email}
							required
						/>
					</div>
					<div className="space-y-2">
						<div className="flex items-baseline justify-between">
							<Label htmlFor="password">Password</Label>
							{mode === "sign-in" && options.email && (
								<Link
									to="/forgot-password"
									search={{ email: search.email }}
									className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
								>
									Forgot password?
								</Link>
							)}
						</div>
						<Input
							id="password"
							name="password"
							type="password"
							minLength={8}
							autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
							required
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<Button type="submit" className="w-full" disabled={pending}>
						{mode === "sign-in" ? "Sign in" : "Create account"}
					</Button>
				</form>

				<p className="text-center text-sm text-muted-foreground">
					{mode === "sign-in" ? "New to Gateweave Agents? " : "Already have an account? "}
					<button
						type="button"
						className="font-medium text-foreground underline-offset-4 hover:underline"
						onClick={() => {
							setMode(mode === "sign-in" ? "sign-up" : "sign-in");
							setError(null);
						}}
					>
						{mode === "sign-in" ? "Create an account" : "Sign in"}
					</button>
				</p>
			</div>
		</main>
	);
}
