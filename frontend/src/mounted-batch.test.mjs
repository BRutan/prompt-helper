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
