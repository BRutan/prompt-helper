#!/usr/bin/env python3
"""Register a native Chrome host for this installed unpacked extension (macOS)."""
import argparse
import json
from pathlib import Path
import re
import shlex
import stat
import sys


def install(extension_id: str):
    if not re.fullmatch('[a-p]{32}', extension_id):
        raise ValueError('Extension ID must be 32 lowercase letters a-p from chrome://extensions')
    host_file = (Path(__file__).parent / 'runner.py').resolve()
    directory = Path.home() / 'Library/Application Support/Google/Chrome/NativeMessagingHosts'
    directory.mkdir(parents=True, exist_ok=True)
    wrapper = (Path(__file__).parent / 'run-native-host.sh').resolve()
    wrapper.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(host_file)) + '\n')
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
    name = 'com.prompt_helper.patch_runner'
    manifest = {'name': name, 'description': 'prompt-helper local Git patch applier',
                'path': str(wrapper), 'type': 'stdio',
                'allowed_origins': [f'chrome-extension://{extension_id}/']}
    path = directory / (name + '.json')
    path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Installed native host manifest: {path}')
    print('Reload the extension at chrome://extensions after installation.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extension-id', required=True)
    args = parser.parse_args()
    install(args.extension_id)
