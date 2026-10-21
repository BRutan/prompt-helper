import test from 'node:test';
import assert from 'node:assert/strict';
import {checkForBuildUpdate, watchBuilds} from '../chrome/build-watch.js';
const one = 'a'.repeat(32), two = 'b'.repeat(32);
function browser() {
  let listener;
  let reloads = 0;
  const state = {};
  return {
    state,
    get listener() {return listener;},
    get reloads() {return reloads;},
    runtime: {getURL: file => `chrome-extension://test/${file}`, reload: () => {reloads++;}},
    storage: {local: {get: async key => ({[key]: state[key]}), set: async values => Object.assign(state, values)}},
    alarms: {onAlarm: {addListener: fn => {listener = fn;}}, create: async () => {}},
  };
}
const fetchId = id => async (_url, options) => {
  assert.equal(options.cache, 'no-store');
  return {ok: true, json: async () => ({build_id: id})};
};
test('load new build only once', async () => {
  const api = browser();
  assert.equal(await checkForBuildUpdate(api, fetchId(one)), 'initialized');
  assert.equal(await checkForBuildUpdate(api, fetchId(one)), 'unchanged');
  assert.equal(await checkForBuildUpdate(api, fetchId(two)), 'reloaded');
  assert.equal(api.reloads, 1);
  assert.equal(await checkForBuildUpdate(api, fetchId(two)), 'unchanged');
});
test('reject incomplete marker', async () => {
  const api = browser();
  assert.equal(await checkForBuildUpdate(api, async () => ({ok:false})), 'not-ready');
  assert.equal(await checkForBuildUpdate(api, fetchId('oops')), 'invalid-marker');
  assert.equal(api.reloads, 0);
});
test('alarm checks only expected alarm name', async () => {
  const api = browser();
  watchBuilds(api, fetchId(one));
  await new Promise(resolve => setImmediate(resolve));
  api.listener({name:'other'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.reloads, 0);
  api.listener({name:'prompt-helper-build-watch'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.reloads, 0);
});
