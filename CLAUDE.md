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

# Before pushing

Always confirm with the user before running `git push`, even immediately after a commit they already asked for. Committing does not imply push approval.
