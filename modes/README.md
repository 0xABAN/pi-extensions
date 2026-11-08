# Modes

Build, Plan, and Learn share one controller for the mode shortcut, tool permissions,
and status badge.

## Controls

- `Shift+Tab`: Build → Plan → Learn → Build.
- `--plan` or `--learn`: choose a startup mode, overriding saved state.
  Learn wins if both flags are set.

Wait for the current turn to finish, or cancel it, before switching modes.
The mode follows the active session branch and survives `/reload` and resume.
Returning to Build restores the tools active before entering Plan or Learn.
Use Pi's `/thinking` command to select the thinking level.

## Read-only tools

Plan and Learn share one tool set: `read`, `grep`, `find`, `ls`, `bash` through
the allowlist, `codemode`, `web_search`, `fetch_content`, `get_search_content`,
`ask_user_question`, and `intercom`. The tool-call guard blocks every other tool,
including inactive ones and calls made from inside codemode. Web tools only read
remote content, though they may cache pages or clone repositories outside the
project. `intercom` can still message other sessions.

Bash commands are split at `;`, `&`, `|` and newlines outside quotes, and every
part must start with an allowlisted read-only command such as `cd`, `grep`, or
`git log`. Command substitution and output redirection are blocked, except
`2>/dev/null` and `2>&1`. Some allowlisted commands can still run programs or
write files through their own options, such as `find -exec`, `env`, or `sort -o`,
so the guard is not a sandbox.

## Learn

The agent helps you reason through a task without doing it for you. It tracks
your goal, demonstrated understanding, and the nearest unresolved step. Questions
and exercises must require new reasoning that advances that task; it should not
ask about obvious facts, repeat answered questions, or quiz you on what it just
explained. Missing prerequisites are explained without starting an unrelated
lesson.

Replies contain at most one question or exercise, not a mandatory question.
Feedback or a concept explanation can stand alone. When you are stuck, it offers
a clearer hint or a smaller unresolved subproblem. Once you have demonstrated a
correct solution and its reasoning, it acknowledges completion instead of
inventing more exercises.

The teaching policy prohibits task answers, completed code, exact fixes, and
solutions disguised as pseudocode or prose. You can ask for a concept explanation
or a stronger hint; asking for the answer does not disable the policy.

For documentation-heavy topics, such as Node.js sockets, the agent teaches from
primary docs. It fetches a page before linking it, then tells you where to look:
the heading, the passage that addresses your current gap, and what to skip.

Learn uses the read-only tools. The agent may run read-only commands but not
programs; you write the code and run experiments yourself. Existing source files
and tool results remain visible; Learn does not redact them.

The teaching policy is the `learn_mode` system prompt section. A short hidden
note after each of your messages points the model back to those rules, so a
session started in Build or Plan does not drift from them.

Tool restrictions are enforced in code. Teaching behavior relies on the model
following its instructions, so this is not a guarantee against answer leakage.

### Appearance

All mode icons share the same neutral color. Learn keeps its graduation-cap icon.
Everforest Hard and Medium use a foreground → muted teal → yellow gradient
(`#D3C6AA` → `#7FBBB3` → `#DBBC7F`) for Learn's mode and thinking badges. Build
keeps its green accent and Plan its purple. Pi's built-in themes use warm peach.

### Inspiration

[CodeHelp](https://github.com/liffiton/gen-ed) informed the concepts-and-hints
boundary. Its [classroom evaluation](https://arxiv.org/html/2308.06921) reports
positive student feedback, not a controlled improvement in learning outcomes.
Our teaching instructions are original; we do not copy its implementation or add
its response-rewriting pipeline.

## Plan

Plan uses the read-only tools plus `plan`. Its rules are the `plan_mode` system
prompt section: change nothing, answer questions normally, and when proposing a
change, write the plan as the reply and request approval through `plan` instead
of asking in text. A plan has a short Context, numbered Steps naming the files
and functions they change, and a Verification section, and recommends one
approach. A short hidden note after each of your messages points back to those
rules.

The `plan` tool replaces the prompt with two choices:

- Approve switches to Build. The agent starts implementing in the same turn,
  creating one todo per step first.
- Revise, or Esc, ends the turn and stays in Plan. Type your feedback at the
  prompt.

Pi keeps a turn's system prompt until the turn ends, so after Approve the
`plan_mode` section stays for the rest of that turn. The tool's reply tells the
model those rules no longer apply.

## Prompt sections and notes

Each mode drops the other modes' notes from context, and Build keeps none. Prompt
sections reach Claude through pi-claude-bridge 0.11.0 or later; 0.9.1 drops them,
so only the notes arrive.

## Structure

- `index.ts`: the controller. It owns the shortcut and flags, the tool guard, each
  mode's prompt section and note, status publication, and persistence.
- `plan.ts`: Plan's rules and the `plan` tool.
- `learn.ts`: the teaching policy.
- `utils.ts`: the read-only tool set and the Bash allowlist.
- `status.ts`: pure status badge formatting.
- `tests/modes.test.ts`: the checks below.

## Checks

From the repository root:

```sh
bun test modes
```

The tests cover mode transitions, direct and nested tool guards, the Bash
allowlist, each mode's prompt section and note, the `plan` tool's Approve and
Revise, context filtering, session state, and distinct Learn colors. They do not
call a model. After `/reload`, check the visible badge.

In Plan, ask a question about the code: expect an answer and no approval prompt.
Then ask for a change: expect a plan with Context, Steps, and Verification,
followed by Approve and Revise.

In Learn, try these teaching cases:

- Ask for a complete solution: expect useful guidance, not code or a recipe.
- State that you already know `return` exits a function, but have not traced why
  your loop stops early: expect a question about the unresolved execution path,
  not another question about what `return` does.
- Ask what a precondition means: expect an explanation, not a question asking
  you to repeat the definition it just gave.
- Ask how a Node.js socket learns that its peer finished sending: expect a
  fetched nodejs.org link with the heading to read, not a summary that answers
  your task.
- Supply a correct running-sum invariant covering initialization, each iteration,
  termination, and empty input: expect confirmation without another exercise.

Review whether each question advances an unresolved part of the stated task.
These are behavioral smoke checks, not a guarantee of model compliance.
