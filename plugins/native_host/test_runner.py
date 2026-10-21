import importlib.util
from pathlib import Path
import os
import subprocess
import tempfile
import unittest
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runner', Path(__file__).with_name('runner.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class NativeRunnerTest(unittest.TestCase):
    def test_patch_and_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / 'repo'; repo.mkdir()
            subprocess.run(['git', '-C', str(repo), 'init', '-q'], check=True)
            (repo / 'a.txt').write_text('old\n')
            subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
            patch_text = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n'
            downloads = base / 'Downloads'; downloads.mkdir()
            patched = downloads / 'change.patch'; patched.write_text(patch_text)
            with patch.object(runner.Path, 'home', return_value=base):
                applied = runner.apply_download(str(repo), str(patched))
                self.assertTrue(applied['ok'], applied)
                self.assertEqual((repo / 'a.txt').read_text(), 'new\n')
                again = runner.apply_download(str(repo), str(patched))
                self.assertFalse(again['ok'])
                self.assertEqual(again['stage'], 'git apply --check')
                with zipfile.ZipFile(downloads / 'bundle.zip', 'w') as z:
                    z.writestr('changes.patch', patch_text)
                self.assertEqual(runner.patch_from_download(str(downloads / 'bundle.zip'))[0], patch_text.encode())
                self.assertFalse(runner.handle({'action':'command', 'command':'rm -rf /'})['ok'])
                outside = base / 'outside.patch';outside.write_text(patch_text)
                with self.assertRaisesRegex(ValueError,'inside ~/Downloads'):
                    runner.patch_from_download(str(outside))
                (downloads / 'symlink.patch').symlink_to(patched)
                with self.assertRaisesRegex(ValueError,'non-symlink'):
                    runner.patch_from_download(str(downloads / 'symlink.patch'))
                with zipfile.ZipFile(downloads / 'two.zip','w') as z:
                    z.writestr('one.patch',patch_text)
                    z.writestr('two.patch',patch_text)
                with self.assertRaisesRegex(ValueError,'exactly one'):
                    runner.patch_from_download(str(downloads / 'two.zip'))

class SymbolCompressionRunnerTest(unittest.TestCase):
    def test_decompress_and_git_apply(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / 'repo'; repo.mkdir()
            subprocess.run(['git', '-C', str(repo), 'init', '-q'], check=True)
            (repo / 'sample.ts').write_text('const veryLongIdentifierName = 1;\n')
            subprocess.run(['git','-C',str(repo),'add','.'],check=True)
            text = ('diff --git a/sample.ts b/sample.ts\n'
                    '--- a/sample.ts\n+++ b/sample.ts\n@@ -1 +1 @@\n'
                    '-const q = 1;\n+const q = 2; // q stays a comment\n')
            compressed = text.encode()
            mapping = {'sample.ts': {'q': 'veryLongIdentifierName'}}
            normal = runner.restore_symbols_in_patch(compressed, mapping).decode()
            self.assertIn('-const veryLongIdentifierName = 1;', normal)
            self.assertIn('+const veryLongIdentifierName = 2; // q stays a comment', normal)
            self.assertIn('diff --git a/sample.ts b/sample.ts', normal)
            downloads = base / 'Downloads'; downloads.mkdir()
            patch_file = downloads / 'symbols.patch'; patch_file.write_bytes(compressed)
            with patch.object(runner.Path, 'home', return_value=base):
                result = runner.apply_download(str(repo),str(patch_file),mapping)
                self.assertTrue(result['ok'],result)
            self.assertEqual((repo / 'sample.ts').read_text(),'const veryLongIdentifierName = 2; // q stays a comment\n')

    def test_invalid_mapping_is_rejected(self):
        patch_bytes = b'--- a/example.py\n+++ b/example.py\n@@ -1 +1 @@\n-q = 1\n+q = 2\n'
        with self.assertRaisesRegex(ValueError,'Invalid mapped path'):
            runner.restore_symbols_in_patch(patch_bytes,{'../escape.py':{'q':'private'}})
        with self.assertRaisesRegex(ValueError,'Invalid symbol alias'):
            runner.restore_symbols_in_patch(patch_bytes,{'example.py':{'q':'x;rm -rf'}})


if __name__ == '__main__':
    unittest.main()
