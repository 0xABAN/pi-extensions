# Inline skills

Complete and apply Pi skills anywhere in a prompt.


## Install

```sh
pi install ~/dev/pi-extensions/inline-skills
```

Run `/reload` in Pi after installation or source changes. Local installs load directly from this checkout.

[configs](https://github.com/0xABAN/configs) references this checkout in its Pi settings; its installer clones it to `~/dev/pi-extensions` when missing. Extension code lives here only. Edit it here, then `/reload`—there is no second copy to synchronize. On another machine, pull both repositories before reloading Pi.

## Inline skills

Type `/` after whitespace in your prompt to see skill suggestions. Filter with `/sim` or `/skill:sim`, then select a suggestion with Tab or Enter.

```text
Review this diff using /skill:simplify
Prepare a PR using /skill:simplify and /skill:writing-pull-requests
```

Only installed skills are suggested inline. Selected skills are loaded once per submitted prompt, with their reference directories, ahead of the complete original prompt. The extension does not run skill scripts itself.

- Pi's leading command menu and single leading skill invocation remain unchanged.
- Multiple references and multiline prompts work, including ordinary streaming queues. Editing and resubmitting expanded queue text does not load the same skill again.
- Pi 0.84.2 can bypass input hooks for messages buffered during compaction. Wait for compaction to finish before submitting inline skills.
- References must be standalone whitespace-delimited `/skill:name` tokens. Unknown names, paths, URLs, escaped references, and backtick/tilde literals remain unchanged.
- Literal detection is lightweight, not a complete Markdown parser.
- RPC and extension-generated messages are not expanded by this extension.
- If a skill cannot be read, submission is stopped with an error. The prompt is restored if the editor is empty.

### Compatibility

Tested against **Pi 0.84.2**. That version excludes `/` from custom autocomplete trigger characters. `editor.ts` wraps the existing editor's input handler and calls its private `tryTriggerAutocomplete()` method. The rest uses public extension APIs. A Pi update or a custom editor without the required methods may need an adapter update; unsupported editors report an error rather than being silently replaced.

## Development

Run these from the repository root:

```sh
bun install --ignore-scripts
bun test ./inline-skills
bun run typecheck
```

Tests cover completion, skill expansion, input handling, and the real Pi editor. No build step is required: Pi loads TypeScript directly.
