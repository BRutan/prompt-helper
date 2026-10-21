import test from 'node:test';
import assert from 'node:assert/strict';
import {compressGitDiff, expandGitDiff, dialectForPath, inverseForNative} from './symbol-compression.js';
const tokenCount=s=>s.length; // predictable stand-in for the UI's model tokenizer
function frame(path,code){return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,4 @@\n-${code}\n+${code}\n+console.log(veryLongIdentifierName + veryLongIdentifierName);\n`}
test('eligible local binding is shorter and roundtrips in a real Git diff',()=>{
  const source=frame('src/component.ts','const veryLongIdentifierName = 1;');
  const result=compressGitDiff(source,{},tokenCount);
  assert.equal(result.active,true);
  assert.ok(result.savedTokens>0);
  assert.ok(result.registry['src/component.ts'].veryLongIdentifierName);
  assert.equal(expandGitDiff(result.diff,result.registry),source);
  assert.match(result.diff,/^diff --git a\/src\/component.ts b\/src\/component.ts/m);
  assert.match(result.diff,/^@@ -1 \+1,4 @@$/m);
});
test('aliases are deterministic and independent per file and conversation',()=>{
  const source=frame('src/a.ts','const veryLongIdentifierName = 1;');
  const first=compressGitDiff(source,{},tokenCount);
  const followup=compressGitDiff(source,first.registry,tokenCount);
  assert.deepEqual(followup.registry,first.registry);
  const other=compressGitDiff(source,{},tokenCount);
  assert.deepEqual(other.registry,first.registry);
  const path='src/b.ts';
  const byOtherPath=compressGitDiff(source.replaceAll('src/a.ts',path),first.registry,tokenCount);
  assert.ok(byOtherPath.registry[path]);
});
test('never compress comments, string literals, member properties or exports',()=>{
  const src='--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1,4 @@\n+const veryLongIdentifierName = "const fakeVariable = 10"; // const commentVariable = 20\n+obj.veryLongIdentifierName = veryLongIdentifierName;\n+export const publicApiIdentifier = veryLongIdentifierName;\n+const str = `const templateDeclaration = 7`;\n';
  const r=compressGitDiff(src,{},tokenCount);
  assert.equal(expandGitDiff(r.diff,r.registry),src);
  assert.match(r.diff,/"const fakeVariable = 10"/);
  assert.match(r.diff,/\/\/ const commentVariable = 20/);
  assert.match(r.diff,/obj\.veryLongIdentifierName/);
  assert.match(r.diff,/publicApiIdentifier/);
  assert.match(r.diff,/templateDeclaration/);
});
test('Python only aliases explicitly private names; no CSS/SQL rewriting',()=>{
  const src='--- a/pkg/module.py\n+++ b/pkg/module.py\n@@ -1 +1,3 @@\n+_private_local_variable = 1\n+print(_private_local_variable + _private_local_variable)\n+public_attribute = 1\n';
  const r=compressGitDiff(src,{},tokenCount);
  assert.equal(expandGitDiff(r.diff,r.registry),src);
  assert.deepEqual(Object.keys(r.registry['pkg/module.py']),['_private_local_variable']);
  assert.equal(dialectForPath('file.sql'),null);
  assert.deepEqual(inverseForNative({'file.py':{_private_local_variable:'q'}}),{'file.py':{q:'_private_local_variable'}});
});
test('mapping never changes Git metadata or patches for unsupported files',()=>{
  const src='diff --git a/views/index.html b/views/index.html\n--- a/views/index.html\n+++ b/views/index.html\n@@ -1 +1 @@\n-const veryLongIdentifierName\n+const veryLongIdentifierName\n';
  const r=compressGitDiff(src,{},tokenCount);
  assert.equal(r.diff,src);
  assert.equal(r.savedTokens,0);
});
test('normalizes absolute SOURCE_DIR identities to selected repository root',async()=>{
  const {normalizeGitDiffPaths}=await import('./symbol-compression.js');
  const src='--- a//Users/alice/work/project/src/index.ts\n+++ b//Users/alice/work/project/src/index.ts\n@@ -1 +1 @@\n-a\n+b\n';
  const output=normalizeGitDiffPaths(src,[{path:'/Users/alice/work/project/src/index.ts'}],'/Users/alice/work/project');
  assert.ok(output.includes('--- a/src/index.ts'));
  assert.ok(output.includes('+++ b/src/index.ts'));
  assert.throws(()=>normalizeGitDiffPaths(src,[{path:'/Users/alice/work/project/src/index.ts'}],'/Users/alice/other'),/outside selected/);
  const created='--- /dev/null\n+++ b/Users/alice/work/project/src/index.ts\n@@ -0,0 +1 @@\n+new\n';
  assert.ok(normalizeGitDiffPaths(created,[{path:'/Users/alice/work/project/src/index.ts'}],'/Users/alice/work/project').includes('+++ b/src/index.ts'));
});
