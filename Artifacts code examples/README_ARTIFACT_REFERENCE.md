# Artifact Reference

Reference-only artifact persistence requirements. Runtime code must not import from this directory.

Required runtime helpers:

- `saveArtifactBytes()`
- `sha256Hex()`
- `ArtifactReference`
- `ArtifactKind`

Required retained index families:

- `request-artifacts/{requestId}/{sha256}.json`
- `by-request/{requestId}/{artifactKind}/{sha256}.json`
- `by-kind/{artifactKind}/{sha256}.json`
- `by-tag/{tag}/{sha256}.json`
