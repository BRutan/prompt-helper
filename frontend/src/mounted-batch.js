// Path: frontend/src/mounted-batch.js
// Self-contained parser used only by the mounted-upload entrypoint. Never
// performs a /batch-diff request or uses a guessed machine-local filepath.
const FRAME = /^={8,}\r?\nSOURCE_DIR:[ \t]*([^\r\n]+)\r?\nFILE:[ \t]*([^\r\n]+)\r?\n={8,}\r?\n/gm;
const encoder = new TextEncoder();

export function isMultiFileDump(text) {
  FRAME.lastIndex = 0;
  return FRAME.test(text);
}

function cleanPath(value, label) {
  const out = value.trim();
  if (!out || out.includes('\\') || out.includes('\0') || out.includes('://') ||
      out.includes('//') || out.split('/').includes('.') || out.split('/').includes('..') ||
      (out.endsWith('/') && out !== '/')) {
    throw Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return out;
}

// SOURCE_DIR + FILE are authoritative for framed dumps. Embedded Path headers
// are optional and never override the frame identity or change source bytes.
export function parseMultiFileDump(text) {
  FRAME.lastIndex = 0;
  const matches = [...text.matchAll(FRAME)];
  if (!matches.length) throw Error('No SOURCE_DIR / FILE frames found.');
  const seen = new Set();
  return matches.map((match, i) => {
    const dir = cleanPath(match[1], 'SOURCE_DIR');
    const file = cleanPath(match[2], 'FILE');
    if (!dir.startsWith('/') || file.startsWith('/')) {
      throw Error(`Section ${i + 1}: SOURCE_DIR must be absolute and FILE relative.`);
    }
    const path = `${dir === '/' ? '' : dir}/${file}`;
    if (seen.has(path)) throw Error(`Duplicate file: ${path}`);
    seen.add(path);
    const next = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const raw = text.slice(match.index + match[0].length, next);
    const source = raw.replace(/^\r?\n/, '').replace(/[\r\n]+$/, '') + '\n';
    return { path, source, bytes: encoder.encode(source).byteLength };
  });
}

export function mergeFileDiffResponses(responses) {
  const sorted = [...responses].sort((a, b) => a.path.localeCompare(b.path));
  const files = sorted.map(({ path, extension, status, version, sha256, additions, deletions }) =>
    ({ path, extension, status, version, sha256, additions, deletions }));
  const total = files.length;
  const unchanged = files.filter(file => file.status === 'unchanged').length;
  const changed = total - unchanged;
  const additions = files.reduce((count, file) => count + (file.additions || 0), 0);
  const deletions = files.reduce((count, file) => count + (file.deletions || 0), 0);
  const tree = ['SOURCE FILE TREE (absolute paths):'];
  let directory = '';
  for (const file of files) {
    const dirname = file.path.slice(0, file.path.lastIndexOf('/')) || '/';
    if (dirname !== directory) { tree.push(`${dirname}/`); directory = dirname; }
    tree.push(`  ${file.path.slice(file.path.lastIndexOf('/') + 1)} [v${file.version} ${file.status}]`);
  }
  const changedBlocks = sorted.filter(file => file.status !== 'unchanged')
    .map(file => `\n=== ${file.path} ===\n${file.llm_diff}\nVERSION v${file.version} | SHA256 ${file.sha256}\n`);
  return {
    files, total, changed, unchanged, additions, deletions,
    llm_diff: [
      `BATCH DIFF | ${total} files | ${changed} changed | ${unchanged} unchanged`,
      '', ...tree, '', 'CHANGED FILES (old/new line numbers):', ...changedBlocks, '',
    ].join('\n'),
    unified_diff: sorted.filter(file => file.status !== 'unchanged')
      .map(file => file.unified_diff).filter(Boolean).join('\n'),
  };
}
