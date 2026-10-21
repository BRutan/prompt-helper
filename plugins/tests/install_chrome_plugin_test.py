"""
Path: plugins/tests/install_chrome_plugin_test.py
No-browser smoke tests for install-chrome-plugin (use unittest)."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

PLUGINS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGINS))
spec = importlib.util.spec_from_file_location('prompt_helper_install_chrome', PLUGINS / 'install_chrome_plugin.py')
installer = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_dry_run_builds_real_unpack_folder_without_invoking_chrome(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(installer.subprocess, 'run') as run:
                self.assertEqual(installer.install(Path(temp), dry_run=True), 0)
                run.assert_not_called()
            unpacked = Path(temp) / 'prompt-helper-chrome'
            self.assertTrue((unpacked / 'manifest.json').is_file())
            self.assertTrue((Path(temp) / 'prompt-helper-chrome.zip').is_file())

    def test_non_macos_rejects_gui_install_without_opening_chrome(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(installer.platform, 'system', return_value='Linux'):
                with patch.object(installer.subprocess, 'run') as run:
                    with self.assertRaisesRegex(RuntimeError, 'macOS'):
                        installer.install(Path(temp))
                    run.assert_not_called()

    def test_does_not_launch_browser_if_chrome_not_running(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(installer.platform, 'system', return_value='Darwin'):
                with patch.object(installer.shutil, 'which', return_value='/usr/bin/osascript'):
                    with patch.object(installer.subprocess, 'run') as run:
                        run.return_value.returncode = 1
                        with self.assertRaisesRegex(RuntimeError, 'Google Chrome is not running'):
                            installer.install(Path(temp))
                        self.assertEqual(run.call_args.args[0], ['pgrep', '-x', 'Google Chrome'])

    def test_existing_chrome_invokes_only_osascript(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(installer.platform, 'system', return_value='Darwin'):
                with patch.object(installer.shutil, 'which', return_value='/usr/bin/osascript'):
                    with patch.object(installer.subprocess, 'run') as run:
                        run.return_value.returncode = 0
                        run.return_value.stdout = 'LOADED prompt-helper\n'
                        run.return_value.stderr = ''
                        self.assertEqual(installer.install(Path(temp)), 0)
                        commands = [call.args[0] for call in run.call_args_list]
                        self.assertEqual(commands[0], ['pgrep', '-x', 'Google Chrome'])
                        self.assertEqual(commands[1][0], 'osascript')
                        self.assertEqual(commands[1][-1], 'prompt-helper: Session Patches')
                        self.assertEqual(len(commands), 2)


if __name__ == '__main__':
    unittest.main()
