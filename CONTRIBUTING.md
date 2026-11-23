# Contributing

This repository holds the Mainwave plugin for Claude Code and Cowork. The [README](README.md) says what it does, what it sends and how it is installed. The code is published so that anyone can read it, but it is not open source: see [LICENSE](LICENSE), which also covers what you grant Mainwave when you contribute.

- **Bugs and questions:** open an issue. Give the plugin's version, the Claude Code version and where the session runs.
- **Security problems:** do not open an issue. Follow [SECURITY.md](SECURITY.md).
- **Code changes from outside Mainwave:** open an issue first, so we can agree on the change before you write it.

## Layout

The plugin sits at the repository's root:

- `.claude-plugin/plugin.json`: the manifest
- `.claude-plugin/marketplace.json`: this repository as a marketplace
- `hooks/`: the hooks module, `register.ts`, and the modules it imports (the README's Developing section lists what each holds)
- `types/index.d.ts`: what the plugin keeps in `$.state`
- `tests/`: the unit tests, and the end-to-end checks in `tests/e2e/`
- `scripts/`: the repository's checks

## Checks

```sh
claude plugin validate .        # manifest, marketplace and hooks module, read the way Claude Code will
claude plugin test .            # tests/*.test.ts against the engine
scripts/check-version.sh        # plugin.json and hooks/version.ts agree; the Claude Code floor is the same in CI's pin, plugin.json and the README
scripts/next-version.sh --check # the version is the next from main's (YYYY.M.N in UTC); fetch origin main first
scripts/check-layout.sh         # one plugin, at the root: org sync refuses a .claude-plugin/ or plugin.json anywhere else
scripts/check-hooks.sh          # the row hooks keep their fail-open .catch; the hooks that must be there are; no classic hook
scripts/check-vendored.sh       # the copies of Mainwave's catalog and command cases (JSON) and the twins the tests import agree; --write rewrites the twins
node tests/e2e/compare.mjs      # real sessions, model mocked: the plugin's copy against the exporter's; without the env block, keyless and coherent
MW_E2E_SEATED=1 node tests/e2e/seated.mjs   # needs managed settings on the machine (CI's runner, or a container): the marker hooks run past the security default
claude --plugin-dir .           # a session with the plugin loaded from this folder
```

CI runs all but the last on every pull request, on two Claude Code versions: the latest and the floor, the oldest version the plugin supports. The type check runs locally only: start one session with `claude --plugin-dir .`, which writes Claude Code's declarations to `.claude-plugin/types/`, then run `npx -p typescript@5.6.3 tsc -p .`. The README's Developing section says what each check covers.

## Rules

- **Hooks fail open.** A fault in the plugin never holds a row, a tool call or the session.
- **No `classic.*` hooks.** Claude Code's security default skips them for every plugin a person installs or an organization syncs (Team and Enterprise organizations, managed settings, remote Cowork). Use the native events. `scripts/check-hooks.sh` fails on a classic hook.
- **Keep the README true.** It is the contract for what the plugin sends. A change to what the plugin reads, sends or holds back changes the README in the same pull request.
- **A new stamp key** needs a shape rule in `hooks/stamps.ts`, an owned prefix if it starts a new one, and an entry in the test contract in `tests/rig.ts`. The contract is written independently of `hooks/`, so a test does not pass because the code says so.
- **Vendored copies are not edited here.** `hooks/data-points.json` is a copy of Mainwave's catalog of data points, the source of `hooks/catalog.ts`, and `tests/catalog.test.ts` compares the two field by field, all but the defaults, which are the plugin's own. `tests/fixtures/command-outcomes.json` is a copy of the cases of Mainwave's command rules, the source of `commandOutcomes` in `hooks/derive.ts`, and `tests/outcomes.test.ts` runs them. To change either, replace the copy with Mainwave's, then run `scripts/check-vendored.sh --write`. If your change needs a new copy, say so in the issue.
- **One plugin, at the root.** Org sync refuses a repository with a second manifest. A test that needs another plugin builds it in a temporary folder, as `tests/e2e/compare.mjs` does.
- **Public by default.** Everything here is public: files, commit messages and pull requests. Leave out internal references, real organization or account IDs, real email addresses and local paths. Tests use example IDs and `example.com` addresses.

## Releases and the Claude Code floor

- **Don't edit the version.** Every merge to `main` is a release. On each pull request, CI's `set version` job writes the next `YYYY.M.N` to `.claude-plugin/plugin.json` and `hooks/version.ts` and pushes it as a `chore(release): <version>` commit, so pull before pushing again. The README's Releasing section says how it works.
- **When the version lines conflict** as you update a branch from `main`, take `main`'s version in both files and push: the job writes the next one. A pull request from a fork gets no version commit: a maintainer runs `git fetch origin main && scripts/next-version.sh --write` on its branch and pushes.
- Raising the Claude Code floor is a pull request of its own. It changes `.github/claude-code-floor/package.json`, `engines` in `.claude-plugin/plugin.json`, the README's Install section and the note at the README's top together. Dependabot's version updates don't watch the floor.

## Commits

```
<type>(<scope>): <short description>
```

- The description is lowercase and imperative.
- Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf`, `ci`.
- Scopes name the area: `plugin`, `e2e`, `sender`, `stamps`, `readme`, `gate` and so on.
- The body, after a blank line, says why the change was made, not what the diff shows. Wrap it at 72 characters.
- Commit messages and pull requests credit people only. Leave out trailers and footers that credit a tool.

```
fix(plugin): count a subagent's tokens once when two of its calls end together

A call's end reading moves the subagent's ledger reading forward at
once, so a second call ending meanwhile counts from it.
```

## Pull requests

- Never commit to `main`. Work on a branch and open a pull request.
- Pull requests are squash-merged. The commit on `main` takes the pull request's title, or for a single commit, that commit's message, so both follow the commit format.
- The description says what changes for a person or an organization using the plugin, why, and how it was tested: the checks run, and what was not verified. Write it in plain paragraphs, without hard line wraps.
- Every change is reviewed by someone who did not write it before it is marked ready for review. A maintainer approves and merges it.
- CI must pass on both Claude Code versions.
