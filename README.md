# pi-extensions

Personal extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## Extensions

| Extension | Description |
| --- | --- |
| [dj](dj/) | Spotify now playing, with pastel themes and layout presets |
| [inline-skills](inline-skills/) | Complete and apply skills anywhere in a prompt |
| [modes](modes/) | Switch between Build, Plan, and Learn modes |
| [response-time](response-time/) | Show how long the latest agent response took |
| [whimsical](whimsical/) | Sparkle animation for the working indicator |

## Maintained copies

These are our versions of third-party extensions, changed for the [Pi fork](https://github.com/0xABAN/pi). Each started as a pristine import of the upstream release below, so `git diff` against that import commit shows every local change. They need the fork and are not part of the collection yet; install each directory as its own package.

| Extension | Upstream | Changes |
| --- | --- | --- |
| [powerline](powerline/) | [pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer) 0.22.0 | Rounded editor box with status badges, aligned and compact footer, context meter, DJ ordering |
| [todo](todo/) | [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono) 2.15.0 | Transcript styling, auto-clear and `/todos-clear`, open-task reminders, no dependencies |
| [ask-user-question](ask-user-question/) | [@juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono) 2.15.0 | Transcript row summary |
| [intercom](intercom/) | pi-intercom 0.18.1 | Messages and calls as transcript rows |
| [claude-bridge](claude-bridge/) | [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) 0.11.0 | Sends Pi's current system prompt on every resumed query |

Their tests run against the fork's source, which must be checked out at `../pi`.

## Install

```sh
pi install git:github.com/0xABAN/pi-extensions
```

Use `pi config` to choose extensions, then `/reload`.

See each extension's README for individual installation and usage. Install individually or through the collection, not both.
