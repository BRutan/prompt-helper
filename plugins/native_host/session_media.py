"""Path: plugins/native_host/session_media.py
macOS opt-in screenshot routing, backed by a per-user launchd watcher.
No network, privileged daemon, or third-party packages are required.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

LABEL = 'com.prompt_helper.session_media'
IDENTIFIER = re.compile(r'^[A-Za-z0-9_-]{1,200}$')
MEDIA_NAMES = re.compile(r'^(?:Screenshot|Screen Shot|Screen Recording|ScreenRecording|Bildschirmfoto|Capture d[’\']écran)\b', re.I)
MEDIA_EXTS = {'.png', '.jpeg', '.jpg', '.heic', '.mov', '.mp4'}


def config_file(home=None):
    return (home or Path.home()) / '.config' / 'prompt-helper' / 'session-media.json'


def repo_root():
    # Derived from the installed native host; never accept a path from web pages.
    return Path(__file__).resolve().parents[2]


def destination(repo=None):
    return (repo or repo_root()) / 'data' / 'session_media'


def run(*command, timeout=15):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f"{' '.join(command[:2])}: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout.strip()


def read_state(home=None):
    try:
        value = json.loads(config_file(home).read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(value, home=None):
    path = config_file(home)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix='.session-media-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def verify_folder(folder):
    if not isinstance(folder, str) or not folder or '\x00' in folder or not folder.startswith('/'):
        raise ValueError('Select an existing absolute Session Media folder.')
    candidate = Path(folder).expanduser()
    if candidate.is_symlink() or not candidate.is_dir():
        raise ValueError('Session Media folder must be an existing real directory (not a symlink).')
    resolved = candidate.resolve()
    if resolved == repo_root().resolve() or resolved == destination().resolve() or resolved.is_relative_to(destination().resolve()):
        raise ValueError('Choose a separate capture folder, outside data/session_media.')
    return resolved


def choose_folder():
    if sys.platform != 'darwin':
        raise RuntimeError('The macOS folder picker requires macOS.')
    path = run('osascript', '-e', 'POSIX path of (choose folder with prompt "Choose Session Media screenshot folder")', timeout=120)
    return str(verify_folder(path))


def screenshot_location():
    proc = subprocess.run(['defaults', 'read', 'com.apple.screencapture', 'location'],
                          capture_output=True, text=True, check=False, timeout=6)
    return proc.stdout.strip() if proc.returncode == 0 else None


def set_screenshot_location(folder):
    if folder is None:
        subprocess.run(['defaults', 'delete', 'com.apple.screencapture', 'location'],
                       capture_output=True, text=True, check=False, timeout=6)
    else:
        run('defaults', 'write', 'com.apple.screencapture', 'location', '-string', str(folder))
    # The system server rereads screencapture preferences after restart.
    subprocess.run(['killall', 'SystemUIServer'], capture_output=True, check=False, timeout=6)


def agent_plist(home=None):
    return (home or Path.home()) / 'Library' / 'LaunchAgents' / (LABEL + '.plist')


def install_agent(home=None):
    home = home or Path.home()
    path = agent_plist(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    logs = home / 'Library' / 'Logs' / 'prompt-helper'
    logs.mkdir(parents=True, exist_ok=True)
    definition = {
        'Label': LABEL,
        'ProgramArguments': [sys.executable, str(Path(__file__).resolve()), '--watch'],
        'RunAtLoad': True,
        'KeepAlive': True,
        'StandardOutPath': str(logs / 'session-media.log'),
        'StandardErrorPath': str(logs / 'session-media-error.log'),
        'ProcessType': 'Background',
    }
    with path.open('wb') as f:
        plistlib.dump(definition, f)
    target = f'gui/{os.getuid()}'
    subprocess.run(['launchctl', 'bootout', target + '/' + LABEL], capture_output=True, timeout=8, check=False)
    run('launchctl', 'bootstrap', target, str(path))


def uninstall_agent(home=None):
    target = f'gui/{os.getuid()}'
    subprocess.run(['launchctl', 'bootout', target + '/' + LABEL], capture_output=True, timeout=8, check=False)
    agent_plist(home).unlink(missing_ok=True)


def configure(enabled, folder=None):
    if sys.platform != 'darwin':
        raise RuntimeError('Aggregate Session Media requires macOS.')
    if not isinstance(enabled, bool):
        raise ValueError('enabled must be a boolean')
    previous = read_state()
    if enabled:
        root = verify_folder(folder)
        dest = destination()
        dest.mkdir(parents=True, exist_ok=True)
        existing_location = screenshot_location()
        original = previous.get('original_location') if previous.get('enabled') else existing_location
        state = {'enabled': True, 'folder': str(root), 'original_location': original}
        write_state(state)
        try:
            set_screenshot_location(root)
            install_agent()
        except Exception:
            # Avoid leaving a global screenshot redirect if launchd setup fails.
            write_state(previous)
            set_screenshot_location(existing_location)
            raise
    else:
        uninstall_agent()
        # Don't overwrite a screenshot setting the user changed independently.
        if previous.get('enabled') and screenshot_location() == previous.get('folder'):
            set_screenshot_location(previous.get('original_location'))
        state = {'enabled': False, 'folder': previous.get('folder', '')}
        write_state(state)
    return {'enabled': enabled, 'folder': state.get('folder', ''), 'repository_folder': str(destination())}


def session_from_url(url):
    """Whitelist host, protocol, and exact conversation URL shape."""
    try:
        parts = urlsplit(url)
        if parts.scheme != 'https' or parts.username or parts.password or parts.port:
            return None
        path = [p for p in parts.path.split('/') if p]
        if parts.hostname in ('chatgpt.com', 'chat.openai.com') and len(path) >= 2 and path[0] == 'c':
            candidate = path[1]
        elif parts.hostname == 'claude.ai' and len(path) >= 2 and path[0] == 'chat':
            candidate = path[1]
        else:
            return None
        return candidate if IDENTIFIER.fullmatch(candidate) else None
    except (TypeError, ValueError, AttributeError):
        return None


def active_chrome_session():
    """Read the *frontmost* Chrome tab at capture time, not an arbitrary tab."""
    if sys.platform != 'darwin':
        return None
    script = '''
    tell application "System Events"
      set appName to name of first application process whose frontmost is true
    end tell
    if appName is not "Google Chrome" and appName is not "Screenshot" and appName is not "ScreenCaptureUI" then return ""
    tell application "Google Chrome"
      if (count of windows) = 0 then return ""
      return URL of active tab of front window
    end tell
    '''
    try:
        return session_from_url(run('osascript', '-e', script, timeout=5))
    except (RuntimeError, subprocess.TimeoutExpired, OSError):
        return None


def is_media_file(path):
    return path.is_file() and not path.is_symlink() and path.suffix.lower() in MEDIA_EXTS and bool(MEDIA_NAMES.match(path.name))


def mirrored_file(source, session_id, target_root):
    """Atomic mirror; never overwrite prior screenshots with the same name."""
    if not session_id or not IDENTIFIER.fullmatch(session_id) or not is_media_file(source):
        return None
    target = target_root / session_id
    target.mkdir(parents=True, exist_ok=True)
    name = source.name
    out = target / name
    attempt = 2
    while out.exists():
        out = target / f'{source.stem} ({attempt}){source.suffix}'
        attempt += 1
    fd, name = tempfile.mkstemp(prefix='.capture-', suffix='.tmp', dir=target)
    try:
        with os.fdopen(fd, 'wb') as stream, source.open('rb') as src:
            shutil.copyfileobj(src, stream, length=1024 * 1024)
        shutil.copystat(source, name)
        os.replace(name, out)
    finally:
        Path(name).unlink(missing_ok=True)
    return out


def watch(interval=0.4):
    """Polling handles both Cmd-Shift-4 and Cmd-Shift-5 filenames.

    Existing files are ignored at process startup. Wait for two stable samples
    and an age cutoff so macOS has finished writing screenshot/recording files.
    """
    current_folder = None
    known = set()
    pending = {}
    while True:
        state = read_state()
        if not state.get('enabled'):
            return
        folder = Path(state.get('folder', ''))
        if folder != current_folder:
            current_folder = folder
            known = {p.name for p in folder.iterdir()} if folder.is_dir() else set()
            pending = {}
        if not folder.is_dir():
            time.sleep(interval)
            continue
        try:
            entries = list(folder.iterdir())
        except OSError:
            time.sleep(interval)
            continue
        for path in entries:
            if path.name in known or not is_media_file(path):
                continue
            try:
                st = path.stat()
            except OSError:
                continue
            # Remember the session when the new screenshot is FIRST observed.
            previous = pending.get(path.name)
            if previous is None:
                pending[path.name] = (st.st_size, st.st_mtime_ns, active_chrome_session(), 0)
                continue
            size, mtime, session, stable = previous
            if st.st_size != size or st.st_mtime_ns != mtime:
                pending[path.name] = (st.st_size, st.st_mtime_ns, session, 0)
                continue
            stable += 1
            pending[path.name] = (size, mtime, session, stable)
            cutoff = 5 if path.suffix.lower() in ('.mov', '.mp4') else 0.8
            if stable < 2 or time.time() - st.st_mtime < cutoff:
                continue
            if path.suffix.lower() in ('.mov', '.mp4'):
                # Don't copy partially written screen recordings.
                try:
                    check = subprocess.run(['lsof', '-t', '--', str(path)],
                                           capture_output=True, check=False, timeout=3)
                    if check.returncode == 0 and check.stdout.strip():
                        continue
                except (OSError, subprocess.TimeoutExpired):
                    continue
            # Files without an active saved conversation are still kept in the
            # user-selected capture folder, but never attached to another chat.
            if session:
                try:
                    mirrored_file(path, session, destination())
                except OSError as exc:
                    print(f'Mirror error for {path}: {exc}', file=sys.stderr, flush=True)
            known.add(path.name)
            pending.pop(path.name, None)
        time.sleep(interval)


def navigate_open_panel(session_id):
    """Navigate Chrome's *already open* macOS file picker, never select files.

    Needs macOS Accessibility permission; failure leaves the picker untouched.
    """
    if sys.platform != 'darwin' or not isinstance(session_id, str) or not IDENTIFIER.fullmatch(session_id):
        return {'navigated': False, 'reason': 'unsupported platform or conversation'}
    if not read_state().get('enabled'):
        return {'navigated': False, 'reason': 'Session Media disabled'}
    path = destination() / session_id
    path.mkdir(parents=True, exist_ok=True)
    # Paths are passed as argv, not interpolated into AppleScript source.
    script = '''
    on run argv
      set folderPath to item 1 of argv
      repeat 45 times
        tell application "System Events"
          if exists process "Google Chrome" then
            tell process "Google Chrome"
              if frontmost then
                try
                  set isOpenPanel to false
                  if exists sheet 1 of front window then
                    set panel to sheet 1 of front window
                    if exists button "Open" of panel or exists button "Choose" of panel then set isOpenPanel to true
                  end if
                  if exists button "Open" of front window and exists button "Cancel" of front window then set isOpenPanel to true
                  if isOpenPanel then
                    keystroke "g" using {command down, shift down}
                    delay 0.2
                    keystroke folderPath
                    key code 36
                    return "navigated"
                  end if
                end try
              end if
            end tell
          end if
        end tell
        delay 0.12
      end repeat
      return "no Chrome Open dialog detected"
    end run
    '''
    try:
        output = run('osascript', '-e', script, str(path), timeout=12)
        return {'navigated': output == 'navigated', 'reason': output, 'folder': str(path)}
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        return {'navigated': False, 'reason': str(exc)[:500], 'folder': str(path)}

if __name__ == '__main__':
    if len(sys.argv) == 2 and sys.argv[1] == '--watch':
        watch()
    else:
        raise SystemExit('Usage: session_media.py --watch')
