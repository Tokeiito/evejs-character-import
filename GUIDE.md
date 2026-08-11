# EveJS Character Import — Guide

## Purpose

Take a **local character data export folder** and load it into a **local EveJS**
private server for practice and learning.

This tool does not connect to Tranquility and does not run ESI SSO.

## Expected export layout

Point `--export-dir` at a folder that contains:

```text
export-folder/
  account.json
  characters/
    <id>_<name>/
      public.json
      skills.json
      assets.json
      ...
```

That is the usual personal ESI dump shape produced by common character-export
tooling.

## Requirements

1. A working EveJS install (stock or DML) you can start/stop  
2. Node.js (v20+ recommended)  
3. Docker recommended (volume-backed gameStore)  

## Package (convert export → players-bundle)

```bash
node tools/evejs-character-import/evejs-character-import.js package \
  --export-dir /path/to/export-folder
```

Output under `_local/evejs-character-import/bundles/`.

Citadel hangars and similar locations are remapped to a fallback NPC station
(default **Jita 4-4**).

## Import into EveJS

**Stop the server first.**

```bash
node tools/evejs-character-import/evejs-character-import.js import \
  --bundle path/to/players-bundle.json \
  --on-conflict overwrite
```

### Docker volume names

| Layout | Volume | Image |
|--------|--------|-------|
| Stock | `evejs-data` | `evejs-local` |
| DML | `evejs-xeve-data` | `evejs-xeve-local` |

```bash
# Explicit stock
... import --bundle ... --volume evejs-data --image evejs-local
```

## Portraits

```bash
node tools/evejs-character-import/evejs-character-import.js restore-portraits
node tools/evejs-character-import/evejs-character-import.js restore-portraits --sync-only
```

On EveJS 0.12.5+, faces live in the Docker volume under
`gameStore/images/Character/`.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Wrong volume / empty characters | Pass `--volume` / `--image` for your install |
| Import while server running | Stop compose server/market first |
| Blank faces after upgrade | `restore-portraits` |
