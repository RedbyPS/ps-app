# People and their release names

Every run starts by asking the person's name (SKILL.md, Step 0) and looking it up here. The list keeps everyone's
private releases apart, so two people's builds never get mixed up.

| Name | GitHub login (for the quiet check) | Private release name | Role | Added | Notes |
| --- | --- | --- | --- | --- | --- |
| the developer | RedbyPS | red | owner | V1.57 | Owns github.com/RedbyPS/ps-app and its GitHub settings (rules, write access, G Squad builds). Only he pushes `red/` branches. |
| Jan | Qwixo | jan | contributor | V1.57 | GitHub login filled in by the owner on 14 Nov 2026 (V1.60 work). |

## How the check works

- A name on this list counts only when `gh api user --jq .login` prints the login on file for that name (case does
  not matter). No login on file, no `gh`, not signed in, or a different login: the person is not treated as that
  name. Say so plainly and set them up as a new person under a name that is not taken.
- Never change or remove someone else's row. Only the owner fixes rows (for example filling in Jan's login).

## Adding a new person

When someone gives a name that is not on the list:

1. **Name**: the name they gave. If it is already taken (or they failed the check for it), ask for another, or
   suggest their GitHub login.
2. **GitHub login**: what `gh api user --jq .login` prints, if anything. If nothing, write "(not on file yet)" and
   tell them that next time they will be set up as new again unless they sign in with `gh auth login` first.
3. **Private release name**: one short lowercase word, letters and digits only, made from their name (`sam`,
   `sam2` if `sam` is taken). Never reuse one on this list, never `gsquad`, `red` or `example`. It is used for:
   - their profile's `name` and their layer's `name` (`layers-and-versions.md`);
   - their branches: `<release name>/<short topic>` (the shape auto merge looks for);
   - who made a release: `--by <release name>` when they claim a version, shown as "V1.59 by Sam" in What's new and
     on the update card;
   - `owner` of the shared features they add to `features.json`;
   - their worktrees: `../ps-<release name>-<piece>`, and their layer folder `../ps-<release name>-layer`.
4. **Role**: contributor. **Added**: the version in `web/ps-version.json`. **Notes**: anything useful (for example
   "Windows port").
5. Save the row, tell them in one line they are set up with that release name, and carry on.

A row added this way lives in this person's copy of the skill only. To be on everyone's list, they ask the owner
to add it to the master copy, which the owner hands out to everyone.

Because each copy of this list can be different, also check the name is not used by anyone on GitHub before
picking it: the branch names (`git ls-remote --heads origin`), the `by` names of the version tags
(`git fetch origin --tags && git for-each-ref refs/tags/v* --format='%(contents)'`) and the `owner` names in
`features.json`. If it is taken there, pick another.

This list steers what the AI does; it is not a lock. Who may push branches, and what merges, is set on GitHub by
the owner (write access, the rules and the checks).
