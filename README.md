# pi-extensions

Personal extensions for the [Pi fork](https://github.com/0xABAN/pi). Most rely on fork-only APIs, so they need the fork rather than stock Pi.

| Extension | What it does |
| --- | --- |
| [ask-user-question](ask-user-question/) | The model asks up to four multiple-choice questions in a dialog under the transcript |
| [cd](cd/) | `/cd` moves the session to another directory |
| [claude-bridge](claude-bridge/) | Claude models through Claude Code and your Claude subscription |
| [dj](dj/) | Spotify now playing, with pastel themes and layouts |
| [intercom](intercom/) | Messages, asks and handovers between Pi sessions on this machine |
| [modes](modes/) | Build, Plan and Learn modes on shift+tab |
| [reply](reply/) | `/reply` quotes an earlier message into the editor |
| [stash](stash/) | ctrl+s stashes the editor text and brings it back |
| [todo](todo/) | A task list the model keeps, shown above the editor |
| [whimsical](whimsical/) | A sparkle animation for the working line |

## Install

```sh
pi install git:github.com/0xABAN/pi-extensions
```

Use `pi config` to pick extensions, then `/reload`.

## Development

The fork must be checked out at `../pi`. Type checks, tests and Biome all use its source and tools.

```sh
bun install
bun run check
bun test
```
