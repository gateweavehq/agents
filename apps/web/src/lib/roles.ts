/** A person's role in a workspace, highest first. Better Auth's organization roles. */
export const MEMBER_ROLES = ["owner", "admin", "member"] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];
