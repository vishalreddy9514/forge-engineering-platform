#!/usr/bin/env bash
# Records the GitHub REST responses the sync integration tests replay (test/integration/github/).
#
#   ./record.sh [owner/repo]            # public repository, unauthenticated
#   GITHUB_TOKEN=... ./record.sh o/r    # private repository or higher rate limit
#
# Responses are stored as GitHub returned them, with three reductions: the full repository
# objects nested in each PR's head/base are cut to {id, full_name}, `_links` is dropped (both
# are large and unused), and commit-trailer lines (Co-Authored-By, session links) are removed.
set -euo pipefail

repo=${1:-vishalreddy9514/forge-engineering-platform}
cd "$(dirname "$0")"
headers=(-H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28')
if [[ -n ${GITHUB_TOKEN:-} ]]; then headers+=(-H "Authorization: Bearer $GITHUB_TOKEN"); fi

get() { curl -fsS "${headers[@]}" "https://api.github.com/repos/$repo$1"; }

scrub='walk(if type == "string"
  then gsub("(?m)^[^\n]*(Co-[Aa]uthored-[Bb]y|Claude-Session|Generated with \\[Claude|claude\\.ai/code)[^\n]*\n?"; "")
  else . end)'
small_repo='if . then {id, full_name} else . end'

get '' | jq '{id, node_id, name, full_name, private, html_url, default_branch,
  owner: {login: .owner.login, id: .owner.id, type: .owner.type}}' > repository.json
get '/pulls?state=all&sort=updated&direction=desc&per_page=100' \
  | jq "[.[] | del(._links) | .head.repo |= ($small_repo) | .base.repo |= ($small_repo)] | $scrub" \
  > pulls.json
get '/commits?per_page=100' | jq "$scrub" > commits.json
get '/issues?state=all&per_page=100' | jq "$scrub" > issues.json
get '/contributors?per_page=100' > contributors.json

echo "Recorded $(jq length pulls.json) pull requests, $(jq length commits.json) commits," \
  "$(jq length issues.json) issues and $(jq length contributors.json) contributors from $repo"
