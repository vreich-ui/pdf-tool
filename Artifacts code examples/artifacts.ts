export type ArtifactKind = "image" | "pdf" | "binary";

export interface ArtifactReference {
  projectId: string;
  requestId: string;
  artifactId: string;
  artifactKind: ArtifactKind;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  blobKey: string;
  tags: string[];
  label?: string;
  createdAt: string;
}
