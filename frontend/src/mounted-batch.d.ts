// Path: frontend/src/mounted-batch.d.ts
export interface SourceSection { path: string; source: string; bytes: number }
export interface FileDiff {
  path: string; extension: string; status: 'created'|'updated'|'unchanged';
  version: number; sha256: string; additions: number; deletions: number;
  llm_diff: string; unified_diff: string;
}
export interface CombinedDiff {
  files: Array<Pick<FileDiff, 'path'|'extension'|'status'|'version'|'sha256'|'additions'|'deletions'>>;
  total: number; changed: number; unchanged: number; additions: number; deletions: number;
  llm_diff: string; unified_diff: string;
}
export function isMultiFileDump(text: string): boolean;
export function parseMultiFileDump(text: string): SourceSection[];
export function mergeFileDiffResponses(responses: FileDiff[]): CombinedDiff;
