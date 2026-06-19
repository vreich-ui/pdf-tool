Purpose

This utility exists because binary artifacts should not travel through MCP.

Content:
ChatGPT Agent
→ MCP
→ Blob JSON

Artifacts:
Agent SDK
→ OpenAI APIs
→ saveArtifactBytes()
→ ArtifactReference

Responsibilities

ChatGPT Agent:
- articles
- briefs
- metadata
- workflow records

Artifact Utility:
- images
- PDFs
- binary assets
- artifact indexing

Future Direction

The utility is expected to become a shared service for multiple projects.

projectId
→ OpenAI configuration
→ blob namespace
→ workflow permissions

The worker should execute an Agent SDK workflow, even if v1 contains only a single image generation tool.
