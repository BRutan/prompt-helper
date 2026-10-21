#!/usr/bin/env python3
"""
Path: plugins/install_chrome_plugin.py
Build then install/reload the unpacked extension in running macOS Chrome.

No Chromium, temporary Chrome profile, browser restart, or --load-extension
flags. Chrome installation uses its normal Developer mode UI via macOS
Accessibility automation (user approval may be necessary on first use).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys

from build_chrome import DEFAULT_OUT, SOURCE, build

SCRIPT = Path(__file__).with_suffix('.applescript')
EXTENSION_NAME = 'prompt-helper: Session Patches'


def install(output: Path, *, dry_run: bool = False) -> int:
    """Package before installing so an existing unpacked copy gets fresh code."""
    unpacked, archive = build(output)
    manifest = json.loads((SOURCE / 'manifest.json').read_text(encoding='utf-8'))
    name = str(manifest['name'])
    if not unpacked.is_dir() or not (unpacked / 'manifest.json').is_file():
        raise RuntimeError(f'Chrome extension build is missing: {unpacked}')
    command = ['osascript', str(SCRIPT), str(unpacked), name]
    if dry_run:
        print('DRY RUN: Chrome UI automation skipped; build is real.')
        print('Would use the currently open Google Chrome window (not Chromium).')
        print('Command:', ' '.join(repr(arg) for arg in command))
        return 0
    if platform.system() != 'Darwin':
        raise RuntimeError('install-chrome-plugin only supports macOS; use build-chrome-plugin elsewhere.')
    if shutil.which('osascript') is None:
        raise RuntimeError('osascript was not found; this requires macOS.')
    if not SCRIPT.is_file():
        raise RuntimeError(f'AppleScript installer not found: {SCRIPT}')
    # Do not call open -a or spawn a second Chrome. `pgrep` merely checks that
    # the real Google Chrome process is already present.
    running = subprocess.run(['pgrep', '-x', 'Google Chrome'], capture_output=True, text=True, check=False)
    if running.returncode != 0:
        raise RuntimeError('Google Chrome is not running. Open the normal Chrome browser and retry.')
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.returncode != 0:
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        print('Chrome has not confirmed the extension install/reload.', file=sys.stderr)
        print('macOS: allow Terminal/osascript under Privacy & Security > Accessibility and Automation.', file=sys.stderr)
        print(f'Manual fallback: chrome://extensions > Developer mode > Load unpacked > {unpacked}', file=sys.stderr)
        return result.returncode
    print('Chrome extension ready in the existing browser.')
    print('Unpacked directory:', unpacked)
    print('Distribution ZIP:', archive)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUT, help='Existing build-chrome-plugin output root')
    parser.add_argument('--dry-run', action='store_true', help='Build and show the Chrome operation without opening UI')
    args = parser.parse_args()
    try:
        return install(args.output.expanduser().resolve(), dry_run=args.dry_run)
    except (RuntimeError, ValueError, OSError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
