#!/usr/bin/env bash
# PreToolUse hook (Bash): enforce the commit/push identity rules in CLAUDE.md.
#
#   git commit  -> effective author/committer must be mrsmrtypnts
#   git push    -> the above, plus the gh active account and the git
#                  credential helper must both resolve to mrsmrtypnts
#
# Reads the hook payload (JSON) on stdin. Exit 2 blocks the tool call and shows
# stderr to Claude; exit 0 allows it. Never prints credentials.
#
# Tests: .claude/hooks/test-check-git-identity.sh

WANT_NAME="mrsmrtypnts"
WANT_EMAIL="310750161+mrsmrtypnts@users.noreply.github.com"

PARSE="$(cat <<'PY'
import json, re, sys
d = json.load(sys.stdin)
cmd = (d.get("tool_input") or {}).get("command") or ""
cwd = d.get("cwd") or ""
kinds = set(re.findall(r"\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*\s+(commit|push)\b", cmd))
kind = "push" if "push" in kinds else ("commit" if kinds else "-")
override = bool(
    re.search(r"--author\b|--reset-author|\bGIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)=|\bgit\s+(?:\S+\s+)*-c\s+user\.", cmd)
    # `git config user.name|email VALUE` in the same command rewrites the identity after this check.
    or re.search(r"\bgit\b[^;&|]*\bconfig\b[^;&|]*\buser\.(?:name|email)\s+[^\s;&|]", cmd)
)
# Fixed-position fields first, cwd last, so an empty field can never shift the rest.
print(kind, "1" if override else "0", cwd)
PY
)"

payload="$(cat)"
read -r KIND OVERRIDE CWD < <(printf '%s' "$payload" | python3 -c "$PARSE" 2>/dev/null)

fail() {
  echo "BLOCKED by .claude/hooks/check-git-identity.sh: $1" >&2
  echo "See CLAUDE.md 'Commit identity'. Fix it, then retry." >&2
  exit 2
}

if [[ -z "$KIND" ]]; then
  # Parsing failed. Fail open for unrelated commands, but closed if the raw
  # payload looks like it involves a commit or push.
  grep -Eq 'git[^"]*(commit|push)' <<< "$payload" && fail "could not parse the hook payload, and it mentions a git commit/push."
  exit 0
fi
[[ "$KIND" == "-" ]] && exit 0
[[ -n "$CWD" && -d "$CWD" ]] && cd "$CWD"

[[ "$OVERRIDE" == "1" ]] && fail "command overrides the git identity (--author / GIT_AUTHOR_* / -c user.* / git config user.* in the same command); set it in a separate step first."

want="$WANT_NAME <$WANT_EMAIL>"
for var in GIT_AUTHOR_IDENT GIT_COMMITTER_IDENT; do
  got="$(git var "$var" 2>/dev/null | sed -E 's/ [0-9]+ [+-][0-9]{4}$//')"
  [[ "$got" == "$want" ]] || fail "$var is '$got', expected '$want'. Run: git config user.name \"$WANT_NAME\"; git config user.email \"$WANT_EMAIL\""
done

if [[ "$KIND" == "push" ]]; then
  gh_user="$(gh auth status --hostname github.com --active 2>&1 | sed -nE 's/.*Logged in to github\.com account ([^ ]+).*/\1/p' | head -1)"
  [[ "$gh_user" == "$WANT_NAME" ]] || fail "gh active account is '${gh_user:-unknown}', expected '$WANT_NAME'. Run: gh auth switch --hostname github.com --user $WANT_NAME"
  # GIT_TERMINAL_PROMPT=0: fail fast instead of prompting if no helper answers.
  cred_user="$(GIT_TERMINAL_PROMPT=0 git credential fill <<< $'protocol=https\nhost=github.com' 2>/dev/null | sed -nE 's/^username=//p' | head -1)"
  [[ "$cred_user" == "$WANT_NAME" ]] || fail "git credential helper resolves to '${cred_user:-unknown}', expected '$WANT_NAME'."
fi
exit 0
