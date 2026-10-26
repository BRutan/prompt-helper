"""Regression tests for stable-path Chrome extension packaging and profile detection."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('chrome_live', ROOT / 'plugins/chrome_live.py')
chrome_live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chrome_live)


class ChromeHotTests(unittest.TestCase):
    def test_builder_retains_directory_updates_marker_and_zips_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            source = directory / 'source'
            source.mkdir()
            for name in chrome_live.SOURCE_FILES:
                (source / name).write_text('{"manifest_version":3}' if name == 'manifest.json' else 'example')
            with patch.object(chrome_live, 'SOURCE', source):
                dest = directory / 'dist'
                first, archive = chrome_live.build(dest)
                sentinel = first / 'user-custom-file'
                sentinel.write_text('preserve me')
                one = json.loads((first / 'build.json').read_text())['build_id']
                second, archive = chrome_live.build(dest)
                two = json.loads((second / 'build.json').read_text())['build_id']
            self.assertEqual(first, second)
            self.assertEqual(sentinel.read_text(), 'preserve me')
            self.assertNotEqual(one, two)
            with __import__('zipfile').ZipFile(archive) as bundle:
                self.assertIn('build.json', bundle.namelist())
                self.assertIn('build-watch.js', bundle.namelist())
                self.assertIn('session-preview.html', bundle.namelist())
                self.assertIn('session-preview.js', bundle.namelist())
                for retired in chrome_live.RETIRED_AUTOMATION_FILES:
                    self.assertNotIn(retired, bundle.namelist())

    def test_build_retires_old_automation_modules_without_touching_other_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp)
            unpacked = destination / chrome_live.EXTENSION_FOLDER
            unpacked.mkdir()
            for name in chrome_live.RETIRED_AUTOMATION_FILES:
                (unpacked / name).write_text('unsafe legacy automation')
            preserved = unpacked / 'user-custom-file'
            preserved.write_text('keep this')
            chrome_live.build(destination)
            self.assertEqual(preserved.read_text(), 'keep this')
            for name in chrome_live.RETIRED_AUTOMATION_FILES:
                self.assertFalse((unpacked / name).exists(), name)
            self.assertTrue((unpacked / 'session-preview.html').is_file())
            self.assertTrue((unpacked / 'session-preview.js').is_file())

    def test_profile_detection_reads_preferences_without_editing_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            profile = home / 'Library/Application Support/Google/Chrome/Default'
            profile.mkdir(parents=True)
            unpacked = home / 'dist/prompt-helper-chrome'
            unpacked.mkdir(parents=True)
            prefs = {'profile': {'name': 'Personal'}, 'extensions': {'settings': {
                'a' * 32: {'path': str(unpacked), 'state': 1}
            }}}
            (profile / 'Preferences').write_text(json.dumps(prefs))
            with patch.object(chrome_live.sys, 'platform', 'darwin'):
                loaded = chrome_live.installed_profiles(unpacked, home=home)
            self.assertEqual(len(loaded), 1)
            self.assertEqual(loaded[0]['profile'], 'Personal')
            self.assertTrue(loaded[0]['enabled'])

    def test_install_dry_run_does_not_touch_chrome(self):
        with patch.object(chrome_live, 'build', return_value=(Path('/extension'), Path('/archive'))), \
             patch.object(chrome_live, '_running') as running:
            self.assertEqual(chrome_live.install(Path('/unused'), dry_run=True), 0)
            running.assert_not_called()


if __name__ == '__main__':
    unittest.main()
