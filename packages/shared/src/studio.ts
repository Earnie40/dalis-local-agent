/** Virtual browser files used by the isolated in-app studio. */
export interface StudioFiles {
  html: string;
  css: string;
  javascript: string;
}

/** Per-file request, response, persistence, and preview ceiling. */
export const STUDIO_MAX_FILE_CHARS = 60_000;

