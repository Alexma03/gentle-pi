# Coordinated release and rollback evidence

This repository records release readiness in `docs/release/release-evidence.json`.
The record is deliberately parameterized: while the Nicobailon
`npm:pi-subagents` contract has no published version and digest recorded here,
the repository check passes as evidence-only and the release check fails closed.
No unavailable provider version is invented. The provider version/digest fields
are repository-record fields, not external provenance: a ready record must also
declare `providerContract.externalVerification.status: "verified"` and point to a
repository-owned `gentle-pi.external-provider-attestation/v1` file whose exact
bytes and provider/version/digest fields match. The checker validates those
bytes offline; it does not consult a registry or invent attestation values.

## Release boundary

Before a Gentle Pi release, a maintainer must:

1. Publish the immutable `npm:pi-subagents` RPC-v1 contract and record its
   exact semver and SHA-256 digest in the repository record, then add the
   matching externally verified attestation file and digest fields.
2. Run the Node 24 matrix on Linux, macOS, and Windows. Windows must use the
   pinned Gentle AI Go SumDB source-build path and its minimum Go version.
3. Run the provider-contract, generated-runtime, package-inventory, harness,
   aggregate-test, and packed-package checks on every matrix runner.
4. Update the evidence status to `ready` only after all values are verified;
   `node scripts/check-release-evidence.mjs --release` is the final fail-closed
   gate used by the npm publish workflow.

Gentle Pi and Gentle AI form one coordinated release boundary: the Gentle AI
release pin and the Gentle Pi package move together. The release record is
repository-owned evidence only; RDD review
evidence remains independent from ordinary delivery.

## Rollback boundary

Rollback is paired: restore the prior Gentle Pi package manifest and lockfile,
restore the prior published Gentle AI runtime pin and its verified metadata,
then rerun the provider-contract, runtime-module, package-inventory, harness,
aggregate-test, and packed-package checks. Never restore a legacy adapter or
leave one side of the pair at a newer protocol contract.
