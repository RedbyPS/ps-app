# Your layer, your profile, versions and releases (since V1.58)

Read `layers/README.md` in core first; this file is the how to for a person working with this skill. If the code
and this file disagree, the code wins.

## The picture

- **Core** = the public repo RedbyPS/ps-app. Shared code only.
- **Your layer** = your own private files, in a folder next to your core clone (for example `../ps-sam-layer/`),
  ideally its own private git repo. Never inside core, never pushed to core.
- **Your profile** = `profile.json` in your layer: who the build is for, its update channel, which features are
  on, the per build rules.
- `node tools/build.mjs <your layer.json> all` copies core's tracked files and your layer into
  `.build/<release name>/` and builds there. Nothing in core changes.

No layer at all gives the G Squad build (`node tools/build.mjs gsquad ...`, profile `profiles/gsquad.json`).

## First time setup

### 1. Core

Check first whether the person may push branches to RedbyPS/ps-app:

```bash
gh repo view RedbyPS/ps-app --json viewerPermission --jq .viewerPermission
```

- `WRITE`, `MAINTAIN` or `ADMIN`: clone it directly (`gh repo clone RedbyPS/ps-app ps`). Branches go straight to
  RedbyPS/ps-app, which is what auto merge needs.
- Anything else: the owner has not given them write access yet. Use a fork (`references/contributing.md`), and tell
  them plainly that pull requests from a fork never merge by themselves (the owner merges them) and that they can
  not claim version numbers until the owner adds them.

Then, in the clone: `cd web && cp .env.example .env && npm ci`.

### 2. The layer

Make the folder next to the clone and ask the person before making a GitHub repo for it (if they want one, it is
`gh repo create <their login>/ps-<release name>-layer --private`, only on their yes):

```
../ps-<release name>-layer/
  layer.json
  profile.json
  features.json      optional: this person's private features
  web/ mac/ phone/   their files, at the same paths as in core
```

`layer.json` (the fields are explained in core's `layers/README.md`):

```json
{
  "schema": 1,
  "name": "<release name>",
  "owner": "<their GitHub login>",
  "replace": { "web": [] },
  "add":     { "web": [] },
  "remove":  { "mac": [] },
  "pinned":  {},
  "local":   { "web": [".env"] },
  "audit":   null
}
```

`profile.json`, starting from the G Squad profile:

```json
{
  "schema": 1,
  "name": "<release name>",
  "display": "<their name>",
  "channel": { "kind": "local" },
  "othersShared": "off",
  "features": {},
  "rules": {
    "tabOverProtectedApps": true,
    "islandOverProtectedApps": true
  }
}
```

- `name` is their private release name from `contributors.md`. Never `gsquad`, never `red`, never someone else's.
- `channel` `local`: their build never updates by itself; they install each of their own builds. (A person with
  their own https server may use `{"kind": "url", "url": "https://.../", "key": "<their own update public key>"}`;
  only if they ask, and never the G Squad channel.)
- `othersShared` `off`: features other people shared stay off in their build until they switch each one on in
  "From the squad". `on` would switch them all on, as in the G Squad build. Their choice; `off` is the safe default.
- `rules`: the two 1Password and Signal rules, kept separate, copied from `profiles/gsquad.json`. A profile can only
  narrow the per account answer, never widen it. Change them only if the person asks, and test both.

### 3. The guard

```bash
node tools/guard.mjs --install --layer ../ps-<release name>-layer/layer.json
```

It becomes the `pre-push` hook of the core clone. Do it in every core clone and worktree the person pushes from.

### 4. Prove it builds

```bash
node tools/build.mjs ../ps-<release name>-layer/layer.json all --check --tests
```

Some web tests already fail on a clean `main`; `--allow-fail a,b` names those (file names without `.test.ts`).
Only allow ones that fail on `main` too, and say which.

## What goes in a layer

- **`add`**: new files core does not have. The best kind: core moving on never clashes with them.
- **`replace`**: swap a plug point (`layers/plugpoints.json`) for your own file, same path, same export names.
  Never to rebuild the owner's left out features.
- **`pinned`**: your own change to a core file. Keep these few and small. When core's file moves on, the build
  merges both changes; a clean merge says "re-pin" (run the build with `--repin` to save it), a clash stops with
  the file name: merge it by hand in the layer, then pin the new core blob.
- **`local`**: files copied into the build but never committed anywhere (`web/.env`).
- When core changes something your layer depends on (for example a plug point gains an export), your build stops
  at `tsc` or the Swift type check with the file name. Fix the layer; never change core just to fit a layer.

A private feature can have an entry in the layer's own `features.json` (`scope` "private", `owner` = release name).
Its id must not clash with any id in core's `features.json`.

## Shared features, the registry and "From the squad"

Core's `features.json` lists every shared feature. For a new shared feature add an entry like:

```json
{ "id": "corner-clock", "name": "Corner clock", "owner": "sam", "scope": "shared", "since": "1.59",
  "parts": ["web"], "default": "on" }
```

and ask `feature("corner-clock")` in web code (`web/src/core/features.ts`), `Features.on("corner-clock")` on the
Mac, `Features.on(ctx, "corner-clock")` on the phone. The checks refuse an id used in code that is not in a
registry, a duplicate id, and a shared entry that no code uses.

Is a feature on?

- made by `core` or by this build's own person: its default, then the profile's `features` override;
- made by someone else: on only if the profile's `othersShared` lets it, then the profile's override, then the
  person's own switch in Settings, G Squad, "From the squad" (saved with their settings, so it follows them).

"From the squad" lists every shared feature made by someone else, with who made it and the version it came in.

## Versions: one number for everyone

- The claim is an annotated tag `v<version>` on RedbyPS/ps-app, made and pushed only by
  `tools/claim-version.mjs`. A number already taken cannot be pushed again, so the slower person simply gets the
  next one. The tag message holds only who, private or shared, when, and the release name: never any notes.
- Claiming needs write access to RedbyPS/ps-app. It is public and permanent, so show the person the command and
  wait for their yes. Always try `--dry-run` first: it fetches and prints the number it would take, and pushes
  nothing.
- Every release says who made it: "V1.59 by Sam" in What's new and on the update card; a G Squad build says
  "by the G Squad".
- A private release of yours moves the number for everyone (the next claim is higher) but changes nobody else's
  app, and is never listed in anyone else's What's new.

## A private release (core + your layer, on your own machine)

1. All checks for the release choice the person picked (`workers-and-releases.md`).
2. Claim, from an up to date core clone, on their yes:

   ```bash
   cd web && node scripts/ps-version.mjs claim --by <release name> --private --dry-run   # look first
   node scripts/ps-version.mjs claim --by <release name> --private                       # on their yes
   ```

   It claims the tag and writes the number, its release name and "by" into `web/ps-version.json` of the clone, so
   the build shows "V1.59 by Sam".
3. Build: `node tools/build.mjs ../ps-<release name>-layer/layer.json all` (or only the parts that changed). The Mac
   app lands in `.build/<release name>/mac/build/PS.app`, signed with the person's own signing identity if
   `build.sh` finds one, ad hoc otherwise. Nothing is installed.
4. Install on their own machine only on their yes (it replaces the PS they are running; quit it first, one PS at a
   time). The phone APK is signed with their own keystore if they set one up, otherwise it is unsigned and must be
   signed before it installs.
5. Put `web/ps-version.json` back: `git restore web/ps-version.json`. That change was for their build only and
   never goes into a pull request.

No write access yet: they cannot claim. Build with the version on `main`, mark the build with a local tag that is
never pushed and never reused (`git tag <release name>-v<version>-<n>`, for example `sam-v1.58-2`), and tell them
that their build will show the same number as `main` until the owner gives them write access.

## A shared release (core, for everyone)

1. The change goes in by pull request (`contributing.md`) and merges once every check passes.
2. Then the G Squad build is made **on GitHub**, never on anyone's own machine: a shared claim on a commit of
   `main` starts the release workflow, which checks again, builds, signs with the G Squad keys (kept only in GitHub
   secrets) and publishes to the G Squad channel. Friends' apps then offer the update.

   ```bash
   git switch main && git pull --ff-only
   node tools/claim-version.mjs --by <release name> --kind shared --floor "$(node -p "require('./web/ps-version.json').version")" --keywords web/scripts/ps-keywords.json --dry-run
   ```

   and without `--dry-run` on the person's yes.
3. **Until the owner switches G Squad builds on, never make a shared claim.** It would take a number and build
   nothing. Today a merged change reaches friends' apps through the owner's next release; say so.
4. What's new in a G Squad build shows only words the owner approved. Put the suggested line in the pull request.
