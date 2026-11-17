# Private changes, shared changes, and not clashing

## The two kinds of change

| | Private | Shared |
| --- | --- | --- |
| Who gets it | Only you, in your own build (core + your layer) | Everyone: it goes into core |
| Where it lives | Your layer, next to your core clone (`layers-and-versions.md`) | A branch `<release name>/<topic>` and a pull request into RedbyPS/ps-app `main` |
| Needs an on/off switch in Settings | Recommended | Required: a `features.json` entry, a visible switch in "From the squad", a `FEATURES.md` line |
| Default | Your choice | Your choice in `features.json`; in everyone else's own build it stays off until they switch it on |
| Rules (SKILL.md) | All still apply on your machine: tests, no secrets, Esc, 1Password and Signal | All, plus the audits and the guard before pushing, and every check on GitHub |
| Release | A private claim, then your own build (`layers-and-versions.md`) | The pull request merges by itself; the G Squad build follows a shared claim, made on GitHub |

If the person has not said which, ask in one short question before starting. A private change can become shared
later: it moves from the layer into core on a branch, with its switch, its `features.json` entry, its `FEATURES.md`
line and the audits.

## How it works since V1.58

Be honest with the person about all of this:

- **Core is the real shared source.** What merges into `main` of RedbyPS/ps-app is what everyone builds from,
  the owner included (his own changes to core come through pull requests too, from `red/` branches).
- **No human approval.** A pull request from a `<release name>/<topic>` branch of RedbyPS/ps-app turns on auto
  merge by itself and merges (squashed) the moment every required check passes. Pull requests from forks never
  merge by themselves: the owner looks at those.
- **"Up to date" is required.** After every merge, GitHub merges `main` into every waiting pull request so the
  checks always run on the combined code.
- **Waiting on the owner's GitHub step.** The checks, auto merge, the branch updates and the G Squad release
  workflow are written but go live only once the owner has finished setting up GitHub (the PS bot app, the rules,
  write access for friends). Check with `gh api repos/RedbyPS/ps-app/contents/.github/workflows`: if it finds
  nothing, none of it runs yet, the owner merges by hand, and a merged change reaches friends' apps with the
  owner's next release. Say so; never claim a pull request "will merge by itself" before that.
- **Never edit** `web/ps-version.json`, `web/ps-notes.json` or `web/ps-public-approvals.json` in a pull request.

### The checks on every pull request

| Check | What it does |
| --- | --- |
| web | the G Squad build's web check (`node tools/build.mjs gsquad web --check`) and the example layer |
| mac | the Swift type check of the G Squad build, on a Mac runner |
| phone | the phone unit tests in the assembled tree |
| protected files | refuses changes to the checks and the release files unless they come from the owner's `red/` branches |
| term audit | the owner's private word list against the files, the added lines, the commit messages, and the pull request's title and text |
| source audit | personal paths, key and env files, long dashes, plug points still doing nothing, the feature registry, `mac/release/audit.py --source`, gitleaks (files and commits) |

Run what you can before pushing, so nothing fails on GitHub: `node tools/build.mjs gsquad all --check --tests`, the
three audits in `build-and-test.md`, and the guard (it runs by itself on `git push`).

### One time setup

With write access (`gh repo view RedbyPS/ps-app --json viewerPermission --jq .viewerPermission` says `WRITE` or
higher):

```bash
gh repo clone RedbyPS/ps-app ps && cd ps
git remote -v                            # origin = RedbyPS/ps-app
node tools/guard.mjs --install --layer ../ps-<release name>-layer/layer.json
```

Without write access yet (ask the owner for it):

```bash
gh repo fork RedbyPS/ps-app --clone      # your fork, cloned, with "upstream" pointing at RedbyPS/ps-app
cd ps-app && node tools/guard.mjs --install --layer ../ps-<release name>-layer/layer.json
```

(`gh repo fork` asks before it creates anything on GitHub: show the person the command and let them say yes.) In a
fork, read `upstream` wherever the steps below say `origin` for fetching `main`.

### Every change

```bash
git fetch origin
git switch main && git merge --ff-only origin/main
git switch -c <release name>/<short-topic>                                       # one branch per change
# ... make the change, with its tests, its switch and its features.json entry ...
cd web && npx tsc --noEmit -p . && cd ..
# run the touched tests, the Swift type check if Swift changed, then the three audits (build-and-test.md)
node tools/build.mjs gsquad all --check --tests
git add <only the files you meant to change>
git commit -m "Short plain sentence of what changed"
```

Branch names are `<release name>/<topic>` (lowercase release name, a slash, then the topic): that exact shape is
what turns auto merge on, and it keeps two people's branches apart. Never commit to `main`, never use a `red/`
branch. Several pieces of one change, each with its own worker, get one branch each (`workers-and-releases.md`).
Commit messages and code comments follow the same rules as the app: plain words, no em or en dashes, nothing
private (the term audit reads commit messages too).

### Offering a shared change

1. Update from main again right before submitting (`git fetch origin && git rebase origin/main`, then rerun tsc,
   the touched tests and `node tools/build.mjs gsquad all --check --tests`).
2. Draft the pull request title and text with the template below and **show the person the exact text and the
   list of files**. The repo is public: everything in it is read by everyone, forever.
3. Only on their yes to that text: `git push -u origin <branch>` (the guard runs first) and
   `gh pr create --repo RedbyPS/ps-app --base main --title "..." --body-file <file>`.
4. Watch the checks (`gh pr checks <number> --repo RedbyPS/ps-app`). A failed check: fix it on the same branch and
   push again (with the person's yes). Do not open a second pull request for the same change.
5. Answer comments the same way: draft, show, wait for yes, then post.
6. After it merges: the shared release (`layers-and-versions.md`), only once the owner has switched G Squad builds
   on.

Pull request template:

```markdown
## What it does
One or two plain sentences a non programmer understands.

## Shared feature
Id: <features.json id>. Switch: Settings, G Squad, "From the squad" (and <any other place>). Default: <on/off>.

## Suggested What's new line
<one line, or "none">

## Tested
- npx tsc --noEmit -p . : clean
- node tools/build.mjs gsquad all --check --tests : <clean, or which tests already fail on main>
- web tests: <files> pass
- Mac: <Swift type check / tests run / not touched>
- Phone: <tests run / not touched>
- Audits: gitleaks clean, audit.py --source BLOCK nothing, term check clean
- Not tried: <be honest, for example "not tried on a real screen", "not tried over real 1Password and Signal">

## Files
<the list>
```

## When changes clash

Most clashes are avoided before they start:

- **Small changes.** One feature or fix per branch and per pull request. Big work is split into steps that each
  build and pass tests on their own.
- **Stay in your area.** Prefer new files (a new `web/src/core/<feature>.ts`, a new test file, a new Swift file)
  over editing shared hot spots. The busiest shared files are `web/src/ps.ts`, `web/src/App.tsx`,
  `web/src/views/TaskMap.tsx`, `web/src/core/model.ts`, `web/src/core/actions.ts`, `mac/Sources/main.swift`,
  `features.json` and `FEATURES.md`. When you must touch one, keep the edit short and in one place.
- **Update from main before you start and again before you submit.**
- **Look before you build.** `gh pr list --repo RedbyPS/ps-app` shows what others have open. If someone is on the
  same area, tell the person and suggest they talk to that contributor before both build the same thing.

What happens when they do clash:

- **The same lines changed**: the pull request cannot merge. Its author (you, with your AI) rebases on `main`,
  fixes, pushes; the checks run again. Nobody else is blocked.
- **Both merge but break together**: caught by the "up to date" rule before the second one merges; its checks fail
  on the combined code and it waits for a fix.
- **Core breaks someone's layer** (a plug point gains an export, a pinned file moved): core merges anyway; that
  person's next build stops with the file name and they fix their layer.
- **The same version number**: cannot happen; the second claim simply gets the next number.
- **The same feature id**: the registry check refuses the second one. Pick another id.

When git reports a conflict (during `git rebase origin/main` or a merge):

1. Stop and tell the person in plain words which files clash and why (usually: someone else's change to the same
   lines merged first).
2. Read both sides. Keep the other person's change working; rework yours on top of it. Never resolve a clash by
   deleting someone else's work, and never take "ours" or "theirs" for a whole file without reading it.
3. Rerun tsc, the tests of both changes' areas, `node tools/build.mjs gsquad all --check --tests` and the audits.
4. If the two changes cannot both work (they want opposite behaviour), do not pick a winner: say so in the pull
   request text, turn auto merge off for it (`gh pr merge --disable-auto <number> --repo RedbyPS/ps-app`, with the
   person's yes) and let the owner decide.
5. Never force push to anyone else's branch. Force pushing your own branch after a rebase is fine
   (`git push --force-with-lease`), with the person's yes.

Settings, switches and stored data deserve extra care: two features must never use the same settings field, the
same record kind, the same feature id or the same bridge message name. Search for your new names first
(`grep -rn "<name>" web/src mac/Sources phone/app/src features.json`).
