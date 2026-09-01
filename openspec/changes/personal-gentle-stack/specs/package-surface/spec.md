# Package Surface Specification

## Purpose

Define retained behavior and retired package surfaces.

## Requirements

### Requirement: Focused package surface

The package MUST retain Engram, Context7, CodeGraph, behavioral SDD assets, and basic Pi UI. It MUST remove GGA, branding, marketplace/plugin features, and unused assets, with no Tintinweb or j0k3r references.

#### Scenario: Retained integrations remain usable

- GIVEN the package is installed
- WHEN a retained integration or behavioral SDD asset is requested
- THEN it is present and functional

#### Scenario: Retired surface is requested

- GIVEN a removed cosmetic or community feature is requested
- WHEN package contents are verified
- THEN no retired asset, dependency, prompt, or documentation is shipped
