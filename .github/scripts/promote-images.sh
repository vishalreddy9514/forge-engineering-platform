#!/usr/bin/env bash
# Promotes one commit's images from GitHub Container Registry to ECR, by digest, after checking
# that each was built and attested by this repository's Images workflow. Writes the digests for
# Terraform to $1 (an *.auto.tfvars.json file).
#
# Env: COMMIT (full SHA), OWNER (GitHub owner), REPOSITORY (owner/name), ECR_REGISTRY,
#      GH_TOKEN (for `gh attestation verify`). crane must be logged in to ghcr.io and ECR.
set -euo pipefail

out=$1
declare -A refs

for image in api migrate web ai-service; do
  source="ghcr.io/${OWNER}/forge-${image}"
  target="${ECR_REGISTRY}/forge-${image}"
  tag="sha-${COMMIT}"

  digest=$(crane digest "${source}:${tag}")
  echo "forge-${image}: ${digest}"

  # Signed provenance from this repository's workflow, or the deploy stops here.
  gh attestation verify "oci://${source}@${digest}" --repo "$REPOSITORY" \
    --signer-workflow "${REPOSITORY}/.github/workflows/images.yml" >/dev/null

  # ECR tags are immutable: a re-run finds the same digest already there.
  existing=$(crane digest "${target}:${tag}" 2>/dev/null || true)
  if [[ -z "$existing" ]]; then
    crane copy "${source}@${digest}" "${target}:${tag}"
  elif [[ "$existing" != "$digest" ]]; then
    echo "${target}:${tag} already holds ${existing}, not ${digest}" >&2
    exit 1
  fi

  refs[$image]="${target}@${digest}"
done

jq -n --arg api "${refs[api]}" --arg migrate "${refs[migrate]}" --arg web "${refs[web]}" \
  --arg ai "${refs[ai-service]}" \
  '{images: {api: $api, migrate: $migrate, web: $web, "ai-service": $ai}}' > "$out"
cat "$out"
