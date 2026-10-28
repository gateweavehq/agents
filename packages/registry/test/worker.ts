export { RegistryDO } from "../src";

export default {
	fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
