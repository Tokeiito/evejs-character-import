# EveJS Character Import

**v1.0.0**

Load a **personal character data export** (standard ESI dump folder layout) into
a local **EveJS** gameStore for private practice.

This tool does **not** perform EVE SSO or talk to Tranquility. Obtain a character
data export separately, then point this tool at that folder.

| Doc | Description |
|-----|-------------|
| **[GUIDE.md](./GUIDE.md)** | Walkthrough |
| **[NOTICE.md](./NOTICE.md)** | Privacy / trademarks |

## Quick start

```bash
# Build a players-bundle from an export directory
node tools/evejs-character-import/evejs-character-import.js package \
  --export-dir /path/to/export-folder
# Optional: point at the EveJS item type table explicitly
#   --type-data /path/to/gameStore/data/itemTypes/data.json

# Load into EveJS (server STOPPED)
node tools/evejs-character-import/evejs-character-import.js import \
  --bundle _local/evejs-character-import/bundles/<id>/players-bundle.json \
  --on-conflict overwrite

# Faces for character select
node tools/evejs-character-import/evejs-character-import.js restore-portraits
```

## Docker layouts

| Layout | Volume | Image |
|--------|--------|-------|
| Stock EveJS | `evejs-data` | `evejs-local` |
| DML / evejs-xeve | `evejs-xeve-data` | `evejs-xeve-local` |

Auto-detected; prompt if several match. Override with `--volume` / `--image`.

## Install from GitHub

```bash
git clone https://github.com/IM0001GT/evejs-character-import.git tools/evejs-character-import
```

## Commands

```text
package | import | portraits | restore-portraits | help
```

(`convert` / `--dump` remain as aliases.)
