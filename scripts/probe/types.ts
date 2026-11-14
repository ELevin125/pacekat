export interface ManifestEntry {
  endpoint: string;
  path: string;
  file: string | null;
  status: number;
  contentType: string;
  ms: number;
  error?: string;
}

export interface Manifest {
  ranAt: string;
  from: string;
  to: string;
  baseUrl: string;
  tokenShape: Record<string, string> | null;
  entries: ManifestEntry[];
}
