// Path: plugins/chrome/build-watch.js
// MV3 service workers may sleep; alarms continue to wake them for update checks.
const ALARM = 'prompt-helper-build-watch';
const KEY = 'prompt-helper-build-id';
let pending = null;

export async function checkForBuildUpdate(api = chrome, fetcher = fetch) {
  if (pending) return pending;
  pending = (async () => {
    // The build marker is written last after all other unpacked files.
    const marker = api.runtime.getURL('build.json') + '?v=' + Date.now();
    const response = await fetcher(marker, {cache: 'no-store'});
    if (!response.ok) return 'not-ready';
    const data = await response.json();
    if (!/^[a-f0-9]{32}$/.test(data.build_id || '')) return 'invalid-marker';
    const old = (await api.storage.local.get(KEY))[KEY];
    if (old === data.build_id) return 'unchanged';
    // Set marker *before* reload to prevent reload loops.
    await api.storage.local.set({[KEY]: data.build_id});
    if (old) {
      api.runtime.reload();
      return 'reloaded';
    }
    return 'initialized';
  })();
  try { return await pending; }
  finally { pending = null; }
}

export function watchBuilds(api = chrome, fetcher = fetch) {
  const check = () => {
    void checkForBuildUpdate(api, fetcher).catch(error =>
      console.warn('prompt-helper: build check failed', error));
  };
  api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) check();
  });
  // Chrome 120+: periodInMinutes=0.5 (30 seconds).
  void api.alarms.create(ALARM, {periodInMinutes: 0.5});
  check();
}
