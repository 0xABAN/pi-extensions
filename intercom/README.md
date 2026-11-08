# intercom

Messaging between [Pi](https://github.com/earendil-works/pi) sessions on the same machine.

- `alt+m` or `/intercom`: pick a session, then message it or hand over to it
- `/handover [target or path] [next task]`: summarize this session, edit the summary, send it
- `intercom` tool: `list`, `list-cwd`, `send`, `ask`, `reply`, `pending`, `handover`, `cancel`, `status`

Each session registers with a small broker on a Unix socket in `~/.pi/agent/intercom/`. The first session starts the broker; it exits once no sessions are connected and its mailbox is empty. Incoming messages start a turn in an idle session and steer a working one. `ask` waits up to 10 minutes for a reply. Mail for a session that just disconnected waits in the broker until it reconnects.

Sessions are addressed by `/name` or by the short id that `list` shows. Under Herdr, `list` shows each session's workspace, tab and pane, and `openProjectPaneIfMissing` starts Pi in a new pane for a project with no session.

The broker writes its errors to `broker.log` next to the socket.

Based on [pi-intercom](https://github.com/nicobailon/pi-intercom) · [MIT](LICENSE)
