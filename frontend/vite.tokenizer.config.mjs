// Path: frontend/vite.tokenizer.config.mjs
// Merge WASM support into the repository's existing Vite config, if present.
// Anthropic's legacy tokenizer depends on tiktoken's ESM WASM integration.
// Modern browsers support top-level await natively; avoiding the TLA transform
// also avoids its incompatible @swc/core printSync() pass during bundling.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadConfigFromFile, mergeConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig(async (env) => {
  const previousConfigs = [
    'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs',
  ];
  const previousFile = previousConfigs
    .map((filename) => resolve(process.cwd(), filename))
    .find((filename) => existsSync(filename));

  // Do not discard a pre-existing config's aliases, plugins, or build options.
  let previous = {};
  if (previousFile) {
    const loaded = await loadConfigFromFile(env, previousFile, process.cwd());
    if (!loaded) {
      throw new Error(`Unable to load existing Vite config: ${previousFile}`);
    }
    // Vite configurations may export a plain object, an async function, or
    // a promise. Resolve that export before merging our two plugins.
    const exported = await loaded.config;
    previous = typeof exported === 'function' ? await exported(env) : exported;
  }

  return mergeConfig(previous, {
    plugins: [wasm()],
    // vite-plugin-wasm emits native top-level await for module initialization.
    // `esnext` is required when not using vite-plugin-top-level-await.
    build: { target: 'esnext' },
  });
});
