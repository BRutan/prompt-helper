// Path: frontend/src/input-preview.js
// Fast header-only preview. Full validation and splitting occur on submit.
// This expression scans frames without creating per-file source copies.
const FRAME = /^={8,}\r?\nSOURCE_DIR:[ \t]*[^\r\n]+\r?\nFILE:[ \t]*[^\r\n]+\r?\n={8,}(?:\r?\n|$)/gm;

export function countFramedFiles(text) {
  FRAME.lastIndex = 0;
  let count = 0;
  while (FRAME.exec(text) !== null) count++;
  FRAME.lastIndex = 0;
  return count;
}
