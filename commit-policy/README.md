# Commit policy

Add a git commit policy to each new session as a hidden message. The agent commits finished work in small Angular-style commits and stages only the files it owns.

## Install

```sh
pi install ~/dev/pi-extensions/commit-policy
```

Run `/reload` in Pi after installation or source changes. The policy is sent once per session; resumed sessions that already contain it are left alone.
