import { useRouter } from "@tanstack/react-router";
import { openDemoSandbox } from "#/lib/demo-opening";

/** Opens a new demo sandbox through the opening screen, and goes into it. */
export function useOpenDemo(): () => void {
	const router = useRouter();
	return () =>
		openDemoSandbox(async (slug) => {
			await router.invalidate();
			await router.navigate({ to: "/$workspace", params: { workspace: slug } });
		});
}
