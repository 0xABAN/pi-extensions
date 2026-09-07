import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { CustomEditor, stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { enableInlineTrigger } from "./editor.ts";

type SkillCommand = ReturnType<ExtensionAPI["getCommands"]>[number];

// ponytail: recognize backtick/tilde literals, not full Markdown; use a Markdown parser if richer syntax is needed.
function insideLiteral(text: string, offset: number): boolean {
  return [...text.matchAll(/(`+|~{3,})[\s\S]*?(?:\1|$)/g)]
    .some((match) => match.index <= offset && offset < match.index + match[0].length);
}

export function inlinePrefix(lines: string[], line: number, col: number): string | undefined {
  const beforeCursor = (lines[line] ?? "").slice(0, col);
  const match = beforeCursor.match(/(?:^|\s)(\/(?:skill:)?[a-z0-9-]*)$/);
  if (!match) return;
  const prefix = match[1];
  const start = beforeCursor.length - prefix.length;
  // Keep Pi's leading command menu, including operational commands and templates.
  if (line === 0 && beforeCursor.slice(0, start).trim() === "") return;
  const text = [...lines.slice(0, line), beforeCursor].join("\n");
  if (insideLiteral(text, text.length - prefix.length)) return;
  return prefix;
}

export function createSkillProvider(
  current: AutocompleteProvider,
  getSkills: () => SkillCommand[],
): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, line, col, options) {
      const prefix = inlinePrefix(lines, line, col);
      if (prefix === undefined || options.signal.aborted) {
        return current.getSuggestions(lines, line, col, options);
      }
      const query = prefix.slice(1).replace(/^skill:/, "");
      const items = fuzzyFilter(getSkills(), query, (skill) => skill.name.slice(6))
        .map((skill) => ({
          value: `/${skill.name}`,
          label: `/${skill.name}`,
          description: skill.description,
        }));
      // Exclude '/' from the replacement prefix: Pi submits slash-prefixed menus on Enter.
      // Inline selections should insert only. Paths still fall back to the base provider.
      return items.length ? { prefix: prefix.slice(1), items } : current.getSuggestions(lines, line, col, options);
    },
    applyCompletion(lines, line, col, item, prefix) {
      if (!item.value.startsWith("/skill:") || inlinePrefix(lines, line, col) !== `/${prefix}`) {
        return current.applyCompletion(lines, line, col, item, prefix);
      }
      const currentLine = lines[line];
      const before = currentLine.slice(0, col - prefix.length - 1);
      const after = currentLine.slice(col);
      const separator = /^\s/.test(after) ? "" : " ";
      const result = [...lines];
      result[line] = before + item.value + separator + after;
      return { lines: result, cursorLine: line, cursorCol: before.length + item.value.length + separator.length };
    },
    shouldTriggerFileCompletion(lines, line, col) {
      return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
    },
  };
}

export function expandInlineSkills(text: string, skills: SkillCommand[]): string | undefined {
  const byName = new Map(skills.map((skill) => [`/${skill.name}`, skill]));
  // Pi restores expanded queue text when dequeuing. Do not load it again or scan skill bodies.
  const loaded = new Set<string>();
  const promptText = text.replace(/^<skill name="([^"]+)" location=[^\n]+>\n[\s\S]*?^<\/skill>$/gm, (block, name) => {
    loaded.add(`/skill:${name}`);
    return block.replace(/[^\n]/g, " ");
  });
  const matches = [...promptText.matchAll(/(?<!\S)\/skill:[^\s]+/g)]
    .filter((match) => byName.has(match[0]) && !loaded.has(match[0]) && !insideLiteral(promptText, match.index));
  // A single leading invocation stays on Pi's native expansion path.
  if (!matches.length || (matches.length === 1 && matches[0].index === 0)) return;
  const selected = [...new Set(matches.map((match) => match[0]))];
  const blocks = selected.map((name) => {
    const skill = byName.get(name)!;
    const path = skill.sourceInfo.path;
    const body = stripFrontmatter(readFileSync(path, "utf8")).trim();
    const baseDir = dirname(path);
    return `<skill name=${JSON.stringify(skill.name.slice(6))} location=${JSON.stringify(path)}>\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
  });
  // Preserve the entire prompt, including the references that explain the user's intent.
  return `${blocks.join("\n\n")}\n\n${text}`;
}

export default function inlineSkills(pi: ExtensionAPI): void {
  // Resolve lazily: resources can change after startup or on reload.
  const getSkills = () => pi.getCommands().filter((command) => command.source === "skill");

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) => createSkillProvider(current, getSkills));
    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      enableInlineTrigger(editor, inlinePrefix);
      return editor;
    });
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive") return;
    try {
      const text = expandInlineSkills(event.text, getSkills());
      if (text !== undefined) return { action: "transform", text };
    } catch (error) {
      ctx.ui.notify(`Inline skills: could not load requested skill. ${String(error)}`, "error");
      if (!ctx.ui.getEditorText()) ctx.ui.setEditorText(event.text);
      return { action: "handled" };
    }
  });
}
