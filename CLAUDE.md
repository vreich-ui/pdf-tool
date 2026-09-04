# pdf-tool

- What it is: the artifact foundry / MCP server - PDF templates, image search
  and import, agent artifact jobs. `render-service/` is the container that does
  the rendering; `netlify/` is the MCP surface.
- GitHub `vreich-ui/pdf-tool`. Netlify site `pdf-x`.
- Tests: `npm test` (`test:netlify`, `test:service`), `npm run check:eslint`.
- Land with `/ship pdf-tool <branch>`. `main` is protected; no required status
  checks yet because the `Deploy render-service` workflow is red on `main` -
  fix that before adding it as a gate.
- Never touch: published template contracts. A template that is live is
  versioned - add a new version, do not edit the published one.
