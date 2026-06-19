# Agent Artifact Architecture

Content path:

`ChatGPT Agent -> MCP -> Netlify Blobs`

Binary artifact path:

`Netlify Agent SDK workflow -> OpenAI API/tool -> saveArtifactBytes() -> Netlify Blobs`

Do not pass generated binary bytes through MCP. Internal generation does not require upload tokens.
