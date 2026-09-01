# Delta for Package Runtime

## MODIFIED Requirements

### Requirement: Package verification provides release evidence

The package MUST verify coordinated runtime binaries, negotiated contracts, retained dependencies, generated contents, and changed behavior on Linux, macOS, and Windows before release. Focused suites, runtime harness, full `pnpm test`, and package-content verification MUST pass on supported Node.js 24 environments. RDD review remains independent evidence and MUST NOT govern ordinary delivery.
(Previously: release evidence covered the pinned runtime, package contents, and changed behavior without requiring cross-platform contract and dependency coordination.)

#### Scenario: Coordinated release verification succeeds

- GIVEN the pinned runtime, negotiated contract, retained dependencies, and package contents are installed
- WHEN focused suites, runtime harness, full tests, and package verification run on supported OSes
- THEN all required evidence is recorded for the final verification matrix

#### Scenario: Verification fails

- GIVEN any required binary, contract, dependency, test, package-content, or compatibility check fails
- WHEN package verification is evaluated
- THEN the failed verification is recorded and ordinary delivery remains governed independently of RDD evidence
