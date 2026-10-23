// Path: plugins/chrome/session-arrangement.js
// Plan moves using the entire Chrome window graph before changing ANY tab.
// Keep a chat in its current normal window wherever possible: recreating an
// already-isolated ChatGPT tab risks a reinitialization/security recheck.
export function planSessionWindows(sessions, windows) {
  const byWindow = new Map((windows || []).map(w=>[w.id,w]));
  const grouped = new Map();
  for (const session of sessions) {
    if (!grouped.has(session.window_id)) grouped.set(session.window_id,[]);
    grouped.get(session.window_id).push(session);
  }
  const keep = new Map();
  for (const [id, group] of grouped) {
    if (byWindow.get(id)?.type !== 'normal') continue;
    // Do not detach the selected tab just to preserve a background tab.
    const preferred = group.find(s=>s.active) || group[0];
    keep.set(preferred.tab_id,id);
  }
  return sessions.map(s=>({
    tab_id:s.tab_id,
    original_window_id:s.window_id,
    reuse_window_id:keep.get(s.tab_id) ?? null,
  }));
}
