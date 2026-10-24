#!/usr/bin/env bash
# Regression tests for check-git-identity.sh. Feeds simulated hook payloads to
# the hook in throwaway repos (hermetic: no global/system git config, no real
# credentials, no network). Usage: .claude/hooks/test-check-git-identity.sh
set -u
HOOK="$(cd "$(dirname "$0")" && pwd)/check-git-identity.sh"
GOOD_NAME="mrsmrtypnts"
GOOD_EMAIL="310750161+mrsmrtypnts@users.noreply.github.com"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

# Stub gh so the tests don't depend on the real login; STUB_GH_USER picks the "active" account.
mkdir "$T/bin"
printf '#!/usr/bin/env bash\necho "github.com"\necho "  ✓ Logged in to github.com account ${STUB_GH_USER:-%s} (keyring)"\n' "$GOOD_NAME" > "$T/bin/gh"
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"

mkrepo() { # dir name email helper_user ("" = no helper)
  git init -q "$1"
  git -C "$1" config user.name "$2"; git -C "$1" config user.email "$3"
  git -C "$1" config --add credential.helper ""
  [[ -n "$4" ]] && git -C "$1" config --add credential.helper "!f() { test \"\$1\" = get && echo username=$4 && echo password=x; }; f"
  return 0
}
mkrepo "$T/good"      "$GOOD_NAME"   "$GOOD_EMAIL"     "$GOOD_NAME"
mkrepo "$T/bad"       "Someone Else" "else@example.com" "$GOOD_NAME"
mkrepo "$T/nocred"    "$GOOD_NAME"   "$GOOD_EMAIL"     ""
mkrepo "$T/wrongcred" "$GOOD_NAME"   "$GOOD_EMAIL"     "wcmac"

for r in good bad nocred wrongcred; do git -C "$T/$r" remote add origin https://github.com/mrsmrtypnts/hothouse.git; done
mkrepo "$T/wrongorigin" "$GOOD_NAME" "$GOOD_EMAIL" "$GOOD_NAME"
git -C "$T/wrongorigin" remote add origin https://github.com/someone/else.git

pass=0; fail=0
# check LABEL WANT_RC HOOK_CWD PAYLOAD_CWD COMMAND
check() {
  local payload rc
  payload="$(python3 -c 'import json,sys;print(json.dumps({"tool_input":{"command":sys.argv[2]},"cwd":sys.argv[1]}))' "$4" "$5")"
  (cd "$3" && printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1); rc=$?
  if [[ $rc -eq $2 ]]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 (rc=$rc, want $2)"; fi
}
# askcheck LABEL WANT_ASK(1|0) CWD COMMAND: on an allowed run, stdout must (not) request a permission prompt
askcheck() {
  local payload out
  payload="$(python3 -c 'import json,sys;print(json.dumps({"tool_input":{"command":sys.argv[2]},"cwd":sys.argv[1]}))' "$3" "$4")"
  out="$(cd "$3" && printf '%s' "$payload" | "$HOOK" 2>/dev/null)"
  if [[ ( $2 == 1 && "$out" == *'"permissionDecision":"ask"'* ) || ( $2 == 0 && -z "$out" ) ]]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 (stdout: $out)"; fi
}
# raw LABEL WANT_RC HOOK_CWD RAW_STDIN  (for malformed payloads)
raw() {
  local rc
  (cd "$3" && printf '%s' "$4" | "$HOOK" >/dev/null 2>&1); rc=$?
  if [[ $rc -eq $2 ]]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 (rc=$rc, want $2)"; fi
}

G="$T/good"; B="$T/bad"
check "unrelated command, good repo"            0 "$G" "$G" "ls -la"
check "unrelated command, bad repo"             0 "$B" "$B" "ls -la"
check "git log --grep=commit is unrelated"      0 "$B" "$B" "git log --grep=commit"
check "unrelated cmd uses payload cwd, not hook cwd (regression)" 0 "$B" "$G" "ls"
check "commit, good identity"                   0 "$G" "$G" "git commit -m x"
check "commit, bad identity"                    2 "$B" "$B" "git commit -m x"
check "commit, payload cwd is the bad repo"     2 "$G" "$B" "git commit -m x"
check "git -C ... commit, bad identity"         2 "$B" "$B" "git -C /x commit -m x"
check "add && commit, bad identity"             2 "$B" "$B" "git add . && git commit -m x"
check "commit --author override"                2 "$G" "$G" "git commit --author='A <a@b.c>' -m x"
check "GIT_AUTHOR_NAME= override"               2 "$G" "$G" "GIT_AUTHOR_NAME=bob git commit -m x"
check "git -c user.name= override"              2 "$G" "$G" "git -c user.name=bob commit -m x"
check "config write then commit, same command"  2 "$G" "$G" "git config user.email x@y.z && git commit -m x"
check "config read then commit is fine"         0 "$G" "$G" "git config --get user.email && git commit -m x"
check "push, good identity + good credential"   0 "$G" "$G" "git push origin main"
check "push, bad identity"                      2 "$B" "$B" "git push origin main"
STUB_GH_USER=wcmac check "push, gh active account is wrong" 2 "$G" "$G" "git push origin main"
check "push, wrong credential account"         2 "$T/wrongcred" "$T/wrongcred" "git push origin main"
check "push, no credential helper (no hang)"    2 "$T/nocred" "$T/nocred" "git push origin main"
check "commit && push runs the push checks (regression)" 2 "$T/wrongcred" "$T/wrongcred" "git commit -m x && git push origin main"
check "push; commit order, wrong credential"    2 "$T/wrongcred" "$T/wrongcred" "git push origin main; git commit -m x"
check "pull, bad identity"                      2 "$B" "$B" "git pull"
check "merge, bad identity"                     2 "$B" "$B" "git merge feature"
check "rebase, bad identity"                    2 "$B" "$B" "git rebase main"
check "cherry-pick, bad identity"               2 "$B" "$B" "git cherry-pick abc123"
check "merge-base is read-only, not a trigger"  0 "$B" "$B" "git merge-base HEAD main"
check "pull, good identity"                     0 "$G" "$G" "git pull"
check "push, wrong origin"                      2 "$T/wrongorigin" "$T/wrongorigin" "git push origin main"
askcheck "push asks for approval"               1 "$G" "git push origin main"
askcheck "commit does not ask"                  0 "$G" "git commit -m x"
askcheck "blocked push does not ask"            0 "$B" "git push origin main"
askcheck "pull does not ask"                    0 "$G" "git pull"
raw   "malformed payload without git: allowed"  0 "$G" 'not json at all'
raw   "malformed payload mentioning git push: blocked (fail closed)" 2 "$G" 'not json {"command":"git push origin main"'

echo "passed=$pass failed=$fail"
[[ $fail -eq 0 ]]
