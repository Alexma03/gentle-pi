# Subagent Runtime Specification

## Purpose

Define the sole negotiated runtime for portable subagent execution.

## Requirements

### Requirement: Nicobailon capability negotiation

The runtime MUST use only the Nicobailon `npm:pi-subagents` adapter through one narrow port. It MUST negotiate advertised capabilities before lifecycle operations and MUST reject unsupported operations without provider inference or alternate adapters.

#### Scenario: Supported operation

- GIVEN the adapter advertises the requested lifecycle capability
- WHEN a task is submitted through the port
- THEN the runtime executes the versioned RPC and returns the portable result contract

#### Scenario: Capability is absent

- GIVEN the adapter does not advertise a required capability
- WHEN that operation is requested
- THEN the runtime fails closed and does not select a fallback provider
