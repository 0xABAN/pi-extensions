# modes

Build, Plan and Learn modes for Pi.

- shift+tab cycles Build → Plan → Learn; wait for the turn to end or cancel it first
- `--plan` or `--learn` picks the starting mode
- the mode badge sits in the editor and the thinking level in the footer

The mode follows the session branch and survives `/reload` and resume. Returning to Build restores the tools that were active before.

## Plan and Learn

Both are read-only: `read`, `grep`, `find`, `ls`, `codemode`, the web tools, `ask_user_question`, `intercom`, and `bash` limited to an allowlist of read-only commands. Every other tool call is blocked, including calls from inside codemode. Commands are split at `;`, `&`, `|` and newlines, command substitution and output redirection (apart from `2>/dev/null` and `2>&1`) are refused, and the allowlist is not a sandbox: `find -exec` or `sort -o` can still write.

**Plan** answers questions normally. When it proposes a change, it writes the plan (context, numbered steps naming files and functions, verification) and asks for approval through the `plan` tool. Approve switches to Build and starts the work in the same turn. Revise, or esc, stays in Plan for your feedback.

**Learn** teaches instead of doing the task. It tracks your goal and what you've shown you understand, and asks at most one question that moves the task forward. It gives hints and concept explanations, but never answers, finished code or exact fixes. It links primary docs after fetching them, and stops once you've shown a correct solution. The tool limits are enforced in code. The teaching relies on the model following its instructions.

Each mode's rules are a system prompt section (`plan_mode`, `learn_mode`), and a short note after each of your messages points the model back to them.
