#!/usr/bin/env python3
"""
Path: plugins/native_host/runner.py
Local Chrome Native Messaging host: validate and apply a downloaded Git patch.

No shell commands supplied by chatbot text are executed. Only git apply is used.
The browser must download the patch first; this host does not fetch URLs.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile

# import sibling module also when runner.py is loaded directly by importlib tests
sys.path.insert(0, str(Path(__file__).resolve().parent))
import session_media

MAX_MESSAGE = 1_048_576
MAX_PATCH_BYTES = 25 * 1024 * 1024
MAX_OUTPUT = 12_000


def run_git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(['git', '-C', str(repo), *args], capture_output=True,
                          text=True, timeout=60, check=False)


def patch_from_download(filename: str) -> tuple[bytes, str]:
    supplied = Path(filename).expanduser()
    if not supplied.is_absolute() or supplied.is_symlink() or not supplied.is_file():
        raise ValueError('Downloaded patch path must be an existing regular non-symlink file')
    download_root = (Path.home() / 'Downloads').resolve()
    resolved = supplied.resolve()
    if not resolved.is_relative_to(download_root):
        raise ValueError('Downloaded patch must be inside ~/Downloads (check Chrome download settings)')
    if resolved.stat().st_size > MAX_PATCH_BYTES:
        raise ValueError('Downloaded patch exceeds 25 MB')
    if resolved.suffix.lower() == '.zip':
        with zipfile.ZipFile(resolved) as archive:
            patches = [z for z in archive.infolist() if not z.is_dir() and
                       Path(z.filename).suffix.lower() in ('.patch', '.diff')]
            if len(patches) != 1:
                raise ValueError('ZIP must contain exactly one .patch or .diff file')
            entry = patches[0]
            if entry.file_size > MAX_PATCH_BYTES or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError('ZIP entry too large or unsafe')
            with archive.open(entry) as src:
                content = src.read(MAX_PATCH_BYTES + 1)
            return content, Path(entry.filename).name
    if resolved.suffix.lower() not in ('.patch', '.diff'):
        raise ValueError('Only .patch, .diff, or ZIP containing exactly one patch is supported')
    return resolved.read_bytes(), resolved.name



# Expand aliases ONLY in source lines of a Git patch, never in Git metadata,
# paths, comments or string literals. No chatbot-controlled shell commands.
_IDENTIFIER = re.compile(r'[A-Za-z_$][A-Za-z_0-9$]*')
_PATH_HEADER = re.compile(r'^\+\+\+ b/(.+)$')
_VALID_NAME = re.compile(r'^[A-Za-z_$][A-Za-z_0-9$]*$')
_SUPPORTED_EXTS = frozenset(('js','jsx','mjs','cjs','ts','tsx','py','go','swift',
                             'rs','java','kt','c','cc','cpp','cxx','h','hpp','cs'))
_META_PREFIXES = ('diff --git ', 'index ', 'new file mode ', 'deleted file mode ',
                  'rename ', 'similarity ', '--- ', '+++ ', '@@', '\\ No newline')


def _replace_identifiers(source: str, mappings: dict[str, str], dialect: str) -> str:
    if not mappings:
        return source
    if dialect != 'py' and re.match(r'^\s*#(?:include|define|if|elif|else|endif|pragma|import)\b', source):
        return source
    i = 0
    out = []
    quote = None
    block = False
    while i < len(source):
        ch = source[i]
        nxt = source[i + 1] if i + 1 < len(source) else ''
        if block:
            if ch == '*' and nxt == '/':
                out.append('*/'); i += 2; block = False
            else:
                out.append(ch); i += 1
            continue
        if quote:
            out.append(ch); i += 1
            if ch == '\\' and i < len(source):
                out.append(source[i]); i += 1
            elif ch == quote:
                quote = None
            continue
        if dialect != 'py' and ch == '/' and nxt == '/':
            out.append(source[i:]); break
        if dialect != 'py' and ch == '/' and nxt == '*':
            out.append('/*'); i += 2; block = True; continue
        if dialect == 'py' and ch == '#':
            out.append(source[i:]); break
        if ch in ('"', "'", '`'):
            quote = ch; out.append(ch); i += 1; continue
        match = _IDENTIFIER.match(source, i)
        if match:
            word = match.group()
            before = source[:i].rstrip()
            after = source[match.end():].lstrip()
            if before.endswith(('.', '@')) or after.startswith((':', '(')):
                out.append(word)
            else:
                out.append(mappings.get(word, word))
            i = match.end(); continue
        out.append(ch); i += 1
    return ''.join(out)


def restore_symbols_in_patch(patch_bytes: bytes, mapping: dict | None) -> bytes:
    if not mapping:
        return patch_bytes
    if not isinstance(mapping, dict) or len(mapping) > 2000:
        raise ValueError('Invalid symbol mapping')
    validated = {}
    for filename, aliases in mapping.items():
        if not isinstance(filename, str) or not isinstance(aliases, dict) or len(aliases) > 30000:
            raise ValueError('Invalid per-file alias mapping')
        if not filename or '\x00' in filename or filename.startswith('/') or '..' in filename.split('/'):
            raise ValueError('Invalid mapped path')
        if any(not isinstance(k, str) or not isinstance(v, str) or
               not _VALID_NAME.fullmatch(k) or not _VALID_NAME.fullmatch(v)
               for k, v in aliases.items()):
            raise ValueError('Invalid symbol alias')
        validated[filename] = aliases
    text = patch_bytes.decode('utf-8')
    result = []
    filename = None
    for line in text.splitlines(keepends=True):
        core = line.rstrip('\r\n')
        tail = line[len(core):]
        filematch = _PATH_HEADER.match(core)
        if filematch:
            filename = filematch.group(1)
        if core.startswith(_META_PREFIXES) or not filename or not core or core[0] not in (' ', '+', '-'):
            result.append(line); continue
        extension = filename.rsplit('.', 1)[-1].lower()
        if extension not in _SUPPORTED_EXTS:
            result.append(line); continue
        rest = _replace_identifiers(core[1:], validated.get(filename, {}), extension)
        result.append(core[0] + rest + tail)
    return ''.join(result).encode('utf-8')

def apply_download(repo_path: str, filename: str, symbol_mapping: dict | None = None) -> dict:
    repo = Path(repo_path).expanduser()
    if not repo.is_absolute() or not repo.is_dir():
        raise ValueError('Target repository must be an absolute existing directory')
    repo = repo.resolve()
    root = run_git(repo, 'rev-parse', '--show-toplevel')
    if root.returncode or Path(root.stdout.strip()).resolve() != repo:
        raise ValueError('Target must be the Git repository root, not a subdirectory')
    data, patch_name = patch_from_download(filename)
    data = restore_symbols_in_patch(data, symbol_mapping)
    if not data or len(data) > MAX_PATCH_BYTES or not (b'diff --git ' in data or
            (b'--- ' in data and b'+++ ' in data)):
        raise ValueError('Downloaded file does not contain a recognizable Git diff')
    # A per-repo flock prevents simultaneous check/apply races from different tabs.
    lock_dir = Path.home() / '.cache' / 'prompt-helper' / 'locks'
    lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_name = hashlib.sha256(str(repo).encode()).hexdigest() + '.lock'
    with open(lock_dir / lock_name, 'a+b') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        with tempfile.NamedTemporaryFile(prefix='prompt-helper-', suffix='.patch', delete=False) as tmp:
            patch_temp = Path(tmp.name)
            tmp.write(data)
        try:
            preflight = run_git(repo, 'apply', '--check', str(patch_temp))
            if preflight.returncode:
                return {'ok': False, 'stage': 'git apply --check', 'exit_code': preflight.returncode,
                        'output': (preflight.stdout + preflight.stderr)[-MAX_OUTPUT:], 'filename': patch_name}
            applied = run_git(repo, 'apply', str(patch_temp))
            if applied.returncode:
                return {'ok': False, 'stage': 'git apply', 'exit_code': applied.returncode,
                        'output': (applied.stdout + applied.stderr)[-MAX_OUTPUT:], 'filename': patch_name}
            return {'ok': True, 'stage': 'git apply', 'exit_code': 0, 'filename': patch_name,
                    'repo': str(repo), 'output': (applied.stdout + applied.stderr)[-MAX_OUTPUT:]}
        finally:
            patch_temp.unlink(missing_ok=True)


def handle(request: dict) -> dict:
    action = request.get('action')
    if action in ('session_media_status', 'session_media_choose_folder',
                  'session_media_configure', 'session_media_upload_dialog'):
        try:
            if action == 'session_media_status':
                state = session_media.read_state()
                return {'ok': True, 'enabled': bool(state.get('enabled')),
                        'folder': state.get('folder', ''),
                        'repository_folder': str(session_media.destination())}
            if action == 'session_media_choose_folder':
                return {'ok': True, 'folder': session_media.choose_folder()}
            if action == 'session_media_configure':
                return {'ok': True, **session_media.configure(request.get('enabled'), request.get('folder'))}
            if action == 'session_media_upload_dialog':
                return {'ok': True, **session_media.navigate_open_panel(request.get('conversation_id'))}
        except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
            return {'ok': False, 'error': str(exc)[:MAX_OUTPUT]}
    if action != 'apply_patch':
        return {'ok': False, 'error': 'Unsupported native action'}
    repo, path = request.get('repo_path'), request.get('download_path')
    if not isinstance(repo, str) or not isinstance(path, str):
        return {'ok': False, 'error': 'repo_path and download_path are required strings'}
    try:
        return apply_download(repo, path, request.get('symbol_mapping'))
    except (ValueError, OSError, zipfile.BadZipFile, subprocess.TimeoutExpired) as exc:
        return {'ok': False, 'stage': 'validation', 'error': str(exc)[:MAX_OUTPUT]}


def read_message():
    head = sys.stdin.buffer.read(4)
    if not head:
        return None
    if len(head) != 4:
        raise ValueError('Truncated native message length')
    length = struct.unpack('<I', head)[0]
    if length > MAX_MESSAGE:
        raise ValueError('Native message exceeds 1 MB')
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise ValueError('Truncated native message')
    return json.loads(payload)


def send_message(response):
    data = json.dumps(response).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(data)) + data)
    sys.stdout.buffer.flush()


def main():
    while True:
        try:
            message = read_message()
            if message is None:
                break
            send_message(handle(message))
        except Exception as exc:
            send_message({'ok': False, 'error': f'Native host failed: {exc}'[:MAX_OUTPUT]})
            break


if __name__ == '__main__':
    main()
