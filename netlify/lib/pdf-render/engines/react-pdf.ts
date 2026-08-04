/**
 * react-pdf metadata: id/executedIn/publishGate/validateTemplate only. The full render-capable
 * engine (which dynamically imports @react-pdf/renderer, react, and — for webp transcoding —
 * sharp) lives in react-pdf-render.ts, imported only by pdf-render/render-registry.ts. See
 * pdfme.ts for the full rationale: mcp.ts's reachable graph only ever needs this half, and
 * without the split esbuild bundles the render-only dependencies into the MCP function anyway
 * (Netlify's bundler converts dynamic import() to require(), so a reachable-but-unused dynamic
 * import still gets bundled).
 */
import { validateDocTree } from "../doc-tree/validate.js";
import type { PdfRendererMetadata } from "../types.js";

export const reactPdfMetadata: PdfRendererMetadata = {
  id: "react-pdf",
  executedIn: "netlify",
  publishGate: "hard",
  validateTemplate: validateDocTree,
};
