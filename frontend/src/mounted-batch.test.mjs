import test from 'node:test';
import assert from 'node:assert/strict';
import { isMultiFileDump, parseMultiFileDump, mergeFileDiffResponses } from './mounted-batch.js';

const framed = (file, source) => `================================================================================\nSOURCE_DIR: /Users/example/repo/src\nFILE: ${file}\n================================================================================\n\n${source}`;

test('splits SOURCE_DIR + FILE into separate source with original Path: header', () => {
  const input = framed('App/ContentView.swift', '// Path: src/App/ContentView.swift\nlet a = 1\n') +
    framed('App/Next.swift', '// Path: src/App/Next.swift\nlet b = 2\n');
  assert.equal(isMultiFileDump(input), true);
  const files = parseMultiFileDump(input);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, '/Users/example/repo/src/App/ContentView.swift');
  assert.equal(files[0].source, '// Path: src/App/ContentView.swift\nlet a = 1\n');
  assert.equal(files[1].source, '// Path: src/App/Next.swift\nlet b = 2\n');
});

test('unchanged files appear in path tree but not changed hunks', () => {
  const result = mergeFileDiffResponses([
    {path:'/project/src/B.swift', status:'unchanged',version:2,extension:'.swift',sha256:'bb',additions:0,deletions:0,llm_diff:'',unified_diff:''},
    {path:'/project/src/A.swift',status:'updated',version:3,extension:'.swift',sha256:'aa',additions:1,deletions:1,llm_diff:'2 -let a = 1\n2 +let a = 2',unified_diff:'@@ -2 +2 @@'},
  ]);
  assert.equal(result.total,2);
  assert.equal(result.changed,1);
  assert.match(result.llm_diff,/B\.swift \[v2 unchanged\]/);
  assert.match(result.llm_diff,/=== \/project\/src\/A\.swift ===/);
  assert.doesNotMatch(result.llm_diff,/=== \/project\/src\/B\.swift ===/);
});


test('accepts a literal Path: header for a framed Python file', () => {
  const files = parseMultiFileDump(framed('scripts/simulator_appium_navigation.py',
    'Path: scripts/simulator_appium_navigation.py\nprint("ok")\n'));
  assert.equal(files.length, 1);
  assert.equal(files[0].path, '/Users/example/repo/src/scripts/simulator_appium_navigation.py');
  assert.equal(files[0].source, 'Path: scripts/simulator_appium_navigation.py\nprint("ok")\n');
});

test('mixed bare and commented Path headers retain their source', () => {
  const files = parseMultiFileDump(
    framed('scripts/run.py', 'Path: scripts/run.py\nprint(1)\n') +
    framed('App/View.swift', '// Path: App/View.swift\nstruct View {}\n'));
  assert.equal(files.length, 2);
  assert.match(files[0].source, /^Path: scripts\/run\.py/);
  assert.match(files[1].source, /^\/\/ Path: App\/View\.swift/);
});

test('SOURCE_DIR + FILE overrides a conflicting embedded Path header', () => {
  const [file] = parseMultiFileDump(framed('scripts/expected.py',
    'Path: scripts/unrelated.py\nprint(1)\n'));
  assert.equal(file.path, '/Users/example/repo/src/scripts/expected.py');
  assert.match(file.source, /^Path: scripts\/unrelated.py/);
});

test('framed Next.js client component without Path header is accepted', () => {
  const text = '"use client";\n\nimport { useState } from "react";\nexport default function Page() { return null; }\n';
  const [file] = parseMultiFileDump(framed('app/admin/credit-risk/page.tsx', text));
  assert.equal(file.path, '/Users/example/repo/src/app/admin/credit-risk/page.tsx');
  assert.equal(file.source, text);
});

test('framed source with no Path header preserves empty lines and shebangs', () => {
  const [file] = parseMultiFileDump(framed('scripts/run.py', '#!/usr/bin/env python3\n\nprint(1)\n'));
  assert.equal(file.source, '#!/usr/bin/env python3\n\nprint(1)\n');
});

test('framed files still reject traversal, duplicates, and unsafe paths', () => {
  assert.throws(() => parseMultiFileDump(framed('../private.py', 'print(1)')));
  assert.throws(() => parseMultiFileDump(framed('app/a.tsx', 'x\n') + framed('app/a.tsx', 'y\n')));
});
