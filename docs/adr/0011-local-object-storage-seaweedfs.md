# ADR-0011: SeaweedFS for local S3-compatible object storage

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Attachments live in S3 in AWS (ADR-0005). Local development and integration tests need an
S3-compatible store that runs in Docker, so the same code paths (pre-signed PUT and GET, HEAD,
delete, bucket CORS) are exercised without an AWS account. The architecture originally named
MinIO. When Phase 6b was built, MinIO's community container images were no longer published:
`minio/minio` on Docker Hub reports that the repository does not exist, and pinned release tags
are not mirrored.

## Decision

Use **SeaweedFS** (`chrislusf/seaweedfs`, Apache-2.0, pinned to `3.97`) with its S3 gateway,
in `docker-compose.yml` and as a Testcontainer in the integration tests. Credentials come from
`infrastructure/docker/seaweedfs/s3.json`, used by both.

The application depends only on the S3 API through the AWS SDK v3. Nothing is
SeaweedFS-specific: pointing `S3_ENDPOINT` at any S3-compatible service, or leaving it unset
for AWS, needs no code change.

Verified before adopting it (and now covered by `attachments.int-spec.ts`):

- A pre-signed PUT signs `Content-Length`, `Content-Type` and `Content-Disposition`; a body of
  another size or type is rejected with `403`.
- The stored `Content-Disposition` is returned on download.
- Bucket CORS (`PutBucketCors`) allows the web origin and refuses other origins.

## Alternatives considered

- **LocalStack.** The closest AWS emulation, but a much larger image, and its free edition now
  needs an account token.
- **RustFS, Garage, versitygw, S3Mock.** Available, but less mature (RustFS), missing
  pre-signed URL or CORS support we rely on, or aimed at unit tests rather than a dev server.
- **A real S3 bucket for development.** Needs AWS credentials on every laptop and in CI, which
  the project avoids (CI uses OIDC only for deployment).

## Consequences

- ➕ Local runs and CI exercise the real upload protocol, signatures included.
- ➕ Swapping the local store later is a Compose change only.
- ➖ SeaweedFS ignores the `response-content-disposition` override on pre-signed GETs, so the
  download disposition is stored on the object at upload time instead. This works identically
  on S3.
- ➖ The API creates the bucket and its CORS rule itself when `S3_ENSURE_BUCKET=true` (local
  and tests only). In AWS, Terraform owns the bucket, its policy and CORS (Phase 16).
