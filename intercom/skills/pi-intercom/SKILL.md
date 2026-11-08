---
name: pi-intercom
description: |
  Coordinate with other pi sessions on the same machine through the intercom
  tool: list peers, send updates, ask and wait for answers, reply to asks, and
  hand a session over. Use for planner-worker workflows, context handoffs and
  cross-session collaboration.
---

# Pi Intercom

The `intercom` tool connects pi sessions on this machine through a local broker.
Messages arrive in the receiving session as a new turn when it is idle, or as a
steering message when it is working.

## Find a peer

```typescript
intercom({ action: "list" })
intercom({ action: "list-cwd" })
intercom({ action: "list-cwd", cwd: "/path/to/repo" })
```

`list` shows each session's name, short id, cwd, model, context use and live
status (`idle`, `thinking`, `tool:<name>`). For Herdr-hosted sessions it also
shows the current workspace, tab and pane. Address sessions by name or by the
short id in parentheses, never by pane id. Sessions are named with `/name`;
unnamed sessions appear as `session-<id>`.

## Send, ask, reply

| Action | Behavior | Use when |
|--------|----------|----------|
| `send` | Returns after delivery; queues in the broker mailbox if the peer recently disconnected | You don't need an answer |
| `ask` | Blocks until the peer replies (10 minutes at most); the peer must be connected | You need the answer to continue |
| `reply` | Answers the ask that started this turn, or the only pending ask | Someone asked you something |
| `pending` | Lists unanswered inbound asks | Several peers are waiting on you |

```typescript
intercom({ action: "send", to: "worker", message: "Task 3: add retry logic to src/api/client.ts." })
intercom({ action: "ask", to: "planner", message: "Exponential backoff or fixed intervals?" })
intercom({ action: "reply", message: "Exponential, starting at 100ms." })
intercom({ action: "reply", to: "planner", message: "..." })
```

Incoming asks include the exact `reply` call to use. A `send` to a peer who has
exactly one unanswered ask waiting on you is threaded as the reply to it.

Share code or files with `attachments`:

```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Here's the fix:",
  attachments: [{ type: "snippet", name: "auth.ts", language: "typescript", content: "..." }],
})
```

`cancel` with a `messageId` asks the broker to withdraw a sent message;
`supersedes` and `retryOf` link a new message to an earlier one.

## Other projects

Use `to` alone for any live peer. Use `cwd` alone when exactly one peer should
be in that repo, or `to` plus `cwd` to guard against the wrong directory.

```typescript
intercom({ action: "ask", cwd: "/path/to/other-repo", message: "Which module owns source slices?" })
```

Only when you need a lasting, visible peer in a repo with no session, open a
Herdr project pane:

```typescript
intercom({ action: "send", cwd: "/path/to/other-repo", openProjectPaneIfMissing: true, message: "..." })
```

If Herdr is unavailable, ask the user instead of opening a terminal yourself.

## Hand over a session

`handover` summarizes this session with the current model (next task,
decisions, files, current state, open questions) and sends it. The receiver acts
on it. `message` is the optional next task; targeting works like `send`.

```typescript
intercom({ action: "handover", cwd: "/path/to/repo", openProjectPaneIfMissing: true, message: "Port the schema fix and run the adapter tests" })
```

Users can run `/handover [target] [next task]` to review the summary first.

## Errors

- **Already waiting for a reply**: only one `ask` runs at a time. Use `send`, or wait.
- **Cannot message the current session**: the target resolved to you. Run `list`.
- **No connected session matches**: check `list`; the error suggests the nearest name.
- **Ask timed out**: the message may still be queued in the peer. For long work, `send` the task and `ask` at milestones.
- **Not connected**: `status` shows the connection; sessions reconnect on their own after a broker restart.
