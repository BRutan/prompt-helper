// Path: frontend/src/path-identity.js
// For standalone text, match a Path: declaration at the start of any line.
// SOURCE_DIR + FILE frames take precedence and are parsed elsewhere.
const PATH_LINE = /^[ \t]*(?:(<!--|\/\*|\/\/|--|#)[ \t]+)?Path:[ \t]+([^\r\n]+)\r?$/m;

export function findPathHeader(text) {
  const match = text.replace(/^\uFEFF/, '').match(PATH_LINE);
  return match ? { leader: match[1] || '', path: match[2].trim() } : null;
}
