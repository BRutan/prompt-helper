// Path: frontend/src/input-preview.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { countFramedFiles } from './input-preview.js';
const frame = (i) => `================================================================================\nSOURCE_DIR: /a/project\nFILE: src/File${i}.swift\n================================================================================\n\n// Path: src/File${i}.swift\nclass File${i} {}\n`;
test('single-file source has no batch frames', () => {
  assert.equal(countFramedFiles('// Path: src/Foo.swift\nlet foo = 1'), 0);
});
test('counts all frames in a large multi-file paste without splitting contents', () => {
  const dump = Array.from({ length: 84 }, (_, i) => frame(i) + 'x'.repeat(20000)).join('\n');
  assert.equal(countFramedFiles(dump), 84);
  assert.equal(countFramedFiles(dump), 84);
});
test('ignores partial and invalid framing', () => {
  assert.equal(countFramedFiles('SOURCE_DIR: /tmp\nFILE: broken.swift'), 0);
});
