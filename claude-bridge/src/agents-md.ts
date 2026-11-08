type ContextFile = { path: string; content: string };

export function formatProjectContext(contextFiles: ContextFile[]): string | undefined {
	if (contextFiles.length === 0) return undefined;

	let prompt = "<project_context>\n\nProject-specific instructions and guidelines:\n\n";
	for (const { path, content } of contextFiles) {
		prompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
	}
	return `${prompt}</project_context>`;
}
