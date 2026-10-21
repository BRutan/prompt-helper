"""Regression tests for installing the MV3 extension through running Chrome."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('chrome_live', ROOT / 'plugins/chrome_live.py')
chrome_live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chrome_live)


class FirstInstallTests(unittest.TestCase):
    def base_mocks(self):
        return (
            patch.object(chrome_live, 'build', return_value=(Path('/my/extension'), Path('/my/extension.zip'))),
            patch.object(chrome_live.sys, 'platform', 'darwin'),
            patch.object(chrome_live, '_running', return_value=True),
            patch.object(chrome_live, '_clipboard', return_value=True),
            patch.object(chrome_live.shutil, 'which', return_value='/usr/bin/osascript'),
        )

    def test_first_install_drives_existing_browser_and_checks_registration(self):
        with (self.base_mocks()[0], self.base_mocks()[1], self.base_mocks()[2],
              self.base_mocks()[3], self.base_mocks()[4],
              patch.object(chrome_live, 'installed_profiles', side_effect=[[], [], [{'profile': 'Default', 'id': 'abcd'}]]),
              patch.object(chrome_live.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'submitted', '')) as run):
            self.assertEqual(chrome_live.install(Path('/dist')), 0)
            args = run.call_args.args[0]
            self.assertEqual(args[0], 'osascript')
            self.assertTrue(args[1].endswith('chrome_first_install.applescript'))
            self.assertEqual(args[2], '/my/extension')

    def test_failure_is_not_reported_as_success(self):
        with (self.base_mocks()[0], self.base_mocks()[1], self.base_mocks()[2],
              self.base_mocks()[3], self.base_mocks()[4],
              patch.object(chrome_live, 'installed_profiles', return_value=[]),
              patch.object(chrome_live.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'AX denied'))):
            with self.assertRaisesRegex(RuntimeError, 'AX denied'):
                chrome_live.install(Path('/dist'))

    def test_existing_install_skips_accessibility(self):
        with (self.base_mocks()[0], self.base_mocks()[1], self.base_mocks()[2],
              patch.object(chrome_live, 'installed_profiles', return_value=[{'profile': 'Default', 'id': 'abcd', 'enabled': True}]),
              patch.object(chrome_live.subprocess, 'run') as run):
            self.assertEqual(chrome_live.install(Path('/dist')), 0)
            run.assert_not_called()

    def test_dry_run_skips_ui(self):
        with patch.object(chrome_live, 'build', return_value=(Path('/extension'), Path('/archive'))), \
             patch.object(chrome_live, '_running') as running:
            self.assertEqual(chrome_live.install(Path('/dist'), dry_run=True), 0)
            running.assert_not_called()

    def test_no_open_skips_ui(self):
        with (self.base_mocks()[0], self.base_mocks()[1], self.base_mocks()[2],
              self.base_mocks()[3], self.base_mocks()[4],
              patch.object(chrome_live, 'installed_profiles', return_value=[]),
              patch.object(chrome_live.subprocess, 'run') as run):
            self.assertEqual(chrome_live.install(Path('/dist'), no_open=True), 0)
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
