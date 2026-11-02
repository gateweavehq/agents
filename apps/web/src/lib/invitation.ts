/**
 * A link to ask for an invitation: the server's contact, an https URL as it is, or an email
 * address as a message that names the workspace, whose id is what an invitation lists. Null when
 * the contact is neither.
 */
export function invitationLink(
	contact: string | undefined,
	workspace: { id: string; name: string },
): string | null {
	const value = contact?.trim() ?? "";
	if (/^https:\/\/\S+$/.test(value)) return value;
	if (!/^[^\s@<>"?&]+@[^\s@<>"?&]+\.[^\s@<>"?&]+$/.test(value)) return null;
	const subject = `Invitation for ${workspace.name}`;
	const body = `Please invite the workspace ${workspace.name} (${workspace.id}) to Workers AI and sandboxes.`;
	const query = new URLSearchParams({ subject, body }).toString().replaceAll("+", "%20");
	return `mailto:${value}?${query}`;
}
