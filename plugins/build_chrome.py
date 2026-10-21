#!/usr/bin/env python3
"""Build an installable unpacked MV3 extension and its ZIP distribution."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'plugins' / 'chrome'
DEFAULT_OUT = ROOT / 'dist' / 'chrome'
REQUIRED = ('manifest.json', 'session.js', 'background.js', 'content.js', 'delivery-content.js', 'response-monitor.js', 'dashboard-bridge.js', 'popup.html', 'popup.js', 'package.json', 'symbol-compression.js')


def build(destination: Path) -> tuple[Path, Path]:
    manifest = json.loads((SOURCE / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('manifest_version') != 3:
        raise SystemExit('Chrome extension must use Manifest V3')
    for name in REQUIRED:
        if not (SOURCE / name).is_file():
            raise SystemExit(f'Missing Chrome extension source: {name}')
    destination = destination.expanduser().resolve()
    unpacked = destination / 'prompt-helper-chrome'
    archive = destination / 'prompt-helper-chrome.zip'
    if unpacked.exists():
        shutil.rmtree(unpacked)
    unpacked.mkdir(parents=True, exist_ok=True)
    for name in REQUIRED:
        shutil.copy2(SOURCE / name, unpacked / name)
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
        for name in REQUIRED:
            zipped.write(unpacked / name, arcname=name)
    print(f'Unpacked Chrome extension: {unpacked}')
    print(f'ZIP distributable:        {archive}')
    return unpacked, archive


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUT,
                        help='Directory containing the unpacked extension and ZIP')
    args = parser.parse_args()
    build(args.output)
