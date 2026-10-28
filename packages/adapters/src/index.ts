/**
 * Turns a repository's files into the agents and assets of a registry scan, one small adapter
 * per coding agent, and writes assets back as each agent's own files. Pure TypeScript: no network, no Node-only APIs, so it runs in a Worker.
 */
export { detect, wantsFile } from "./detect";
export { parseFrontMatter } from "./frontmatter";
export type { Detection, RepositoryTree, TreeFile } from "./types";
export type { AssetToWrite, WriteProblem, WriteResult, WrittenFile } from "./write";
export { writeAssets } from "./write";
