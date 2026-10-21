import importlib.util
import tempfile
import unittest
from pathlib import Path

module_path = Path(__file__).resolve().parents[1] / 'chrome_live.py'
spec=importlib.util.spec_from_file_location('chrome_live_new_test',module_path)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ConfigurationTests(unittest.TestCase):
    def test_default_local(self):
        self.assertEqual(module.runtime_endpoint({}), (True,'http://127.0.0.1:5173'))
    def test_local_custom_port(self):
        self.assertEqual(module.runtime_endpoint({'IS_LOCAL':'1','PROMPT_HELPER_PORT':'5050'}),(True,'http://127.0.0.1:5050'))
    def test_remote_origin_required(self):
        with self.assertRaises(ValueError):module.runtime_endpoint({'IS_LOCAL':'0','PROMPT_HELPER_PUBLIC_URL':'http://example.com'})
        self.assertEqual(module.runtime_endpoint({'IS_LOCAL':'0','PROMPT_HELPER_PUBLIC_URL':'https://example.com'}),(False,'https://example.com'))
    def test_build_contains_injected_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            import os
            from unittest.mock import patch
            with patch.dict(os.environ,{'IS_LOCAL':'1','PROMPT_HELPER_PORT':'5173'}):
                folder,_=module.build(Path(tmp))
            text=(folder/'runtime-config.js').read_text()
            self.assertIn('IS_LOCAL = true',text)
            self.assertIn('127.0.0.1:5173',text)
            self.assertIn('session-layout.js', (folder/'background.js').read_text())

if __name__=='__main__':unittest.main()
