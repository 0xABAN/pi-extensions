# rewind

Takes a git checkpoint of the working tree each turn, so `/tree` can restore files and conversation to any earlier point. Rewind metadata lives in the session as hidden entries, so it survives resume, fork and tree navigation.

Settings in `~/.pi/agent/settings.json`:

- `rewind.silentCheckpoints` hides the footer status and checkpoint notifications.
- `rewind.retention` prunes old snapshots; see the settings in `index.ts`.

Adapted from [pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook) by nicobailon (MIT). The fork keeps the upstream behavior and fixes one bug: a settings file that failed to read was cached as empty for the rest of the process, so `silentCheckpoints` stopped working until restart.
