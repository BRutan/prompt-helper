"""Standalone unit tests for the checkout-specific dashboard fix generator."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    'fix_session_dashboard_type', Path(__file__).with_name('fix_session_dashboard_type.py')
)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class FixDashboardTypeTest(unittest.TestCase):
    def test_return_statement(self):
        self.assertEqual(MOD.fix_line('    return obj;\n'),
                         '    return normalizeSessionStringRecords(obj);\n')

    def test_optional_value(self):
        self.assertEqual(MOD.fix_line('    return maybe || {};\n'),
                         '    return normalizeSessionStringRecords(maybe || {});\n')

    def test_assignment(self):
        self.assertEqual(MOD.fix_line('    store = payload;\n'),
                         '    store = normalizeSessionStringRecords(payload);\n')

    def test_refuse_arbitrary_statement(self):
        with self.assertRaises(ValueError):
            MOD.fix_line('    if (condition) return {}\n')

    def test_patch_contains_helper_and_change(self):
        source = '// heading\n' + 'function load(): Record<string, Record<string, string>> {\n    return raw;\n}\n'
        diff = MOD.generate(source, 3)
        self.assertIn('+    return normalizeSessionStringRecords(raw);', diff)
        self.assertIn('+function normalizeSessionStringRecords(', diff)
        self.assertIn('Object.entries(nested)', diff)


if __name__ == '__main__':
    unittest.main()
