/**
 * Turns a repository's files into the agents and assets of a registry scan, one small adapter
 * per coding agent. Pure TypeScript: no network, no Node-only APIs, so it runs in a Worker.
 */
export { detect, wantsFile } from "./detect";
export type { Detection, RepositoryTree, TreeFile } from "./types";
