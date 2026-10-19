import test from 'node:test';
import assert from 'node:assert/strict';
import { findPathHeader } from './path-identity.js';

const plain = 'Path: scro-ml/local-worker/jobs/random_transaction/categories/e2e_video_claims_evaluation.py';
test('unframed plain Path: first line', () => {
  assert.deepEqual(findPathHeader(`${plain}\nprint(1)\n`), {
    leader: '', path: 'scro-ml/local-worker/jobs/random_transaction/categories/e2e_video_claims_evaluation.py',
  });
});
test('pasted Path: after empty lines, markdown fence, or preamble', () => {
  assert.equal(findPathHeader(`\n\n\`\`\`python\n${plain}\nprint(1)` )?.path,
    'scro-ml/local-worker/jobs/random_transaction/categories/e2e_video_claims_evaluation.py');
  assert.equal(findPathHeader(`SOURCE DIRECTORY: /unused\n${plain}`)?.leader, '');
});
test('comment-prefixed Path: for Swift, Python, CSS, and HTML', () => {
  for (const [input, leader] of [
    ['// Path: app/View.swift', '//'],
    ['# Path: scripts/job.py', '#'],
    ['/* Path: assets/main.css */', '/*'],
    ['<!-- Path: public/index.html -->', '<!--'],
    ['-- Path: db/migration.sql', '--'],
  ]) assert.equal(findPathHeader(input)?.leader, leader);
});
test('do not accept Path: in the middle of code or incomplete Path: alone', () => {
  assert.equal(findPathHeader('print("Path: foo.py")'), null);
  assert.equal(findPathHeader('Path:'), null);
});
