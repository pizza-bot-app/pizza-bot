#!/usr/bin/env bash
# Turns the agent review's structured output (RESULT) into the merge gate.
#   enforce    fails on block, on no verdict, or on a ship that skipped a changed file
#   post       keeps one verdict comment on the pull request (GATE = enforce's outcome)
#   await-label  sets a fork commit's agent-review to blocked until a maintainer labels it
#   check-run    reports the labeled review's verdict on that same check run
set -eo pipefail

: "${GITHUB_REPOSITORY:?}" "${PR:?}" "${RUNNER_TEMP:?}"
verdict=$(jq -r '.verdict // empty' <<<"${RESULT:-}" 2>/dev/null || true)
summary=$(jq -r '.summary // empty' <<<"${RESULT:-}" 2>/dev/null || true)
not_reviewed="$RUNNER_TEMP/not-reviewed.md"

enforce() {
  echo "### Agent review: ${verdict:-no verdict}" >> "$GITHUB_STEP_SUMMARY"
  echo "$summary" >> "$GITHUB_STEP_SUMMARY"
  case "$verdict" in
    ship) ;;
    block) echo "::error::Agent review blocked: $summary" && exit 1 ;;
    *) echo "::error::Agent review returned no verdict" && exit 1 ;;
  esac
  # "The whole diff was reviewed" is the model's claim; hold it to the pull
  # request's actual file list.
  local changed reviewed missing
  changed=$(gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR/files" --jq '.[] | select(.status != "removed") | .filename' \
    | { grep -vE '(\.test\.tsx?|\.snap|(^|/)package-lock\.json|\.(png|jpe?g|gif|webp|ico))$' || true; } | sort -u)
  reviewed=$(jq -r '.files_reviewed[]?' <<<"$RESULT" | sort -u)
  missing=$(comm -23 <(printf '%s\n' "$changed") <(printf '%s\n' "$reviewed") | sed '/^$/d')
  if [ -n "$missing" ]; then
    { echo; echo "Not reviewed:"; sed 's/^/- /' <<<"$missing"; } \
      | tee "$not_reviewed" >> "$GITHUB_STEP_SUMMARY"
    echo "::error::Agent review returned ship without reviewing: $(paste -sd, - <<<"$missing")"
    exit 1
  fi
  echo "Agent review: ship"
}

body() {
  printf '%s\n' "${summary:-The review ended without a verdict.}"
  if [ -f "$not_reviewed" ]; then cat "$not_reviewed"; fi
}

post() {
  local marker='<!-- agent-review -->' status=blocked comments id
  if [ "$GATE" = success ]; then status=passed; fi
  {
    echo "$marker"
    echo "## Agent review: $status"
    echo
    body
    echo
    echo "Commit $HEAD_SHA, [workflow run]($RUN_URL)"
  } > "$RUNNER_TEMP/verdict.md"
  comments="repos/$GITHUB_REPOSITORY/issues"
  id=$(gh api --paginate "$comments/$PR/comments" \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" \
    | head -n 1)
  if [ -n "$id" ]; then
    gh api --method PATCH "$comments/comments/$id" -F body=@"$RUNNER_TEMP/verdict.md" --silent
  else
    gh api --method POST "$comments/$PR/comments" -F body=@"$RUNNER_TEMP/verdict.md" --silent
  fi
}

# Branch protection fails the check if any agent-review run on the commit
# failed, so a fork commit gets exactly one, found by its external_id and
# updated in place.
upsert_check_run() {
  local conclusion=$1 title=$2 summary=$3 id
  id=$(gh api "repos/$GITHUB_REPOSITORY/commits/$HEAD_SHA/check-runs?check_name=agent-review&filter=all" \
    --jq '[.check_runs[] | select(.external_id == "agent-review-fork")][0].id // empty')
  jq -n --arg sha "$HEAD_SHA" --arg c "$conclusion" --arg t "$title" --arg s "$summary" --arg url "$RUN_URL" \
    '{name: "agent-review", head_sha: $sha, external_id: "agent-review-fork", status: "completed",
      conclusion: $c, details_url: $url, output: {title: $t, summary: $s}}' \
    | if [ -n "$id" ]; then
        jq 'del(.head_sha)' | gh api --method PATCH "repos/$GITHUB_REPOSITORY/check-runs/$id" --input - --silent
      else
        gh api --method POST "repos/$GITHUB_REPOSITORY/check-runs" --input - --silent
      fi
}

await_label() {
  upsert_check_run action_required "Waiting for the safe-to-review label" \
    "A maintainer reviews a fork's pull request by reading the diff and adding the safe-to-review label, which runs the agent review on this commit."
}

check_run() {
  local conclusion=failure title="Agent review blocked"
  if [ "$GATE" = success ]; then conclusion=success title="Agent review passed"; fi
  upsert_check_run "$conclusion" "$title" "$(body)"
}

case "${1:-}" in
  enforce) enforce ;;
  post) post ;;
  await-label) await_label ;;
  check-run) check_run ;;
  *) echo "usage: $0 enforce|post|await-label|check-run" >&2 && exit 2 ;;
esac
