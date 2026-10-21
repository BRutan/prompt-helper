# Install in the already-open Google Chrome window (macOS)

From the prompt-helper repository root:

```sh
make install-chrome-plugin
```

The command runs the existing MV3 packager, writing
`dist/chrome/prompt-helper-chrome/` and `dist/chrome/prompt-helper-chrome.zip`.
It then uses macOS Accessibility GUI automation to open **chrome://extensions**
in a new tab of your currently open **Google Chrome** window. If the extension
is already installed, it tries to reload only that extension card. Otherwise,
it enables Developer mode when necessary and selects the unpacked folder using
the Chrome **Load unpacked** dialog. It returns to your original tab after a
successful operation. It never opens Chromium, restarts Google Chrome, or uses
Chrome's removed `--load-extension` command-line flag.

## macOS security permissions

When prompted, grant the terminal app that runs `make` (e.g., Terminal/iTerm)
permission in **System Settings > Privacy & Security > Accessibility** and
**Automation > System Events / Google Chrome**. Without these permissions,
Chrome does not allow its controls to be manipulated automatically. The
command will fail clearly and leave the extensions tab open for manual action;
it will **not** report a successful install.

Chrome's Accessibility representation and button names are version/locale
specific. The automation supports the English UI; if it cannot find a control
or verify an extension card, use the path shown by the error to load the
unpacked extension manually. An enterprise-managed Chrome policy may block
Developer mode or third-party extensions entirely.

## Options

```sh
make install-chrome-plugin OUTPUT=/path/to/build
make install-chrome-plugin DRY_RUN=1
```

This loads only the Chrome extension. The patch-application feature additionally
requires the existing native messaging host, registered for the extension's ID
using `plugins/native_host/install.py --extension-id <chrome-extension-id>`.
To get the ID, visit `chrome://extensions` with Developer mode enabled.
