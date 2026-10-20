# prompt-helper Chrome extension

This optional Chrome Manifest V3 extension watches **only the focused, active
ChatGPT or Claude conversation tab**. When the user pastes a long `SOURCE_DIR` /
`FILE` dump or an annotated `Path:` file into the chat composer, it sends source
to the locally running prompt-helper backend (`127.0.0.1:5173` by default).
The backend isolates versions by `(provider, conversation ID)` and exposes one
current session diff per conversation. The extension automatically replaces an
eligible paste with only the incremental diff for that paste; the toolbar popup
can retrieve/copy the combined session diff. If the backend fails, the original
paste is restored. Automatic replacement can be disabled from the popup.

The source **is not sent to any third-party server by the extension**. Once a
diff is inserted into the provider's composer, however, sending that chat
message transmits the diff to that provider. Carefully review sensitive source.

## Build and install

```bash
make build-chrome-plugin
```

Visit `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
and select `<repo>/dist/chrome/prompt-helper-chrome`. Chrome does not directly
install locally built ZIP extensions; the ZIP is for redistribution or extracting
before loading unpacked.

Start the application before using it:

```bash
make build-up
```

## Session rules

- ChatGPT: `https://chatgpt.com/c/<conversation-id>` (also `chat.openai.com`).
- Claude: `https://claude.ai/chat/<conversation-id>`.
- A brand-new conversation has no stable ID until the website assigns one; the
  extension then becomes active. Other browser windows do not count if unfocused.
- `plugins/chrome/session.js` enforces the supported chat URL and source format.
- Each session keeps independent file baselines. Every paste produces one
  incremental response; the backend maintains **one combined current session
  diff**, updated as further pastes arrive.
- Baselines are local PostgreSQL records; they survive Chrome restarts. No
  content is read directly from source paths supplied in the paste.
- Changing the extension's endpoint only allows `http://127.0.0.1:<port>` or
  `http://localhost:<port>`, never a remote hostname.
- The required session table migration runs on backend startup, including for
  databases created before this feature.

### Local API

```text
POST /api/v1/chat-sessions/diff
Content-Type: application/json
{"provider":"chatgpt", "conversation_id":"...", "content":"<annotated source>"}

GET /api/v1/chat-sessions/diff?provider=chatgpt&conversation_id=...
```

The POST response's `llm_diff` is the incremental paste diff. `session_diff`
holds the current combined baseline-to-current view for the whole conversation.
