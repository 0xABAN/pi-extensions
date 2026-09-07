import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Editor, type TUI, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ExtensionContext, type InputEvent, type InputEventResult, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import inlineSkills, { createSkillProvider, expandInlineSkills, inlinePrefix } from "./index.ts";
import { enableInlineTrigger } from "./editor.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-inline-skills-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function skill(name: string): SlashCommandInfo {
  const path = join(directory, `${name}.md`);
  writeFileSync(path, `---\nname: ${name}\ndescription: test skill\n---\nInstructions for ${name}.`);
  return {
    name: `skill:${name}`, description: name, source: "skill",
    sourceInfo: { path, source: "test", scope: "temporary", origin: "top-level", baseDir: directory },
  };
}
const skills = [skill("simplify"), skill("writing-pull-requests")];
const options = { signal: new AbortController().signal };
const fallback: AutocompleteProvider = {
  triggerCharacters: ["#"],
  async getSuggestions() { return { prefix: "fallback", items: [{ value: "fallback", label: "fallback" }] }; },
  applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
  shouldTriggerFileCompletion() { return false; },
};

test("inline prefixes work after whitespace and on later lines, not in paths or code", () => {
  for (const text of ["Review /", "Review /sim", "Review /skill:sim"]) {
    expect(inlinePrefix([text], 0, text.length)).toBe(text.split(" ")[1]);
  }
  expect(inlinePrefix(["Review", "/"], 1, 1)).toBe("/");
  for (const text of ["/", " /sim", "See https://host/sim", "See /tmp/file", "See ./sim", "Use `example /sim", "Review /clear args"]) {
    expect(inlinePrefix([text], 0, text.length)).toBeUndefined();
  }
  expect(inlinePrefix(["```", "/sim"], 1, 4)).toBeUndefined();
});

test("suggestions use the live skill catalog and delegate unrelated completion", async () => {
  let catalog = skills;
  const provider = createSkillProvider(fallback, () => catalog);
  for (const text of ["Review /", "Review /sim", "Review /skill:sim"]) {
    const result = await provider.getSuggestions([text], 0, text.length, options);
    expect(result?.items[0].value).toBe("/skill:simplify");
  }
  catalog = [skills[1]];
  expect((await provider.getSuggestions(["Review /"], 0, 8, options))?.items).toHaveLength(1);
  for (const text of ["/clear", "Review /unknown", "See /tmp/file", "See @file"]) {
    expect((await provider.getSuggestions([text], 0, text.length, options))?.prefix).toBe("fallback");
  }
  expect(provider.triggerCharacters).toEqual(["#"]);
  expect(provider.shouldTriggerFileCompletion?.(["file"], 0, 4)).toBe(false);
});

test("completion preserves text on both sides and works at a later line start", () => {
  const provider = createSkillProvider(fallback, () => skills);
  const item = { value: "/skill:simplify", label: "/skill:simplify" };
  expect(provider.applyCompletion(["Review /sim please"], 0, 11, item, "sim")).toEqual({
    lines: ["Review /skill:simplify please"], cursorLine: 0, cursorCol: 22,
  });
  expect(provider.applyCompletion(["Review", "/sim"], 1, 4, item, "sim")).toEqual({
    lines: ["Review", "/skill:simplify "], cursorLine: 1, cursorCol: 16,
  });
});

test("expansion loads each selected skill once and preserves the complete prompt", () => {
  const text = "Review /skill:simplify using /skill:writing-pull-requests then /skill:simplify";
  const expanded = expandInlineSkills(text, skills)!;
  expect(expanded.endsWith(text)).toBe(true);
  expect(expanded.match(/Instructions for simplify\./g)).toHaveLength(1);
  expect(expanded).toContain("Instructions for writing-pull-requests.");
  expect(expanded).toContain(`References are relative to ${directory}.`);
  expect(expanded).not.toContain("description: test skill");
  expect(expandInlineSkills("/skill:simplify and /skill:writing-pull-requests", skills)).toContain("Instructions for simplify.");
  expect(expandInlineSkills("Review\n/skill:simplify", skills)).toContain("Instructions for simplify.");
});

test("native leading invocations, unknown skills, paths, URLs, and literals stay unchanged", () => {
  for (const text of [
    "/skill:simplify review this", "Review /skill:missing", "Review /clear",
    "Read /skill:simplify/file", "Read /skill:simplify.md", "https://example/skill:simplify",
    "Use `/skill:simplify`", "Example:\n```text\n/skill:simplify\n```",
    "Example:\n~~~\n/skill:simplify\n~~~", "Example:\n```\n/skill:simplify",
    "Review \\/skill:simplify",
  ]) expect(expandInlineSkills(text, skills)).toBeUndefined();
});

test("input transforms preserve images and queue policy, skip programmatic input, and block read failures", () => {
  let input!: (event: InputEvent, ctx: ExtensionContext) => InputEventResult | undefined;
  let catalog = skills;
  inlineSkills({
    on(event: string, handler: typeof input) { if (event === "input") input = handler; },
    getCommands: () => [...catalog, { ...skills[0], name: "review", source: "prompt" }],
  } as unknown as ExtensionAPI);
  const notifications: string[] = [];
  let editorText = "";
  const ctx = { ui: {
    notify(message: string) { notifications.push(message); },
    getEditorText: () => editorText,
    setEditorText(text: string) { editorText = text; },
  } } as unknown as ExtensionContext;
  const event: InputEvent = {
    type: "input", text: "Review /skill:simplify", source: "interactive", streamingBehavior: "followUp",
    images: [{ type: "image", data: "test", mimeType: "image/png" }],
  };
  const result = input(event, ctx);
  expect(result?.action).toBe("transform");
  expect(result).not.toHaveProperty("images"); // Pi retains the original images when omitted.
  expect(event.streamingBehavior).toBe("followUp");
  expect(event.images).toHaveLength(1);
  expect(input({ ...event, source: "extension" }, ctx)).toBeUndefined();
  expect(input({ ...event, source: "rpc" }, ctx)).toBeUndefined();
  catalog = [{ ...skills[0], sourceInfo: { ...skills[0].sourceInfo, path: join(directory, "missing.md") } }];
  expect(input(event, ctx)).toEqual({ action: "handled" });
  expect(notifications[0]).toContain("could not load requested skill");
  expect(editorText).toBe(event.text);
});

test("Pi discovers the package manifest and loads the extension through its real loader", async () => {
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ packages: [import.meta.dir] }),
    additionalSkillPaths: [skills[0].sourceInfo.path],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  expect(loaded.extensions[0].handlers.has("session_start")).toBe(true);
  expect(loaded.extensions[0].handlers.has("input")).toBe(true);
  const discovered = loader.getSkills().skills[0];
  expect(expandInlineSkills("Review /skill:simplify", [{
    name: `skill:${discovered.name}`, description: discovered.description,
    source: "skill", sourceInfo: discovered.sourceInfo,
  }])).toContain("Instructions for simplify.");
});

test("resubmitting expanded queue text is idempotent and can add another skill", () => {
  const expanded = expandInlineSkills("Review /skill:simplify", skills)!;
  expect(expandInlineSkills(expanded, skills)).toBeUndefined();
  const withAnother = expandInlineSkills(`${expanded}\nAlso /skill:writing-pull-requests`, skills)!;
  expect(withAnother.match(/Instructions for simplify\./g)).toHaveLength(1);
  expect(withAnother).toContain("Instructions for writing-pull-requests.");
});

test("references resolve beside the skill file, not its discovery root", () => {
  const command = { ...skills[0], sourceInfo: { ...skills[0].sourceInfo, baseDir: "/discovery-root" } };
  expect(expandInlineSkills("Review /skill:simplify", [command])).toContain(`References are relative to ${directory}.`);
});

const plain = (text: string) => text;
function createEditor() {
  const editor = new Editor({ requestRender() {} } as TUI, {
    borderColor: plain,
    selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
  });
  editor.setAutocompleteProvider(createSkillProvider(fallback, () => skills));
  enableInlineTrigger(editor, inlinePrefix);
  return editor;
}

test("real Pi editor opens an inline slash dropdown, selects a skill, and allows dismissal", async () => {
  const editor = createEditor();
  for (const character of "Review /") editor.handleInput(character);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(editor.isShowingAutocomplete()).toBe(true);
  expect(editor.getText()).toBe("Review /"); // Opening must not auto-select a lone match.
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);
  editor.handleInput("\r");
  expect(submitted).toEqual([]);
  expect(editor.getText()).toBe("Review /skill:simplify ");
  expect(expandInlineSkills(editor.getText(), skills)).toContain("Instructions for simplify.");
  editor.setText("Review\n");
  editor.handleInput("/");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(editor.isShowingAutocomplete()).toBe(true);
  editor.handleInput("\x1b");
  expect(editor.isShowingAutocomplete()).toBe(false);
});
