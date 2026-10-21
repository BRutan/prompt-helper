#!/usr/bin/env python3
"""Produce a Git patch for the specific TS2322 record-map error in session-dashboard.ts.

Designed for checkouts whose session-dashboard.ts differs from the uploaded
snapshot. Never edits the target file; use `git apply --check` first.
"""
from __future__ import annotations

import argparse
import difflib
from pathlib import Path
import re
import sys

TARGET = Path('frontend/src/session-dashboard.ts')
FUNCTION_NAME = 'normalizeSessionStringRecords'
FUNCTION = '''

// Normalize untrusted session metadata before treating it as a nested string map.
function normalizeSessionStringRecords(value: unknown): Record<string, Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const records: Record<string, Record<string, string>> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) continue;
    const fields: Record<string, string> = {};
    for (const [field, fieldValue] of Object.entries(nested)) {
      if (typeof fieldValue === "string") fields[field] = fieldValue;
    }
    records[key] = fields;
  }
  return records;
}
'''


def fix_line(line: str) -> str:
    """Rewrite the expression only; never change its surrounding statement."""
    ending = '\n' if line.endswith('\n') else ''
    statement = line.removesuffix('\n')
    # A typical TS2322 target: a generic `object` is returned from a function
    # whose declared return type is Record<string, Record<string, string>>.
    return_match = re.fullmatch(r'(\s*return\s+)(.+?)(\s*;?\s*)', statement)
    if return_match:
        left, expression, tail = return_match.groups()
        expression = expression.strip().removesuffix(';').rstrip()
        if not expression or expression.startswith('normalizeSessionStringRecords('):
            raise ValueError('The return expression is empty or already normalized.')
        suffix = ';' if ';' in tail or statement.rstrip().endswith(';') else ''
        return f'{left}{FUNCTION_NAME}({expression}){suffix}{ending}'

    # A plain assignment, optionally annotated with a type. Do not modify
    # destructuring, compound assignments, or arrow functions.
    assignment = re.fullmatch(
        r'(\s*(?:(?:const|let|var)\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?'
        r'(?:\s*:\s*Record<string,\s*Record<string,\s*string>>)?\s*=\s*)(.+?)(\s*;?\s*)',
        statement,
    )
    if assignment:
        left, expression, tail = assignment.groups()
        expression = expression.strip().removesuffix(';').rstrip()
        if not expression or expression.startswith('normalizeSessionStringRecords('):
            raise ValueError('The assignment is empty or already normalized.')
        suffix = ';' if ';' in tail or statement.rstrip().endswith(';') else ''
        return f'{left}{FUNCTION_NAME}({expression}){suffix}{ending}'

    raise ValueError('Line is not a simple return or assignment. Exact source context is required.\n' + statement)


def generate(original: str, error_line: int) -> str:
    lines = original.splitlines(keepends=True)
    if not (1 <= error_line <= len(lines)):
        raise ValueError(f'Expected line {error_line}, but file has {len(lines)} lines.')
    changed = list(lines)
    changed[error_line - 1] = fix_line(lines[error_line - 1])
    if FUNCTION_NAME in original:
        raise ValueError('A normalizer with this name already exists; refusing to add a duplicate.')
    if changed and not changed[-1].endswith('\n'):
        changed[-1] += '\n'
    changed.append('\n')
    changed.extend(FUNCTION.lstrip('\n').splitlines(keepends=True))
    diff = ''.join(difflib.unified_diff(
        lines, changed, fromfile='a/' + TARGET.as_posix(),
        tofile='b/' + TARGET.as_posix(), n=3,
    ))
    return 'diff --git a/{0} b/{0}\n'.format(TARGET) + diff


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--line', type=int, default=159)
    parser.add_argument('--patch', type=Path, required=True)
    args = parser.parse_args()
    source = (args.repo / TARGET).resolve()
    if not source.is_file():
        parser.error(f'Missing source: {source}')
    try:
        before = source.read_text(encoding='utf-8')
        patch = generate(before, args.line)
    except (OSError, ValueError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        print('Show this command output if the source has changed:', file=sys.stderr)
        print(f'  sed -n "{max(args.line-10,1)},{args.line+10}p" {TARGET}', file=sys.stderr)
        return 2
    args.patch.parent.mkdir(parents=True, exist_ok=True)
    args.patch.write_text(patch, encoding='utf-8')
    print(f'Generated checkout-specific Git patch: {args.patch}')
    print('Review with `git apply --check` before applying.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
