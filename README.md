# pi-extensions

Each extension lives in its own top-level folder, with its own manifest, documentation, and tests. The root manifest explicitly lists the collection's entry points, following [tmustier/pi-extensions](https://github.com/tmustier/pi-extensions).

| Extension | Purpose |
| --- | --- |
| [inline-skills](inline-skills/) | Complete and apply skills anywhere in a prompt |
| [dj](dj/) | Spotify now playing, with layout presets and pastel themes |

## Local installation

```sh
git clone https://github.com/0xABAN/pi-extensions.git ~/dev/pi-extensions
cd ~/dev/pi-extensions
bun install --frozen-lockfile --ignore-scripts

# Install just the extensions you want:
pi install ./inline-skills
pi install ./dj
```

Alternatively, install the collection with `pi install ~/dev/pi-extensions`. Use individual packages **or** the collection, not both. Helpers and tests aren't extension entry points.

Run `/reload` in Pi after installation or source changes. Local installations load this checkout directly; nothing is copied into Pi's extension directory.

## Git installation

```sh
pi install https://github.com/0xABAN/pi-extensions
```

Pi installs dependencies automatically for Git packages. Use `pi config` to choose which extensions to enable.

## Relationship to configs

[configs](https://github.com/0xABAN/configs) references the individual packages in `~/dev/pi-extensions`. Its installer provisions that checkout and its dependencies without pulling over local work.

Extension code lives here only. On another machine, pull both repositories, rerun the configs installer when dependencies or paths change, then `/reload`. Push extension changes before configs changes that reference new paths.

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
bun test
bun run typecheck
```

No build step or shared extension framework. Keep implementation helpers inside the package that owns them. Pi loads TypeScript directly.
