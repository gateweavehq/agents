import { Check, Copy } from "lucide-react";
import {
	type ComponentProps,
	isValidElement,
	memo,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "#/lib/utils";

/**
 * An agent's reply, rendered as Markdown (GFM: tables, task lists, strikethrough).
 *
 * The text comes from a model, so it is untrusted. react-markdown turns Markdown into React
 * elements and shows any raw HTML as text; do not add `rehype-raw`, which would let the model
 * inject elements. Keep the default `urlTransform` too: it drops `javascript:` and other unsafe
 * URLs from links and images.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
	return (
		<div className="space-y-3 break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{children}
			</ReactMarkdown>
		</div>
	);
});

const components: Components = {
	a: ({ node: _node, className, ...props }) => (
		<a
			{...props}
			target="_blank"
			rel="noopener noreferrer nofollow"
			className={cn("font-medium underline underline-offset-2 hover:opacity-80", className)}
		/>
	),
	h1: ({ node: _node, ...props }) => <h1 className="mt-5 text-lg font-semibold" {...props} />,
	h2: ({ node: _node, ...props }) => <h2 className="mt-5 text-base font-semibold" {...props} />,
	h3: ({ node: _node, ...props }) => <h3 className="mt-4 text-sm font-semibold" {...props} />,
	h4: ({ node: _node, ...props }) => <h4 className="mt-4 text-sm font-semibold" {...props} />,
	h5: ({ node: _node, ...props }) => <h5 className="mt-4 text-sm font-medium" {...props} />,
	h6: ({ node: _node, ...props }) => (
		<h6 className="mt-4 text-sm font-medium text-muted-foreground" {...props} />
	),
	ul: ({ node: _node, className, ...props }) => (
		<ul
			className={cn(
				"list-disc space-y-1 pl-5",
				// GFM task lists carry their own checkboxes.
				className?.includes("contains-task-list") && "list-none pl-0",
				className,
			)}
			{...props}
		/>
	),
	ol: ({ node: _node, ...props }) => <ol className="list-decimal space-y-1 pl-5" {...props} />,
	blockquote: ({ node: _node, ...props }) => (
		<blockquote className="border-l-2 pl-3 text-muted-foreground" {...props} />
	),
	hr: () => <hr className="my-4 border-border" />,
	table: ({ node: _node, ...props }) => (
		<div className="overflow-x-auto rounded-lg border">
			<table className="w-full border-collapse text-left text-sm" {...props} />
		</div>
	),
	thead: ({ node: _node, ...props }) => <thead className="bg-muted/60" {...props} />,
	th: ({ node: _node, ...props }) => (
		<th className="border-b px-3 py-1.5 font-medium whitespace-nowrap" {...props} />
	),
	td: ({ node: _node, ...props }) => (
		<td className="border-b px-3 py-1.5 align-top last-of-type:border-r-0" {...props} />
	),
	input: ({ node: _node, ...props }) => <input className="mr-2 align-middle" {...props} />,
	pre: CodeBlock,
	code: ({ node: _node, className, ...props }) => (
		// Block code sits inside a `pre`, which gives it its look; this styles inline code.
		<code
			className={cn(
				"rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] [pre_&]:bg-transparent [pre_&]:p-0 [pre_&]:text-[1em]",
				className,
			)}
			{...props}
		/>
	),
};

function CodeBlock({
	node: _node,
	children,
	...props
}: ComponentProps<"pre"> & { node?: unknown }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	async function copy() {
		try {
			await navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
		} catch {
			return; // Clipboard access was denied; leave the button as it is.
		}
		setCopied(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), 1500);
	}

	return (
		<div className="group relative">
			<pre
				className="overflow-x-auto rounded-lg border bg-muted/60 p-3 font-mono text-[0.85em] leading-normal"
				{...props}
			>
				{children}
			</pre>
			<button
				type="button"
				onClick={copy}
				aria-label={copied ? "Copied" : "Copy code"}
				className="absolute top-1.5 right-1.5 inline-flex size-7 items-center justify-center rounded-md border bg-background/80 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(hover:none)]:opacity-100"
			>
				{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
			</button>
		</div>
	);
}

/** The text inside rendered children, for the copy button. */
function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
	return "";
}
