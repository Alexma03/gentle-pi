# Gentle AI review provider contract

This data-only bundle describes the provider result contracts admitted by Gentle AI.

## Activation

1. Verify the signed release checksum manifest before using this archive.
2. Verify every listed file hash and the transport capability before activation.
3. Confirm your runtime identity appears in the manifest's registered runtimes before trusting the layout.
4. Pass the Go-materialized opaque prompt to the provider and return only raw output or an error.

Go remains the admission authority for prompts, results, receipts, and delivery gates.
