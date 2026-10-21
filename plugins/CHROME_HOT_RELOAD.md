# prompt-helper: live Chrome installer

Run `make install-chrome-plugin` (or `make build-chrome-plugin`) inside prompt-helper.
The Make targets intentionally use **`plugins/chrome_live.py`** instead of the
older `install_chrome_plugin.py` + AppleScript path. Those old files have been
left untouched so this patch applies to checkouts with different local edits.

On first install Chrome requires explicit user approval: open `chrome://extensions`,
enable **Developer mode**, click **Load unpacked**, and choose the folder printed
by the command (`dist/chrome/prompt-helper-chrome`). The installer opens the
page in the current Google Chrome application and copies the folder to your
clipboard. In the macOS folder chooser use Cmd+Shift+G, paste, Return.

After first install, the unpacked directory stays at the same path. Each build
writes files atomically and updates `build.json` last. The MV3 background worker
checks the build ID using `chrome.alarms` roughly every 30 seconds and calls
`chrome.runtime.reload()` on changes. If you installed the extension before
adding this watcher, click **Reload once** in `chrome://extensions` to activate
it. Later builds need no manual interaction.

No Chromium, Chrome for Testing, new profile, browser restart, or Chrome
`--load-extension` flag is used. This mechanism does not bypass Chrome's
initial local extension approval and cannot modify an enterprise policy.

`make install-chrome-plugin DRY_RUN=1` builds but leaves Chrome untouched.
