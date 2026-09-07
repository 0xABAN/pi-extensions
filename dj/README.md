# DJ

Spotify now playing for Pi. Pastel rainbow colors by default; no Python, daemon, or Claude Code/OpenCode integration.

```text
♪ Artist — Track title  1:24 / 3:42
```

## Install

From a local checkout:

```sh
cd ~/dev/pi-extensions
bun install --ignore-scripts
pi install ./dj
```

Run `/reload` in Pi. Install DJ individually **or** through the collection, not both. Node/Pi runs the extension; Bun is only used to install dependencies and develop it.

## Commands

| Command | Action |
| --- | --- |
| `/dj` | Toggle the widget for this session |
| `/dj minimal` | Track title |
| `/dj medium` | Artist and title |
| `/dj full` | Artist, title, elapsed/total time (default) |
| `/dj layout` | Choose a layout with examples |
| `/dj placement` | Toggle above/below the editor |
| `/dj placement above\|below\|toggle` | Set or toggle placement |
| `/dj theme` | Choose Animated or Solid, then colors |
| `/dj auth` | Connect or reconnect Spotify |

Preferences are saved; changing one doesn't enable a disabled widget. Default placement is below the editor. DJ owns only its own widget: it does not replace powerline's rows or register global shortcuts. Pi controls ordering among neighboring widgets. With the [configs powerline compatibility patch](https://github.com/0xABAN/configs/blob/main/pi/agent/patches/powerline-dj.py), below-editor rows stay **powerline → DJ → last prompt**, including after either extension is toggled. Above-editor placement remains independent.

### Themes

`/dj theme` starts with **Animated** and **Solid**. The next picker offers presets and **Custom…**, with color swatches and a sample preview. Highlighting previews without saving. Enter on a final choice saves; Escape goes back, and canceling restores the previous theme.

Custom animated palettes accept two or more space-separated hex colors:

```text
#fff0f2 #effdf3 #f6efff
```

Solid accepts one color. Both accept `#RGB` and `#RRGGBB`; invalid input stays editable. Your last custom colors are remembered. Theme selection works even when Spotify is paused or DJ is disabled.

## Spotify setup

Existing Agent DJ credentials and placement are imported once when available, without changing the originals. Invalid or expired authorization may require `/dj auth`.

For a fresh installation:

1. Create a Spotify application in the [Developer Dashboard](https://developer.spotify.com/dashboard).
2. Register `http://127.0.0.1/callback` as its redirect URI (no port).
3. Run `/dj auth`, enter the Client ID, and approve in your browser. If automatic browser opening fails, use the displayed URL.

DJ uses PKCE and the read-only `user-read-playback-state` scope. No client secret is required. `SPOTIFY_CLIENT_ID` overrides the saved Client ID. Escape cancels authorization; it also times out after three minutes.

## Runtime and privacy

- All layouts poll for track changes and pause/resume. A shared five-second cache coordinates simultaneous local Pi sessions.
- Full interpolates elapsed time locally; the counter and pastel animation require no additional API requests.
- Idle, paused, offline, and authentication-required states are distinct. Temporary failures do not pretend Spotify is paused.
- Disabling or unloading DJ stops its timers and pending requests. Print/RPC mode does not start the widget or polling.
- Settings, credentials, and cache live in `~/.pi/agent/dj/` (or under `PI_CODING_AGENT_DIR`). Credentials stay out of the repository, Pi's model credentials, and model/chat context.

Don't use the legacy Agent DJ installer to enable Pi again: it can recreate `~/.pi/agent/extensions/agent-dj.ts`, resulting in duplicate `/dj` registration. Existing Claude Code/OpenCode installations are otherwise unaffected.

## Powerline coordination

The optional patch uses Pi's shared event bus, not private UI internals:

- After mounting below the editor, DJ emits `dj:mounted`; powerline re-appends its own last-prompt widget.
- After rebuilding its rows, powerline emits `powerline:widgets-installed`; an already-mounted, below-editor DJ remounts and emits `dj:mounted` again.

Appending the prompt does not emit a rebuild event, avoiding recursion. Disabled extensions ignore requests. Without the patch/listeners, DJ runs normally with Pi's insertion ordering. Reapply the patch after updating powerline, then `/reload`.

## Development

From the repository root:

```sh
bun test ./dj
bun run typecheck
```

Tests use temporary files and mock Spotify responses; they do not access your account. Live authorization and playback need a separate manual smoke check.

The Spotify behavior and legacy migration are based on [Agent DJ](https://github.com/AdamPSU/agent-dj). DJ is distributed under the Apache-2.0 license; see [LICENSE](LICENSE).
