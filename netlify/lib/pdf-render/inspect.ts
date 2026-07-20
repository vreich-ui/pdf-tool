/**
 * Heuristic page count via raw "/Type /Page" markers. Blind to compressed object streams
 * (pdfme output), so engines that know better report their own count. Used only by the
 * byte-level PDF edit stubs until a real pdf-lib inspection replaces it for all engines.
 */
export function countPdfPagesHeuristic(bytes: Buffer): number {
  const matches = bytes.toString("latin1").match(/\/Type\s*\/Page\b/g);
  return matches?.length ?? 0;
}
