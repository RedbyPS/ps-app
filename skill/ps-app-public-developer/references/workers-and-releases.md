# Working with several workers, and the three release choices

## The manager and the workers

To develop faster, the chat the person talks to is the **manager**. It does not write the feature code itself. It:

1. splits the ask into independent pieces;
2. gives each piece its own **worker** (a sub chat, subagent or parallel agent) in its own branch and its own git
   worktree, never two workers on the same files;
3. merges the workers' branches, one at a time;
4. runs the checks on the merged result;
5. offers the three release choices (below) and does the release step the person picks.

### Splitting

A piece is independent when it does not need another piece's result, touches different files, and can be tested
on its own. Good splits: one piece per area (web logic and its tests, the Mac shell, the phone shell, docs), or
one per feature. Bad splits: two pieces that both edit `web/src/ps.ts` or `mac/Sources/main.swift`. Then either
give one worker both, or let one worker finish and merge before the next starts.

Keep it small: 2 to 4 workers is plenty. Every worker uses the person's own AI usage, and parallel work costs more
tokens than one chat doing it in a row. If a piece takes only a few minutes, the manager does it itself.

### Making each worker's place

The manager makes the branches and worktrees itself, so it does not matter whether the AI tool isolates workers
on its own:

```bash
git fetch origin && git switch main && git merge --ff-only origin/main     # upstream instead of origin in a fork
git worktree add ../ps-<release name>-<piece> -b <release name>/<piece>
cd ../ps-<release name>-<piece>/web && npm ci        # each worktree needs its own node_modules
```

A piece that changes the person's layer (a private change) works in the layer folder instead, on its own branch
there if the layer is a git repo. A worker never edits core and the layer in the same piece.

### Briefing a worker

A worker knows only what the brief says. Every brief has:

- **Goal**: one or two plain sentences of what the piece must do, and why.
- **Where**: the worktree folder and branch. "Work only in this folder. Do not touch any other folder or branch."
- **Files**: the files it may change, and the files it must not touch (the other workers' files).
- **Read first**: this skill's `SKILL.md` rules section, and the exact reference files and code files for its area.
- **Done means**: what the person will see working; the on/off switch and its `FEATURES.md` line if it is a shared
  feature; the new or changed tests.
- **Tests to run**: `npx tsc --noEmit -p .`, `node tools/build.mjs gsquad <part> --check` for its part, and the exact test files (`web/tests/<x>.test.ts`, `mac/tests/<x>-test.sh`,
  `./gradlew testDebugUnitTest`). No Mac self test unless the person is away from the Mac. No Swift or Gradle
  build in a worker unless the manager says so (only one heavy build at a time on one machine).
- **Report**: commit on its branch (no push, no merge, no pull request), then reply with the commit, the files
  changed, which tests ran and passed, and what it could not test, in plain words.
- **Rules**: no secrets, no em or en dashes, Esc always exits, the 1Password and Signal rule, nothing from the
  layer into core, no `v*` tags, never send, push or post anything.

### Merging and checking

1. Read each worker's report, then its diff (`git diff main...<release name>/<piece>`). A report is not proof: look.
2. Merge one branch at a time into a manager branch (`<release name>/<topic>`), in the order that makes sense.
   After each merge run `npx tsc --noEmit -p .` and that piece's tests.
3. A clash: follow "When changes clash" in `contributing.md`. Never drop a worker's work to make a merge go
   through; if two pieces truly conflict, ask the person.
4. On the fully merged tree run the checks for the release choice the person picks (below).
5. Remove worktrees that are merged and clean: `git worktree remove ../ps-<release name>-<piece>` (ask first if
   anything in them is uncommitted).

### How to start workers in each tool

| | Claude Code | Codex |
| --- | --- | --- |
| Start workers | Ask for subagents: "Use one subagent per piece, in parallel" (Claude Code's Agent tool). In the Claude desktop app, separate sessions also work. Give each the brief above. | Ask in plain words: "Spawn one agent per piece and wait for all of them" (Codex subagents, on by default; at most 6 at once by default). Give each the brief above. |
| Isolation | Use the worktrees the manager made (Claude Code agents can also run in their own worktree). | Use the worktrees the manager made. Codex subagents share the parent's sandbox and approvals. |
| No parallel workers available | Do the pieces one after another, each in its own branch, the manager acting as each worker in turn, then merge as above. | Same. |

Asking the person a question works the same everywhere: ask it in chat, in one short plain sentence, and wait for
the answer before going on. (Claude Code may also show it as a question card; plain chat is always fine.)

## The three release choices

At the end of every piece of work, always offer the person these three choices, in plain words, and use the one
they pick. Never pick for them.

> **ASAP release**: gets it out first. Only the type check, the build and the security checks run before it goes
> out. All the other tests and checks run straight after, and anything they find is fixed right away.
>
> **Faster release**: the tests for the parts that changed run first. The builds run side by side if the computer
> has the memory for it, otherwise one after another.
>
> **Slower release**: every test runs first, the builds run one after another. The safest, and the slowest.

What runs in each:

| Step | ASAP | Faster | Slower |
| --- | --- | --- | --- |
| Type check (`npx tsc --noEmit -p .`, `node tools/build.mjs <gsquad or your layer.json> all --check`) | before | before | before |
| Tests of the changed parts | after it is out | before | before |
| Every other test (all `web/tests`, the safe `mac/tests`, phone unit tests) | after it is out | after it is out | before |
| The builds (web, then Mac and phone if they changed) | before, one after another | before, side by side if memory allows | before, one after another |
| Security and secret checks (gitleaks, `audit.py --source`, the term check) | **always before** | **always before** | **always before** |
| Mac self test | only if the person is away from the Mac, in any choice | same | same |

The build and the security and secret checks ALWAYS run before anything goes out, in all three. Never skip them,
never shorten them, and stop the release if one fails.

"Side by side if memory allows": run the Mac build and the phone build at the same time only when the computer
has plenty of free memory (on a Mac, `memory_pressure` says "normal" and nothing else heavy is building; as a rule
of thumb not on machines with 16 GB or less). Otherwise run them one after another and say so.

ASAP, honestly: anything the after checks find is fixed straight away with the next release (private) or with more
commits on the same pull request (shared). For a shared change that matters even more: once auto merge is live, a
pull request merges the moment GitHub's own checks pass, so the after checks must be done and fixed before the
shared claim, and the pull request text says which local checks were still running when it was opened.

### What "release" means for a friend

- **A private release** is your own build, core + your layer, on your own machine
  (`layers-and-versions.md`, "A private release"): the checks of the choice you picked, a private claim of the
  next version number (its yes first), `node tools/build.mjs <your layer.json> all` (in Faster, the Mac and phone
  parts can run as two builds side by side if memory allows), install on your own machine on your yes, then put
  `web/ps-version.json` back. Nobody else's app changes. Without write access yet you cannot claim: the build keeps
  `main`'s number and gets a local tag `<release name>-v<version>-<n>` instead.
- **A shared release** is a pull request into RedbyPS/ps-app `main` (`contributing.md`), opened only after the
  person says yes to its exact text. It merges by itself once every check passes. Then a shared claim on `main`
  makes GitHub build, sign and publish the G Squad build, and friends' apps offer "V1.59 by <name>".
- **Not live yet, say so plainly**: auto merge, the GitHub checks and G Squad builds made on GitHub start once the
  owner finishes one GitHub step. Until then the owner merges pull requests by hand, a merged change reaches
  friends with the owner's next release, and nobody makes a shared claim.

In all three choices the order is the same: the checks that run before (the table), the security and secret
checks, the claim, the build with the claimed number, then the install (private) or the pull request (shared).
The type check and `--check` build run before the claim, so a broken build never burns a version number.
