// Path: plugins/chrome/symbol-compression.js
// Git-patch transport aliases. This is intentionally a conservative lexical
// transform, NOT a source rewrite or a substitute for AST/LSP symbol resolution.
// The registry is scoped to a browser conversation and then to a file path.
const DIALECTS = Object.freeze({
  js:'javascript',jsx:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',tsx:'typescript',
  py:'python',go:'go',swift:'swift',rs:'rust',java:'java',kt:'kotlin',
  c:'c',cc:'cpp',cpp:'cpp',cxx:'cpp',h:'cpp',hpp:'cpp',cs:'csharp'
});
const IDENT = /^[A-Za-z_$][A-Za-z_0-9$]*$/;
const RESERVED = new Set(('abstract as assert async await break case catch class const continue debugger default defer delete do else enum export extends false final finally for from func function go goto if import in instanceof interface is let map match module mut new nil null of operator override package private protected public return select self static struct super switch this throw throws true try type typeof undefined unsafe use using var void while with yield').split(' '));
const PRIVATE_ONLY = new Set(['python']);
export function dialectForPath(p) { return DIALECTS[p.split('.').at(-1)?.toLowerCase()] || null; }
function patchLines(text) {
  const out=[];let path=null, dialect=null;
  for(const line of text.split('\n')){
    const file=line.match(/^\+\+\+ b\/(.+)$/);
    if(file){path=file[1];dialect=dialectForPath(path);out.push({raw:line,path:null,dialect:null});continue;}
    // Metadata and hunks must never be transformed.
    if (/^(?:diff --git |index |new file mode |deleted file mode |rename |similarity |--- |\+\+\+ |@@|\\ No newline)/.test(line)) {
      out.push({raw:line,path:null,dialect:null});continue;
    }
    if(path && dialect && /^[ +\-]/.test(line))out.push({raw:line,path,dialect,prefix:line[0],code:line.slice(1)});
    else out.push({raw:line,path:null,dialect:null});
  }
  return out;
}
// Skip string literals, comments, preprocessing and member/property names. The
// same lexer runs over returned patch lines before git apply (Python port).
export function walkIdentifiers(code,dialect,callback,maskNonCode=false) {
  if(/^\s*#(?:include|define|if|elif|else|endif|pragma|import)\b/.test(code) && dialect!=='python')return code;
  let out='',i=0,quote='',block=false;
  const hashComments=dialect==='python';
  while(i<code.length){
    const c=code[i],next=code[i+1]||'';
    if(block){if(c==='*'&&next==='/'){out+=maskNonCode?'  ':'*/';i+=2;block=false;}else{out+=maskNonCode?' ':c;i++;}continue;}
    if(quote){out+=maskNonCode?' ':c;i++;if(c==='\\'&&i<code.length){out+=maskNonCode?' ':code[i++];}else if(c===quote){quote='';}continue;}
    if(c==='/'&&next==='/'&&!hashComments){out+=maskNonCode?' '.repeat(code.length-i):code.slice(i);break;}
    if(c==='/'&&next==='*'&&!hashComments){out+=maskNonCode?'  ':'/*';i+=2;block=true;continue;}
    if((hashComments&&c==='#')||(dialect==='sql'&&c==='-'&&next==='-')){out+=maskNonCode?' '.repeat(code.length-i):code.slice(i);break;}
    if(c==='"'||c==="'"||c==='`'){quote=c;out+=maskNonCode?' ':c;i++;continue;}
    if(/[A-Za-z_$]/.test(c)){
      let end=i+1;while(end<code.length&&/[\w$]/.test(code[end]))end++;
      const word=code.slice(i,end);
      // Dot access, decorator identifiers, method names and mapping keys stay
      // human-readable. Do not rename public/external object properties.
      const before=code.slice(0,i).trimEnd(),after=code.slice(end).trimStart();
      if(!RESERVED.has(word)&&!/[.@]$/.test(before)&&!after.startsWith(':')&&!after.startsWith('(')){
        out+=callback(word);
      }else out+=word;
      i=end;continue;
    }
    out+=c;i++;
  }
  return out;
}
function declarations(code,dialect){
  // Only obvious local/private bindings. Import/export, public declarations,
  // and cross-file symbol identities are deliberately excluded.
  if(/\b(?:export|import|public|open|extern|global|nonlocal|@objc|override)\b/.test(code))return [];
  const patterns={
    javascript:[/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g],
    typescript:[/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g],
    python:[/\b(?:def)\s+(_[A-Za-z_]\w*)\b/g,/^\s*(_[A-Za-z_]\w*)\s*=(?!=)/g],
    go:[/\b(?:var|const)\s+([a-z][A-Za-z_0-9]*)\b/g,/\b([a-z][A-Za-z_0-9]*)\s*:=/g],
    swift:[/\b(?:let|var)\s+([A-Za-z_][\w]*)\b/g],
    rust:[/\blet\s+(?:mut\s+)?([A-Za-z_][\w]*)\b/g],
    java:[/\b(?:var|final\s+var)\s+([A-Za-z_][\w]*)\b/g],
    kotlin:[/\b(?:val|var)\s+([A-Za-z_][\w]*)\b/g],
    cpp:[/\b(?:auto|int|long|double|float|bool|size_t)\s+([A-Za-z_][\w]*)\s*(?=[=;,])/g],
    c:[/\b(?:int|long|double|float|bool|size_t)\s+([A-Za-z_][\w]*)\s*(?=[=;,])/g],
    csharp:[/\b(?:var|int|long|double|float|bool|string)\s+([A-Za-z_][\w]*)\s*(?=[=;,])/g]
  };
  const found=[];
  for(const regex of patterns[dialect]||[]){
    regex.lastIndex=0;let m;while((m=regex.exec(code))!==null){
      const word=m[1];if(word.length>3&&IDENT.test(word)&&!RESERVED.has(word)&&(!PRIVATE_ONLY.has(dialect)||word.startsWith('_')))found.push(word);
    }
  }
  return found;
}
const ALPHABET='qzxjkvwybcmpfdghnrtlsuaei';
function* aliases(){
  for(const c of ALPHABET)yield c;
  for(const c of ALPHABET)for(let n=0;n<100;n++)yield c+n;
  for(let n=0;n<10000;n++)yield '_z'+n;
}
function cleanRegistry(existing){
  const out={};
  if(!existing||typeof existing!=='object')return out;
  for(const [path, names] of Object.entries(existing)) {
    if(typeof path!=='string'||!names||typeof names!=='object')continue;
    const valid={};
    for(const [original, alias] of Object.entries(names)){
      if(IDENT.test(original)&&IDENT.test(alias)&&!RESERVED.has(alias)&&original!==alias)valid[original]=alias;
    }
    out[path]=valid;
  }
  return out;
}
// sourceText is the full locally uploaded source dump. It is used only to
// reserve existing short names, avoiding alias collisions with unseen lines.
export function compressGitDiff(diff,previous={},countTokens=s=>s.length,sourceText='') {
  const reservedFromSource=new Set();
  if(sourceText){
    const matcher=/[A-Za-z_$][A-Za-z_0-9$]*/g;
    let m;while((m=matcher.exec(sourceText))!==null)if(m[0].length<=5)reservedFromSource.add(m[0]);
  }
  const segments=patchLines(diff),byPath=new Map();
  const registry=cleanRegistry(previous);
  for(const item of segments){
    if(!item.path)continue;
    if(!byPath.has(item.path))byPath.set(item.path,{dialect:item.dialect,items:[],eligible:new Set(),used:new Set(),frequency:new Map()});
    const file=byPath.get(item.path);file.items.push(item);
    const cleaned=walkIdentifiers(item.code,item.dialect,word=>{
      file.used.add(word);file.frequency.set(word,(file.frequency.get(word)||0)+1);return word;
    },true);
    // Detection is performed on the original text, but only on a line which
    // has no string/comment-only declaration match after lexical cleaning.
    if(!/^\s*(?:\/\/|#|\*)/.test(item.code))for(const word of declarations(cleaned,item.dialect))file.eligible.add(word);
  }
  for(const [path,file] of byPath){
    const current={...(registry[path]||{})};
    const occupied=new Set([...file.used,...reservedFromSource,...Object.values(current)]);
    const words=[...file.eligible].filter(w=>!current[w]);
    words.sort((a,b)=>((file.frequency.get(b)||0)*Math.max(0,countTokens(b)-1))-((file.frequency.get(a)||0)*Math.max(0,countTokens(a)-1))||a.localeCompare(b));
    const candidates=aliases();
    for(const name of words){
      const savings=(file.frequency.get(name)||0)*countTokens(name);
      if(savings<=0)continue;
      let replacement='';
      for(const candidate of candidates){
        if(!occupied.has(candidate)&&!RESERVED.has(candidate)&&countTokens(candidate)<countTokens(name)){
          replacement=candidate;break;
        }
      }
      if(!replacement)break;
      current[name]=replacement;occupied.add(replacement);
    }
    // Skip any reused alias that collides with a source identifier on this
    // delivery; an ambiguous alias must never reach the local Git runner.
    for(const [name,alias] of Object.entries(current))if(file.used.has(alias))delete current[name];
    registry[path]=current;
  }
  const compressed=segments.map(item=>!item.path?item.raw:item.prefix+walkIdentifiers(item.code,item.dialect,word=>registry[item.path]?.[word]||word)).join('\n');
  const originalTokens=countTokens(diff),compressedTokens=countTokens(compressed);
  const enabled=compressedTokens<originalTokens;
  return {diff:enabled?compressed:diff, originalTokens,compressedTokens:enabled?compressedTokens:originalTokens,
    savedTokens:enabled?originalTokens-compressedTokens:0,
    registry:enabled?registry:cleanRegistry(previous),
    aliases:enabled?Object.values(registry).reduce((n,v)=>n+Object.keys(v).length,0):0,
    active:enabled};
}
export function inverseForNative(registry){
  const back={};
  for(const [p,values] of Object.entries(cleanRegistry(registry))){
    const aliases={};for(const [original,alias] of Object.entries(values)){
      if(aliases[alias])throw Error('Colliding symbol aliases for '+p);
      aliases[alias]=original;
    }
    back[p]=aliases;
  }
  return back;
}
export function expandGitDiff(diff,registry={}){
  const byFile=inverseForNative(registry);
  return patchLines(diff).map(item=>!item.path?item.raw:item.prefix+walkIdentifiers(item.code,item.dialect,word=>byFile[item.path]?.[word]||word)).join('\n');
}
// Resolve the source dump's absolute identities to paths *relative to the
// explicitly selected Git root*. Git patches must not embed /Users/... paths.
export function normalizeGitDiffPaths(text,files,repoRoot){
  if(typeof repoRoot!=='string'||!repoRoot.startsWith('/')||repoRoot.includes('\0'))throw Error('An absolute Git root is required');
  const root=repoRoot.replace(/\/+$/,'');
  const known=new Map();
  for(const file of files||[]){
    const p=file.path;
    if(typeof p!=='string'||p.includes('\0'))throw Error('Invalid source path');
    let relative=p;
    if(p.startsWith('/')){
      if(!p.startsWith(root+'/'))throw Error(`Source is outside selected Git repository: ${p}`);
      relative=p.slice(root.length+1);
    }
    if(!relative||relative.startsWith('/')||relative.split('/').includes('..'))throw Error('Unsafe path in source dump: '+p);
    known.set(p,relative);known.set(p.replace(/^\//,''),relative);
  }
  return text.split('\n').map(line=>{
    const match=line.match(/^(---|\+\+\+) ([ab])\/(.+)$/);
    if(!match)return line;
    const found=known.get(match[3])||known.get('/'+match[3]);
    if(!found)throw Error('Git patch header does not match a staged file: '+line.slice(0,250));
    return `${match[1]} ${match[2]}/${found}`;
  }).join('\n');
}
