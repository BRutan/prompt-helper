/**
 * Render only changed hunks with line-number gutters. `textContent` avoids
 * interpreting pasted source code as HTML, including user-controlled diffs.
 * @param {HTMLElement} target
 * @param {Array<{kind:string,old_line:number|null,new_line:number|null,text:string}>} lines
 */
export function renderDiff(target, lines) {
  target.replaceChildren();
  if (!lines || lines.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'diff-empty';
    empty.textContent = 'No changes since the previous version.';
    target.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = `diff-line ${['added','removed','hunk','context','meta'].includes(line.kind) ? line.kind : 'meta'}`;
    const old = document.createElement('span');
    old.className = 'line-num';
    old.textContent = line.old_line == null ? '' : String(line.old_line);
    const now = document.createElement('span');
    now.className = 'line-num';
    now.textContent = line.new_line == null ? '' : String(line.new_line);
    const marker = document.createElement('span');
    marker.className = 'marker';
    marker.textContent = line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ';
    const value = document.createElement('span');
    value.className = 'line-text';
    value.textContent = line.text;
    row.append(old, now, marker, value);
    fragment.append(row);
  }
  target.append(fragment);
}
