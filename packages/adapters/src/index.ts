/**
 * Turns a repository's files into the agents and assets of a registry scan, one small adapter
 * per coding agent, and writes assets back as each agent's own files. Pure TypeScript: no network, no Node-only APIs, so it runs in a Worker.
 */
export type { ApplyPlan, ApplyPlanInput, ApplyProblem, RepositoryEntry } from "./apply";
export { MERGED_FILES, planApply } from "./apply";
export { detect, wantsFile } from "./detect";
export { parseFrontMatter } from "./frontmatter";
export type { SetupFolder, SetupFolderResult } from "./setup-folder";
export { readSetupFolder } from "./setup-folder";
export type { Detection, RepositoryTree, TreeFile } from "./types";
export type { AssetToWrite, WriteProblem, WriteResult, WrittenFile } from "./write";
export { writeAssets } from "./write";
