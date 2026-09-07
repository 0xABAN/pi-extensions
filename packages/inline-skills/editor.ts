import type { EditorComponent } from "@earendil-works/pi-tui";

type InlineEditor = EditorComponent & {
  getLines(): string[];
  getCursor(): { line: number; col: number };
  isShowingAutocomplete(): boolean;
  tryTriggerAutocomplete(): void;
};

export function enableInlineTrigger(
  component: EditorComponent,
  getPrefix: (lines: string[], line: number, col: number) => string | undefined,
): void {
  // Pi 0.84.2 ignores '/' in provider triggerCharacters. Keep its private trigger
  // dependency here so a future public API can replace it without changing skill logic.
  const editor = component as InlineEditor;
  for (const method of ["getLines", "getCursor", "isShowingAutocomplete", "tryTriggerAutocomplete"] as const) {
    if (typeof editor[method] !== "function") {
      throw new Error(`Inline skills requires a Pi-compatible editor with ${method} (tested on Pi 0.84.2).`);
    }
  }
  const handleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data) => {
    const before = editor.getText();
    handleInput(data);
    if (before === editor.getText() || editor.isShowingAutocomplete()) return;
    const { line, col } = editor.getCursor();
    if (getPrefix(editor.getLines(), line, col) !== undefined) {
      editor.tryTriggerAutocomplete();
    }
  };
}
