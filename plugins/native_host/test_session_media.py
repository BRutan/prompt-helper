# Path: plugins/native_host/test_session_media.py
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import session_media as media


class SessionMediaTest(unittest.TestCase):
    def test_url_whitelist(self):
        case = '6ada5c1d-2bf8-83ea-b518-74752b931f3c'
        self.assertEqual(media.session_from_url('https://chatgpt.com/c/'+case), case)
        self.assertEqual(media.session_from_url('https://claude.ai/chat/abc-123'), 'abc-123')
        for url in ('https://chatgpt.com.evil.test/c/abc', 'https://example.com/c/abc',
                    'http://chatgpt.com/c/abc', 'https://chatgpt.com/c/../bad',
                    'https://chatgpt.com/g/foo', 'https://chatgpt.com/c/%2Fetc',
                    'https://chatgpt.com/c/', ''):
            self.assertIsNone(media.session_from_url(url), url)

    def test_copy_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'Screenshot 2026-10-22 at 5.23.48 PM.png'
            source.write_bytes(b'one')
            self.assertTrue(media.is_media_file(source))
            first = media.mirrored_file(source, 'abc', root/'out')
            self.assertEqual(first.read_bytes(), b'one')
            source.write_bytes(b'two')
            second = media.mirrored_file(source, 'abc', root/'out')
            self.assertEqual(second.read_bytes(), b'two')
            self.assertEqual(first.read_bytes(), b'one')
            self.assertNotEqual(first, second)
            self.assertIsNone(media.mirrored_file(source, '../etc', root/'out'))
            other = root/'private.txt'; other.write_text('not a capture')
            self.assertIsNone(media.mirrored_file(other, 'abc', root/'out'))

    def test_config_safety_and_disable_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root/'repo'; repo.mkdir()
            chosen = root/'My Shots'; chosen.mkdir()
            state = {}
            location = {'value': '/original/Desktop'}
            def save(value):
                state.clear();state.update(value)
            def set_location(value):
                location['value'] = str(value) if value is not None else None
            with patch.object(media, 'repo_root', return_value=repo), \
                 patch.object(media.sys, 'platform', 'darwin'), \
                 patch.object(media, 'read_state', side_effect=lambda: state.copy()), \
                 patch.object(media, 'write_state', side_effect=save), \
                 patch.object(media, 'screenshot_location', side_effect=lambda: location['value']), \
                 patch.object(media, 'set_screenshot_location', side_effect=set_location), \
                 patch.object(media, 'install_agent'), patch.object(media, 'uninstall_agent'):
                result = media.configure(True, str(chosen))
                self.assertTrue(result['enabled'])
                self.assertEqual(location['value'], str(chosen))
                self.assertTrue((repo/'data'/'session_media').is_dir())
                result = media.configure(False)
                self.assertFalse(result['enabled'])
                self.assertEqual(location['value'], '/original/Desktop')
                with self.assertRaises(ValueError):
                    media.configure(True, str(repo/'data'/'session_media'))

    def test_disable_doesnt_override_user_change(self):
        location = {'value': '/user/changed'}
        with patch.object(media.sys, 'platform', 'darwin'), \
             patch.object(media, 'read_state', return_value={'enabled':True,'folder':'/old/path','original_location':'/home/Desktop'}), \
             patch.object(media, 'screenshot_location', return_value=location['value']), \
             patch.object(media, 'set_screenshot_location') as setter, \
             patch.object(media, 'uninstall_agent'), patch.object(media, 'write_state'):
            media.configure(False)
            setter.assert_not_called()

if __name__ == '__main__':
    unittest.main()
