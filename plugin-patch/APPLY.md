# Plugin Patch: Inbound Image/File/Video/Audio Support

This directory contains the updated files for the `openclaw-feishu` plugin
(https://github.com/AlexAnys/openclaw-feishu) that add inbound media support.

## Files

| File | Target | Description |
|------|--------|-------------|
| `inbound-media.ts` | `src/inbound-media.ts` | **NEW** - Core inbound media module |
| `receive.ts` | `src/receive.ts` | **MODIFIED** - Updated to handle all message types |
| `inbound-media.unit.test.mjs` | `test/inbound-media.unit.test.mjs` | **NEW** - 18 unit tests |
| `receive.text.integration.test.mjs` | `test/receive.text.integration.test.mjs` | **MODIFIED** - Added messageResource mock |

## How to apply

```bash
cd ~/openclaw-feishu

# Copy new file
cp plugin-patch/inbound-media.ts src/

# Copy updated file
cp plugin-patch/receive.ts src/

# Copy test files
cp plugin-patch/inbound-media.unit.test.mjs test/
cp plugin-patch/receive.text.integration.test.mjs test/

# Build and test
npm run build && npm run test:ci
```

## What changed

### Before
- `receive.ts` line 116: `if (messageType !== "text" || !message.content) return;`
- Only text messages were processed; images/files/video/audio silently ignored.

### After
- All 6 Feishu message types supported: text, post, image, media, file, audio
- Images downloaded as base64 data URL attachments
- Files/video/audio downloaded to temp paths with auto-cleanup
- Rich text posts parsed for embedded images
- normalizeFeishuText fixes Feishu list quirk (marker split across lines)
- Group chat filter: attachment-only messages require @mention
