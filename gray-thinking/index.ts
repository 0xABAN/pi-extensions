import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Unwrap markdown so thinking renders as plain thinkingText (no md/syntax colors). */
function plainThinking(md: string): string {
	let s = md;
	// fenced code — closed or still open while streaming
	s = s.replace(/```[\w+-]*\r?\n?([\s\S]*?)(?:```|$)/g, "$1");
	s = s.replace(/`([^`\n]+)`/g, "$1");
	s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	s = s.replace(/^#{1,6}\s+/gm, "");
	s = s.replace(/(\*\*\*|___)([\s\S]*?)\1/g, "$2");
	s = s.replace(/(\*\*|__)([\s\S]*?)\1/g, "$2");
	s = s.replace(/(\*|_)([^\n]+?)\1/g, "$2");
	s = s.replace(/~~([\s\S]*?)~~/g, "$1");
	s = s.replace(/^>\s?/gm, "");
	s = s.replace(/^(\s*)([-*+]|\d+\.)\s+/gm, "$1");
	s = s.replace(/^([-*_]){3,}\s*$/gm, "");
	// kill any leftover markup so the renderer stays monochrome
	s = s.replace(/([\\`*_{}\[\]#|])/g, "\\$1");
	return s;
}

export default function (pi: ExtensionAPI) {
	pi.registerMarkdownTransformer((markdown, { messageType }) =>
		messageType === "assistant-thinking" ? plainThinking(markdown) : markdown,
	);
}
