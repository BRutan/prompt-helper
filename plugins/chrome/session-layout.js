// Path: plugins/chrome/session-layout.js
// Pure window geometry; Chrome/macOS may impose a larger native minimum.
// Never request tiny browser windows just to fit an arbitrary number of chats.
const MIN_WIDTH = 640;
const MIN_HEIGHT = 440;

export function compactGrid(count, screen, minWidth = MIN_WIDTH, minHeight = MIN_HEIGHT) {
  if (!Number.isInteger(count) || count < 1 || count > 50) throw Error('Select 1–50 open sessions.');
  const left = Math.round(Number(screen?.left)), top = Math.round(Number(screen?.top));
  const width = Math.floor(Number(screen?.width)), height = Math.floor(Number(screen?.height));
  if (![left, top, width, height].every(Number.isFinite) || width < minWidth || height < minHeight) {
    throw Error(`Display must be at least ${minWidth}×${minHeight} to arrange conversations.`);
  }
  const maxCols = Math.floor(width / minWidth), maxRows = Math.floor(height / minHeight);
  if (maxCols * maxRows < count) {
    // macOS enforces minimum native Chrome window sizes, so overlapping large
    // windows is preferable to requesting impossibly small tiles. In each
    // column, stagger title bars so the other sessions remain reachable.
    const cols = Math.min(count, Math.max(1, Math.min(maxCols, Math.floor(width / 720))));
    const rows = Math.ceil(count / cols);
    const result = [];
    for (let i = 0; i < count; i++) {
      const col = i % cols, layer = Math.floor(i / cols);
      const x1 = left + Math.floor(col * width / cols);
      const x2 = left + Math.floor((col + 1) * width / cols);
      const usableShift = Math.min(52, Math.floor((height - minHeight) / Math.max(1, rows - 1)));
      const windowHeight = height - usableShift * (rows - 1);
      result.push({left:x1,top:top + layer * usableShift,width:x2-x1,height:windowHeight});
    }
    return result;
  }
  const options = [];
  for (let cols = 1; cols <= Math.min(maxCols, count); cols++) {
    const rows = Math.ceil(count / cols);
    if (rows > maxRows) continue;
    const w = Math.floor(width / cols), h = Math.floor(height / rows);
    const aspectPenalty = Math.abs(Math.log((w / h) / 1.20));
    const rowPenalty = count >= 3 && rows === 1 && maxRows >= 2 ? 3 : 0;
    options.push({cols,rows,score:aspectPenalty+rowPenalty+(cols*rows-count)*0.03});
  }
  options.sort((a,b)=>a.score-b.score||a.cols-b.cols);
  const choice=options[0];
  return Array.from({length:count},(_,i)=>{
    const col=i%choice.cols, row=Math.floor(i/choice.cols);
    const x1=left+Math.floor(col*width/choice.cols);
    const x2=left+Math.floor((col+1)*width/choice.cols);
    const y1=top+Math.floor(row*height/choice.rows);
    const y2=top+Math.floor((row+1)*height/choice.rows);
    return {left:x1,top:y1,width:x2-x1,height:y2-y1};
  });
}

export function layoutOverlaps(rectangles) {
  for (let i=0;i<rectangles.length;i++) for(let j=i+1;j<rectangles.length;j++) {
    const a=rectangles[i],b=rectangles[j];
    if (a.left < b.left+b.width && b.left < a.left+a.width &&
        a.top < b.top+b.height && b.top < a.top+a.height) return true;
  }
  return false;
}
