# Response time

Show how long the latest agent response took in the `agent-response-time` status. The timer counts every second while the agent works, including tool calls and queued continuations. Failed and cancelled responses keep the previous duration.

## Install

```sh
pi install ~/dev/pi-extensions/response-time
```

Run `/reload` in Pi after installation or source changes.
