# Commit identity

All commits to this repository must use this author and committer identity:

```
mrsmrtypnts <310750161+mrsmrtypnts@users.noreply.github.com>
```

Before committing, verify the repo-local git config is set accordingly — don't assume it carries over from a previous session or matches whatever global config happens to be set on the machine you're running on:

```bash
git config user.name "mrsmrtypnts"
git config user.email "310750161+mrsmrtypnts@users.noreply.github.com"
```

Before pushing, verify that the credentials that will actually authenticate the push resolve to the `mrsmrtypnts` GitHub account:

```bash
gh auth status
git credential fill <<< $'protocol=https\nhost=github.com'
```

If a different account is active, switch first (`gh auth switch --hostname github.com --user mrsmrtypnts`) rather than pushing under the wrong one.

Re-verify both of the above every time, on every machine — never assume they're already correct.

# Chrome extension versioning

Any time you change a file inside a Chrome extension directory (e.g. `chrome-extensions/chrome-image-downloader/`, `chrome-extensions/post-media-downloader/`), bump the `version` field in that extension's `manifest.json` as part of the same change. This applies to any change, not just user-facing ones — it's how reloading the unpacked extension is confirmed to have picked up the new code.

# Before pushing

Always confirm with the user before running `git push`, even immediately after a commit they already asked for. Committing does not imply push approval.

# Testing locally

Never test against real data or credentials — spin up a throwaway instance/environment instead. What's being protected varies by subsystem (live credentials, sensitive content, an in-progress live instance), but the pattern is the same: fabricate what you need, keep the real thing out of conversation transcripts and out of harm's way from a test run.

**breeder**: never against the real running instance, its real data dir, or its real API key.

```bash
HOME=<scratch dir> BREEDER_PORT=<free port> BREEDER_API_KEY=dummy-test-key BREEDER_NO_BROWSER_OPEN=1 ./breeder/run.sh
```

`BREEDER_NO_BROWSER_OPEN` is not optional — without it, the instance opens a real tab in the user's actual browser (`server.py`'s startup hook calls `webbrowser.open()` unconditionally otherwise).

Only changes to `breeder/*.py` (`server.py`, `config.py`, `store.py`, `mutate.py`, `corpus.py`) require restarting the server process to take effect. Changes under `breeder/static/` or `breeder/static_v2/` only need a browser refresh — don't restart the user's real server for those, it interrupts anything currently generating.

**trove**: never read, display, or analyze the real scan cache (`~/.cache/trove/cache.jsonl`), comparisons log (`~/.local/share/trove/comparisons.jsonl`), or `trove/model.json`. Use fabricated file paths and `HOME=<scratch dir>` instead (isolates the cache/config/comparisons-log paths, all `Path.home()`-relative). `trove/model.json` is the one exception `HOME` doesn't cover — it's resolved relative to the code (`Path(__file__).parent`), not `$HOME`, so it's always whatever checkout/worktree you're running from; working in your own worktree (see "Concurrent sessions" below) already isolates it as a side effect.

# Studio's render() gotcha

`breeder/static_v2/app.js`'s `render()` does a full `root.replaceChildren()` DOM rebuild, including on every poll tick while any node is pending. This has already caused two real bugs from the same root cause: the prompt textarea losing focus while the user was actively typing, and a panel-splitter drag breaking mid-gesture when a poll tick fired during it. Guards now exist for both (`isEditingDetailPanel()`, `isDraggingSplitter`) inside `render()`. Any new interactive gesture added to Studio (dragging, in-place editing, anything stateful that isn't just "click and navigate") should be checked against this same failure mode before it ships.

# breeder/INBOX.md

A running backlog of end-user feedback (fixes, improvements) for breeder, appended to by hand from real usage of the app. Treat `## Pending` items as a queue to triage, not free-form notes to edit. When processing an item: implement it if it's straightforward, then move its line to `## Done` with a short note of what changed. Leave ambiguous or oversized items in `## Pending` with a one-line comment explaining what's blocking it, rather than guessing. If an item is deliberately decided against (not ambiguous, just not worth doing), move it to `## Won't fix` with a short note of the reasoning — that's a different resolution than `## Done`, which implies something actually changed. Commit any resulting fixes locally — never push as part of this processing; pushing still requires the explicit confirmation described above.

# Concurrent sessions may be working on this repo

More than one Claude session — different machines, different tasks, including a self-paced automated loop that pulls `origin/main` and commits local fixes from `breeder/INBOX.md` (never pushing) — may have this repo open at once. Work in your own git worktree, not the shared checkout; merge or push from there when ready.
