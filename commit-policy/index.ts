import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const POLICY = `Git commit policy:
- During coding tasks, commit changes autonomously; do not wait for the user to ask.
- Commit each self-contained, independently revertible change after its relevant checks pass. Keep directly related tests in the same commit and separate unrelated refactors or formatting.
- Before editing, inspect \`git status --short\`. Treat existing changes as user-owned.
- Stage only explicit task-owned paths or hunks; never use \`git add .\`, \`git add -A\`, or \`git commit -a\`.
- Before committing, inspect \`git status --short\`, \`git diff --cached --stat\`, and \`git diff --cached\`. Abort if the staged diff contains unrelated changes.
- Use Angular commit format: \`<type>(<optional scope>): <summary>\`.
- Allowed types: build, chore, ci, docs, feat, fix, perf, refactor, test. Use \`revert\` only when reverting a commit.
- Use an optional stable project area or package name for scope.
- Write the summary in lowercase, imperative, present tense; keep it concise (about 50 characters) and omit the final period.
- Except for docs commits, add a body of at least 20 characters after a blank line. Explain the motivation and relevant behavior change, wrapping around 72 characters.
- Use the footer for breaking changes, deprecations, and issue references.
Good examples:
1.
  feat(auth): add passkey sign-in

  support passwordless access without replacing existing login methods
2.
  fix(router): preserve query params on redirect

  retain the original query string when redirects resolve nested routes
3.
  docs: explain autonomous commit boundaries
- Never commit incomplete work or known failures. Never push, amend, rebase, reset, stash, or bypass hooks unless explicitly requested.`;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const alreadyLoaded = ctx.sessionManager.buildContextEntries().some(
			(entry) => entry.type === "custom_message" && entry.customType === "commit-policy",
		);
		if (alreadyLoaded) return;

		pi.sendMessage({ customType: "commit-policy", content: POLICY, display: false });
	});
}
