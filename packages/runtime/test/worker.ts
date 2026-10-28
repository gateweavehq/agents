export { RegistryDO } from "@gateweave/agents-registry";
export { ConversationAgent } from "../src";

export default {
	fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
