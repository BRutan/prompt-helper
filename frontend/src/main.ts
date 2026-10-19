import './style.css';
import { renderDiff } from './renderDiff.js';

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
const submit = get<HTMLButtonElement>('submit');
const error = get<HTMLDivElement>('error');
const diff = get<HTMLDivElement>('diff');
const count = get<HTMLSpanElement>('input-count');
const lang = get<HTMLSpanElement>('input-lang');
const copy = get<HTMLButtonElement>('copy');
const extFilter = get<HTMLInputElement>('extension');
let llmOutput = '';

// This is only immediate user feedback. The Go API independently enforces
// supported extensions and comment leaders before persisting any data.
const comments: Record<string, [string,string]> = {};
for (const ext of ['.ts','.tsx','.js','.jsx','.mjs','.cjs','.go','.rs','.swift','.java','.c','.cc','.cpp','.h','.hpp','.cs','.kt','.kts','.scala','.php','.proto','.jsonc']) comments[ext] = ['//',''];
for (const ext of ['.py','.rb','.sh','.bash','.zsh','.yml','.yaml','.toml','.ini','.cfg','.conf','.mk','.tf','.tfvars','.graphql','.env','.gitignore']) comments[ext] = ['#',''];
for (const ext of ['.sql','.lua','.hs']) comments[ext] = ['--',''];
for (const ext of ['.css','.scss','.less']) comments[ext] = ['/*','*/'];
for (const ext of ['.html','.htm','.xml','.svg','.md','.mdx','.vue']) comments[ext] = ['<!--','-->'];

function validate(input: string): { path: string; ext: string } {
  const raw = input.replace(/^\uFEFF/, '').split('\n');
  const first = (raw[0] || '').startsWith('#!') ? raw[1] || '' : raw[0] || '';
  const match = first.replace(/\r$/, '').match(/^(<!--|\/\*|\/\/|--|#)[ \t]+Path:[ \t]+(.+?)\s*$/);
  if (!match) throw new Error('Missing first-line header: // Path: src/components/App.tsx (or the comment syntax for your extension).');
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
  if (spec[0] !== match[1]) throw new Error(`.${ext.replace('.', '')} files must start with a '${spec[0]} Path: ...${spec[1] ? ` ${spec[1]}` : ''}' comment.`);
  if (!p.includes('/') || p.includes('\\') || p.includes('/../') || p.includes('/./') || p.startsWith('../') || p.endsWith('/')) throw new Error('Path: must contain a complete directory-qualified slash-separated filename without traversal.');
  return { path: p, ext };
}

source.addEventListener('input', () => {
  count.textContent = `${source.value.length.toLocaleString()} chars`;
  try { const parsed = validate(source.value); lang.textContent = parsed.ext; }
  catch { lang.textContent = 'Awaiting valid path'; }
});

function setError(message: string) { error.textContent = message; error.hidden = false; }
function clearError() { error.hidden = true; error.textContent = ''; }

async function submitFile() {
  clearError();
  try { validate(source.value); }
  catch (e) { setError((e as Error).message); return; }
  submit.disabled = true;
  submit.textContent = 'Comparing…';
  try {
    const response = await fetch('/api/v1/files/diff', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: source.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const result = data as DiffResponse;
    get('result-status').textContent = result.status === 'created' ? 'Baseline stored' : result.status === 'updated' ? 'Changes stored' : 'Unchanged';
    get('result-version').textContent = `v${result.version}`;
    get('result-count').textContent = result.status === 'unchanged' ? '0 changes' : `+${result.additions} / −${result.deletions}`;
    get('result-path').textContent = `${result.path} · SHA256 ${result.sha256.slice(0, 12)}…`;
    renderDiff(diff, result.lines || []);
    llmOutput = result.status === 'unchanged'
      ? `FILE ${result.path} | UNCHANGED at v${result.version} | SHA256 ${result.sha256}\n`
      : `${result.llm_diff}\nVERSION v${result.version} | SHA256 ${result.sha256}\n`;
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
