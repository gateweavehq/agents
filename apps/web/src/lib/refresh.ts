import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

/** Reloads the page's data every few seconds while `waiting` holds, such as while a scan runs. */
export function useRefreshWhile(waiting: boolean, intervalMs = 3000) {
	const router = useRouter();
	useEffect(() => {
		if (!waiting) return;
		const timer = setInterval(() => void router.invalidate(), intervalMs);
		return () => clearInterval(timer);
	}, [waiting, intervalMs, router]);
}
