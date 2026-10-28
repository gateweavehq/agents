import {
	type NewTeamInput,
	type RunnableAgent,
	TEAM_EDGE_KINDS,
	type Team,
	type TeamEdge,
	type TeamEdgeKind,
	type TeamEntry,
	type TeamMember,
	type TeamMemberKind,
} from "@gateweave/agents-model";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { EDGE_VERBS } from "./team-graph";

const SELECT = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";

/** What each kind of edge lets one member do, for the person choosing it. */
export const EDGE_MEANINGS: Record<TeamEdgeKind, string> = {
	delegate: "Hands over a task and waits for the result",
	ask: "Asks one question, answered without tools",
	report: "Sends a message without waiting",
};

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

/** Names a new team and chooses its lead, or changes the name and description of `team`. */
export function TeamDialog({
	team,
	agents = [],
	onSave,
	onClose,
}: {
	team?: Team;
	/** The agents that can lead a new team. */
	agents?: RunnableAgent[];
	onSave: (input: NewTeamInput) => Promise<void>;
	onClose: () => void;
}) {
	const [name, setName] = useState(team?.name ?? "");
	const [description, setDescription] = useState(team?.description ?? "");
	const [lead, setLead] = useState(team?.leadAgentId ?? agents[0]?.id ?? "");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			await onSave({ name: name.trim(), description: description.trim() || null, lead });
			onClose();
		} catch (failure) {
			setError(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>{team ? "Edit team" : "New team"}</DialogTitle>
						<DialogDescription>
							A team is led by an agent run by Gateweave. Its members are agents or other teams, and
							its edges say who may delegate to, ask or report to whom.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="team-name">Name</Label>
						<Input
							id="team-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={100}
							autoFocus
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="team-description">Description</Label>
						<Textarea
							id="team-description"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							maxLength={2000}
							rows={3}
						/>
					</div>
					{!team && (
						<div className="space-y-2">
							<Label htmlFor="team-lead">Lead</Label>
							<select
								id="team-lead"
								value={lead}
								onChange={(event) => setLead(event.target.value)}
								className={SELECT}
								required
							>
								{agents.map((agent) => (
									<option key={agent.id} value={agent.id}>
										{agent.name}
									</option>
								))}
							</select>
							<p className="text-xs text-muted-foreground">
								A chat with the team talks to its lead.
							</p>
						</div>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || !name.trim() || !lead}>
							{team ? "Save" : "Create team"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Chooses an agent or a team to join a team. */
export function AddMemberDialog({
	agents,
	teams,
	onAdd,
	onClose,
}: {
	/** Those not in the team yet. */
	agents: RunnableAgent[];
	teams: TeamEntry[];
	onAdd: (member: { kind: TeamMemberKind; id: string }) => Promise<void>;
	onClose: () => void;
}) {
	const first = agents[0] ? `agent:${agents[0].id}` : teams[0] ? `team:${teams[0].team.id}` : "";
	const [choice, setChoice] = useState(first);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		const [kind, id] = choice.split(":");
		if ((kind !== "agent" && kind !== "team") || !id) return;
		setPending(true);
		setError(null);
		try {
			await onAdd({ kind, id });
			onClose();
		} catch (failure) {
			setError(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Add a member</DialogTitle>
						<DialogDescription>
							An agent run by Gateweave, or another team. In edges, a team stands for its lead.
						</DialogDescription>
					</DialogHeader>
					{first === "" ? (
						<p className="text-sm text-muted-foreground">
							Every agent run by Gateweave and every other team is in this team already.
						</p>
					) : (
						<div className="space-y-2">
							<Label htmlFor="team-member">Member</Label>
							<select
								id="team-member"
								value={choice}
								onChange={(event) => setChoice(event.target.value)}
								className={SELECT}
							>
								{agents.length > 0 && (
									<optgroup label="Agents">
										{agents.map((agent) => (
											<option key={agent.id} value={`agent:${agent.id}`}>
												{agent.name}
											</option>
										))}
									</optgroup>
								)}
								{teams.length > 0 && (
									<optgroup label="Teams">
										{teams.map(({ team, lead }) => (
											<option key={team.id} value={`team:${team.id}`}>
												{team.name} (led by {lead.name})
											</option>
										))}
									</optgroup>
								)}
							</select>
						</div>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || first === ""}>
							Add
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Lets one member reach another. */
export function AddEdgeDialog({
	members,
	edges,
	onAdd,
	onClose,
}: {
	members: TeamMember[];
	edges: TeamEdge[];
	onAdd: (edge: TeamEdge) => Promise<void>;
	onClose: () => void;
}) {
	const [from, setFrom] = useState(members[0]?.id ?? "");
	const [kind, setKind] = useState<TeamEdgeKind>("delegate");
	const [to, setTo] = useState(members[1]?.id ?? "");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const name = (id: string) => members.find((member) => member.id === id)?.name ?? "";
	const exists = edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			await onAdd({ from, to, kind });
			onClose();
		} catch (failure) {
			setError(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Add an edge</DialogTitle>
						<DialogDescription>
							Members reach each other only along edges. Delegate and ask edges wait for an answer,
							so they cannot go in a circle.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="edge-from">From</Label>
						<select
							id="edge-from"
							value={from}
							onChange={(event) => setFrom(event.target.value)}
							className={SELECT}
						>
							{members.map((member) => (
								<option key={member.id} value={member.id}>
									{member.name}
								</option>
							))}
						</select>
					</div>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">Kind</legend>
						{TEAM_EDGE_KINDS.map((option) => (
							<Label key={option} className="flex items-start gap-2 font-normal">
								<input
									type="radio"
									name="edge-kind"
									value={option}
									checked={kind === option}
									onChange={() => setKind(option)}
									className="mt-0.5"
								/>
								<span>
									<span className="font-medium capitalize">{option}</span>
									<span className="block text-xs text-muted-foreground">
										{EDGE_MEANINGS[option]}
									</span>
								</span>
							</Label>
						))}
					</fieldset>
					<div className="space-y-2">
						<Label htmlFor="edge-to">To</Label>
						<select
							id="edge-to"
							value={to}
							onChange={(event) => setTo(event.target.value)}
							className={SELECT}
						>
							{members.map((member) => (
								<option key={member.id} value={member.id} disabled={member.id === from}>
									{member.name}
								</option>
							))}
						</select>
					</div>
					{from && to && from !== to && (
						<p className="text-sm text-muted-foreground">
							{exists
								? "That edge is there already."
								: `${name(from)} ${EDGE_VERBS[kind]} ${name(to)}.`}
						</p>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || !from || !to || from === to || exists}>
							Add
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
