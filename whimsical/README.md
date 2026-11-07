# Whimsical

Replace Pi's working indicator with a colorful sparkle animation and a random message, shown just above the editor and below the rpiv-todo list. Compaction gets the same animation.

## Install

```sh
pi install ~/dev/pi-extensions/whimsical
```

Run `/reload` in Pi after installation or source changes.

## Compatibility

Pi's compaction loader ignores custom working indicators. `compaction_loader.ts` patches `Loader.prototype.setIndicator` once per process to animate the compacting message. Keep that patch out of `catalog.ts` and `animation.ts`, and remove it when Pi exposes compaction indicator options.
