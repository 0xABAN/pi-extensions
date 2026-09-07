# dj

Spotify now playing for [Pi](https://github.com/earendil-works/pi), with pastel colors and live previews.

![DJ demo](assets/demo.gif)
*Spotify while you work.*

- `/dj`: toggle
- `/dj layout`: pick a layout, or use `/dj minimal|medium|full`
- `/dj theme`: animated palettes, solid colors, custom hex
- `/dj placement above|below`: move around the editor
- `/dj auth`: connect Spotify

<table>
  <tr>
    <td colspan="2"><img src="assets/full.png" width="800" alt="Full layout showing a paused Radiohead track and elapsed time"/><br/><em>Full layout, paused.</em></td>
  </tr>
  <tr>
    <td><img src="assets/minimal.png" width="400" alt="Minimal layout showing only the track title below the editor"/><br/><em>Minimal: title only.</em></td>
    <td><img src="assets/above.png" width="400" alt="Spotify artist, title, and elapsed time above the editor"/><br/><em>Above the editor.</em></td>
  </tr>
</table>

## Install

```sh
git clone https://github.com/0xABAN/pi-extensions.git
cd pi-extensions && bun install --ignore-scripts
pi install ./dj
```

Install DJ individually or through the collection, not both. Run `/reload`.

Create a [Spotify app](https://developer.spotify.com/dashboard) with redirect URI `http://127.0.0.1/callback` (no port). Run `/dj auth` and enter its Client ID. No client secret needed; DJ requests read-only playback access.

Defaults: full layout, below the editor, pastel rainbow. Pickers preview live; enter saves, esc goes back. Custom colors accept `#RGB` or `#RRGGBB`: one for solid, two or more for animated.

DJ stores preferences and credentials in `~/.pi/agent/dj/` and imports legacy Agent DJ credentials once. Use `/dj auth` to reconnect, not the legacy installer.

For **powerline → DJ → last prompt** ordering, apply the optional [powerline patch](https://github.com/0xABAN/configs/blob/main/pi/agent/patches/powerline-dj.py). Reapply after powerline updates, then `/reload`.

Development: `bun test ./dj` and `bun run typecheck` from the repository root.

Based on [Agent DJ](https://github.com/AdamPSU/agent-dj) · [Apache-2.0](LICENSE)
