import { expect, test } from "bun:test";
import { CURSOR_MARKER, getKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { BashModeEditor } from "../bash-mode/editor.ts";

function shellEditor(paddingX: number) {
  const keybindings = getKeybindings() as never;
  const editor = new BashModeEditor({ requestRender() {}, terminal: { columns: 80, rows: 24 } }, {}, keybindings, {
    keybindings,
    isBashModeActive: () => true,
    isShellRunning: () => false,
    onExitBashMode() {},
    onSubmitCommand() {},
    onInterrupt() {},
    onNotify() {},
    getHistoryEntries: () => [],
    resolveGhostSuggestion: async () => null,
  });
  editor.borderColor = (text: string) => text;
  editor.setPaddingX(paddingX);
  editor.focused = true;
  editor.setText("git st");
  Reflect.set(editor, "ghost", { value: "git status" });
  return editor;
}

test("draws the shell suggestion after the cursor without losing its marker or padding", () => {
  const row = shellEditor(2).render(40)[1]!;

  expect(row).toContain(CURSOR_MARKER);
  expect(visibleWidth(row)).toBe(40);
  expect(stripTerminalSequences(row)).toBe(`  git st atus${" ".repeat(27)}`);
});
