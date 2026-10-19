// Path: frontend/src/mounted-main.ts
import './style.css';
import './input-controls.css';
import { countFramedFiles } from './input-preview.js';
import { renderDiff } from './renderDiff.js';
import { isMultiFileDump, parseMultiFileDump, mergeFileDiffResponses } from './mounted-batch.js';

type DiffLine = { kind: string; old_line: number | null; new_line: number | null; text: string };
type DiffResponse = {
  path: string; extension: string; status: 'created' | 'updated' | 'unchanged';
  version: number; sha256: string; previous_sha256?: string;
  unified_diff: string; llm_diff: string; lines: DiffLine[];
  additions: number; deletions: number;
};
type FilesResponse = { files: Array<{ path: string; extension: string; version: number; updated_at: string }> };

function get<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw Error(`Missing DOM element ${id}`);
  return node as T;
}
const source = get<HTMLTextAreaElement>('source');
// Code-editor behavior: avoid costly soft-wrap layout on very long pasted lines.
source.wrap = 'off';
const submit = get<HTMLButtonElement>('submit');
const error = get<HTMLDivElement>('error');
const diff = get<HTMLDivElement>('diff');
const count = get<HTMLSpanElement>('input-count');
const lang = get<HTMLSpanElement>('input-lang');
const copy = get<HTMLButtonElement>('copy');
const extFilter = get<HTMLInputElement>('extension');
let llmOutput = '';

// Install controls without changing the existing HTML or replacing user layouts.
function control(label: string, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  return button;
}

const sourceClear = control('Clear', 'Clear file input');
const sourceCopy = control('Copy', 'Copy file input');
const llmClear = control('Clear', 'Clear LLM output');
const sourceLabel = document.querySelector<HTMLLabelElement>('label[for="source"]');
if (sourceLabel?.parentElement) {
  const toolbar = document.createElement('div');
  toolbar.className = 'source-toolbar';
  sourceLabel.parentElement.insertBefore(toolbar, sourceLabel);
  const actions = document.createElement('div');
  actions.className = 'toolbar-actions';
  toolbar.append(sourceLabel, actions);
  actions.append(sourceCopy, sourceClear);
}
if (copy.parentElement) {
  const actions = document.createElement('div');
  actions.className = 'toolbar-actions';
  copy.parentElement.insertBefore(actions, copy);
  actions.append(copy, llmClear);
}

sourceClear.addEventListener('click', () => {
  source.value = '';
  source.dispatchEvent(new Event('input'));
  clearError();
});
sourceCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(source.value);
    sourceCopy.textContent = 'Copied!';
    setTimeout(() => { sourceCopy.textContent = 'Copy'; }, 1200);
  } catch (e) { setError(`Could not copy file input: ${(e as Error).message}`); }
});
llmClear.addEventListener('click', () => {
  llmOutput = '';
  copy.disabled = true;
  get('result-status').textContent = 'No comparison yet';
  get('result-version').textContent = '—';
  get('result-count').textContent = '—';
  get('result-path').textContent = 'Submit a file to create its baseline.';
  const placeholder = document.createElement('div');
  placeholder.className = 'diff-empty';
  placeholder.textContent = 'Changed lines will appear here with old and new line numbers in the gutter.';
  diff.replaceChildren(placeholder);
});


// The browser splits multi-file dumps before making any HTTP requests.

// This is only immediate user feedback. The Go API independently enforces
// supported extensions and comment leaders before persisting any data.
const comments: Record<string, [string,string]> = {};
for (const ext of ['.ts','.tsx','.js','.jsx','.mjs','.cjs','.go','.rs','.swift','.java','.c','.cc','.cpp','.h','.hpp','.cs','.kt','.kts','.scala','.php','.proto','.jsonc']) comments[ext] = ['//',''];
for (const ext of ['.py','.rb','.sh','.bash','.zsh','.yml','.yaml','.toml','.ini','.cfg','.conf','.mk','.tf','.tfvars','.graphql','.env','.gitignore']) comments[ext] = ['#',''];
for (const ext of ['.sql','.lua','.hs']) comments[ext] = ['--',''];
for (const ext of ['.css','.scss','.less']) comments[ext] = ['/*','*/'];
for (const ext of ['.html','.htm','.xml','.svg','.md','.mdx','.vue']) comments[ext] = ['<!--','-->'];

function validate(input: string): { path: string; ext: string } {
  // Only inspect the header; splitting a multi-megabyte input allocates huge arrays.
  const raw = input.replace(/^\uFEFF/, '').slice(0, 4096).split('\n', 2);
  const first = (raw[0] || '').startsWith('#!') ? raw[1] || '' : raw[0] || '';
  const match = first.replace(/\r$/, '').match(/^(?:(<!--|\/\*|\/\/|--|#)[ \t]+)?Path:[ \t]+(.+?)\s*$/);
  if (!match) throw new Error('Missing first-line header: Path: src/components/App.tsx (or // Path: ... / another supported comment format).');
  let p = match[2].trim();
  let ext = p.slice(p.lastIndexOf('.')).toLowerCase();
  if (/\/(?:Dockerfile(?:\.[^/]*)?|Makefile|GNUmakefile)$/i.test(p)) ext = '.mk';
  if (/\/(?:\.env(?:\.[^/]*)?|\.gitignore|\.dockerignore)$/.test(p)) ext = p.includes('/.env') ? '.env' : '.gitignore';
  const spec = comments[ext];
  if (!spec) throw new Error(`Unsupported file extension ${ext}. Strict JSON does not support comments; use .jsonc.`);
  if (spec[1]) {
    if (!p.endsWith(spec[1])) throw new Error(`Expected a ${spec[0]} Path: ... ${spec[1]} header.`);
    p = p.slice(0, -spec[1].length).trim();
  }
  if (match[1] && spec[0] !== match[1]) throw new Error(`.${ext.replace('.', '')} files must start with a '${spec[0]} Path: ...${spec[1] ? ` ${spec[1]}` : ''}' comment.`);
  if (!p.includes('/') || p.includes('\\') || p.includes('/../') || p.includes('/./') || p.startsWith('../') || p.endsWith('/')) throw new Error('Path: must contain a complete directory-qualified slash-separated filename without traversal.');
  return { path: p, ext };
}

// Never parse or scan a multi-megabyte paste synchronously in its input event.
// Debouncing also avoids repeated work during typing and repeated pastes.
let previewTimer: ReturnType<typeof setTimeout> | undefined;
function refreshInputPreview() {
  previewTimer = undefined;
  const value = source.value;
  count.textContent = `${value.length.toLocaleString()} chars`;
  const framedFiles = countFramedFiles(value);
  if (framedFiles) {
    lang.textContent = `Batch · ${framedFiles} files`;
  } else {
    try { lang.textContent = validate(value).ext; }
    catch { lang.textContent = 'Awaiting valid path'; }
  }
}
source.addEventListener('input', () => {
  // These constant-time updates are safe even for a very large paste.
  const hasText = source.value.length !== 0;
  sourceClear.disabled = !hasText;
  sourceCopy.disabled = !hasText;
  if (previewTimer !== undefined) clearTimeout(previewTimer);
  // Yield to the browser so it can paint the pasted text before scanning it.
  previewTimer = setTimeout(refreshInputPreview, hasText ? 350 : 0);
});
source.dispatchEvent(new Event('input'));

function setError(message: string) { error.textContent = message; error.hidden = false; }
function clearError() { error.hidden = true; error.textContent = ''; }

// Avoid depending on the previous frontend API helper or whether that patch applied.
async function apiFetchJSON<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const method = options.method || 'GET';
  let response: Response;
  try {
    response = await fetch(endpoint, options);
  } catch (cause) {
    throw Error(`${method} ${endpoint}: ${String(cause)}`);
  }
  const body = await response.text();
  const type = response.headers.get('content-type') || '';
  const context = `${method} ${endpoint}: HTTP ${response.status}`;
  if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(type)) {
    throw Error(`${context} returned ${type || 'no content-type'}: ${body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 350)}`);
  }
  let json: any;
  try { json = JSON.parse(body); }
  catch { throw Error(`${context}: invalid JSON body`); }
  if (!response.ok) throw Error(`${context}: ${json?.error || response.statusText}`);
  return json as T;
}

// The browser cannot write a Docker bind mount directly. It streams each
// parsed source to the frontend container's upload writer, which saves it in
// ./data/uploads and responds with only a timestamped filename.
async function uploadSource(content: string): Promise<string> {
  const result = await apiFetchJSON<{ filename: string; bytes: number }>('/upload/file', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: content,
  });
  if (!/^\d{8}T\d{9}Z-[0-9a-f]{32}\.txt$/.test(result.filename || '')) {
    throw Error('Upload writer returned an invalid timestamped filename.');
  }
  return result.filename;
}

async function processSavedSource(content: string, path?: string): Promise<DiffResponse> {
  const filename = await uploadSource(content);
  try {
    const result = await apiFetchJSON<DiffResponse>('/api/v1/files/process-upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, ...(path ? { path } : {}) }),
    });
    if (path && result.path !== path) {
      throw Error(`Backend returned ${result.path} instead of ${path}`);
    }
    return result;
  } catch (error) {
    // Keep filename in the visible error so the saved input can be inspected.
    throw Error(`data/uploads/${filename}: ${(error as Error).message}`);
  }
}

async function submitFile() {
  clearError();
  const batchMode = isMultiFileDump(source.value);
  let sections: ReturnType<typeof parseMultiFileDump> = [];
  try {
    if (batchMode) sections = parseMultiFileDump(source.value).sort((a, b) => b.bytes - a.bytes);
    else validate(source.value);
  } catch (e) { setError((e as Error).message); return; }
  submit.disabled = true;
  submit.textContent = 'Saving…';
  try {
    if (batchMode) {
      // Archive the *exact* original paste, including SOURCE_DIR / FILE frames.
      const originalFilename = await uploadSource(source.value);
      // One saved source file and one DB transaction per backend request.
      // No /batch-diff requests. Two independent workers at most.
      const responses: Array<DiffResponse | undefined> = new Array(sections.length);
      const failures: string[] = [];
      let next = 0;
      let completed = 0;
      let stopped = false;
      const worker = async () => {
        while (!stopped) {
          const index = next++;
          if (index >= sections.length) return;
          const section = sections[index];
          submit.textContent = `Saved/compared ${completed}/${sections.length} files`;
          try {
            const result = await processSavedSource(section.source, section.path);
            responses[index] = result;
            completed++;
            submit.textContent = `Saved/compared ${completed}/${sections.length} files`;
          } catch (e) {
            stopped = true;
            failures.push(`${section.path}: ${(e as Error).message}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, sections.length) }, () => worker()));
      const saved = responses.filter((item): item is DiffResponse => item !== undefined);
      if (saved.length) {
        const result = mergeFileDiffResponses(saved);
        get('result-status').textContent = failures.length
          ? `Partial: ${result.total}/${sections.length} confirmed`
          : `${result.changed} changed / ${result.unchanged} unchanged`;
        get('result-version').textContent = `${result.total} files`;
        get('result-count').textContent = `+${result.additions} / −${result.deletions}`;
        get('result-path').textContent = `${result.total} full paths · original: data/uploads/${originalFilename}`;
        const pre = document.createElement('pre');
        pre.className = 'batch-diff';
        pre.textContent = result.llm_diff;
        diff.replaceChildren(pre);
        llmOutput = result.llm_diff;
        copy.disabled = false;
      }
      if (failures.length) {
        throw Error(`Stopped after ${saved.length}/${sections.length} confirmed file requests; ` +
          `failed requests were not retried because they may have committed: ${failures.join('\n')}`);
      }
    } else {
      const result = await processSavedSource(source.value);
      get('result-status').textContent = result.status === 'created' ? 'Baseline stored' : result.status === 'updated' ? 'Changes stored' : 'Unchanged';
      get('result-version').textContent = `v${result.version}`;
      get('result-count').textContent = result.status === 'unchanged' ? '0 changes' : `+${result.additions} / −${result.deletions}`;
      get('result-path').textContent = `${result.path} · SHA256 ${result.sha256.slice(0, 12)}…`;
      renderDiff(diff, result.lines || []);
      llmOutput = result.status === 'unchanged'
        ? `FILE ${result.path} | UNCHANGED at v${result.version} | SHA256 ${result.sha256}\n`
        : `${result.llm_diff}\nVERSION v${result.version} | SHA256 ${result.sha256}\n`;
    }
    copy.disabled = false;
    void refreshFiles();
  } catch (e) { setError((e as Error).message); }
  finally { submit.disabled = false; submit.innerHTML = 'Store &amp; compare <span>⌘ ↵</span>'; }
}

submit.addEventListener('click', () => void submitFile());
source.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault(); void submitFile();
  }
});
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(llmOutput);
    copy.textContent = 'Copied!';
    setTimeout(() => { copy.textContent = 'Copy for LLM'; }, 1200);
  } catch (e) { setError(`Clipboard unavailable: ${(e as Error).message}`); }
});

const examples: Record<string,string> = {
  ts: '// Path: src/components/App.tsx\nexport function App() {\n  return "hello";\n}\n',
  py: '# Path: jobs/random_transaction/ingest.py\ndef main():\n    print("hello")\n',
  sql: '-- Path: db/migrations/002_tables.sql\nCREATE TABLE example (id bigint PRIMARY KEY);\n',
  css: '/* Path: src/styles/main.css */\nbody { color: #e7ebf2; }\n',
};
document.querySelectorAll<HTMLButtonElement>('[data-example]').forEach(button => {
  button.addEventListener('click', () => {
    source.value = examples[button.dataset.example || 'ts'];
    source.dispatchEvent(new Event('input'));
    source.focus();
  });
});

async function refreshFiles() {
  const params = new URLSearchParams({ limit: '30' });
  if (extFilter.value.trim()) params.set('extension', extFilter.value.trim());
  const container = get('recent');
  try {
    const response = await fetch(`/api/v1/files?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as FilesResponse;
    container.replaceChildren();
    if (!data.files.length) { container.textContent = 'No files found.'; return; }
    for (const file of data.files) {
      const row = document.createElement('button');
      row.className = 'recent-file';
      const name = document.createElement('span'); name.textContent = file.path;
      const details = document.createElement('span'); details.className = 'recent-detail';
      details.textContent = `${file.extension} · v${file.version}`;
      row.append(name,details);
      row.addEventListener('click', async () => {
        try {
          const resp = await fetch(`/api/v1/files/current?path=${encodeURIComponent(file.path)}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const obj = await resp.json() as { content: string };
          source.value = obj.content;
          source.dispatchEvent(new Event('input'));
          source.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch(e) { setError(`Could not load file: ${(e as Error).message}`); }
      });
      container.append(row);
    }
  } catch (e) { container.textContent = `Could not load history: ${(e as Error).message}`; }
}
get('refresh').addEventListener('click', () => void refreshFiles());
extFilter.addEventListener('keydown', event => { if (event.key === 'Enter') void refreshFiles(); });
void refreshFiles();
