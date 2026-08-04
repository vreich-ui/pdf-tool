import { pdfmeEngine } from "./engines/pdfme-render.js";
import { reactPdfEngine } from "./engines/react-pdf-render.js";
import { typstEngine } from "./engines/typst.js";
import { chromiumEngine } from "./engines/chromium.js";
import type { PdfRendererEngine, PdfRendererId } from "./types.js";

/**
 * The FULL, render-capable registry. Deliberately a separate module from registry.ts: this is
 * the only place in the codebase that imports the heavy render halves of pdfme and react-pdf
 * (pdfme-render.ts / react-pdf-render.ts), and it is imported ONLY by pdf-render/render.ts —
 * which is in turn imported only by the worker functions (agent-artifact-worker-background.ts,
 * agent-pdf-editing.ts, pdf-template-validation-worker.ts), never by mcp.ts. Keeping this
 * import confined here is what keeps @pdfme/generator and @react-pdf/renderer out of the MCP
 * function bundle. See engines/pdfme.ts and engines/react-pdf.ts for the lightweight metadata
 * registry (registry.ts) that mcp.ts-reachable code uses instead.
 */
const engines: PdfRendererEngine[] = [pdfmeEngine, reactPdfEngine, typstEngine, chromiumEngine];

export function getPdfRendererEngine(id: PdfRendererId): PdfRendererEngine | undefined {
  return engines.find((engine) => engine.id === id);
}
