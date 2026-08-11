#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VERSION="${EVEJS_CHARACTER_IMPORT_VERSION:-1.0.0}"
NAME="evejs-character-import-v${VERSION}"
DIST="${REPO_ROOT}/dist"
STAGE="${DIST}/.stage-${NAME}"

rm -rf "${STAGE}"
mkdir -p "${STAGE}/evejs-character-import/lib" "${DIST}"

cp -a \
  "${SCRIPT_DIR}/evejs-character-import.js" \
  "${SCRIPT_DIR}/package-kit.sh" \
  "${SCRIPT_DIR}/README.md" \
  "${SCRIPT_DIR}/GUIDE.md" \
  "${SCRIPT_DIR}/NOTICE.md" \
  "${STAGE}/evejs-character-import/"
cp -a "${SCRIPT_DIR}/lib/." "${STAGE}/evejs-character-import/lib/"

cat > "${STAGE}/evejs-character-import/INSTALL.txt" <<'INST'
EveJS Character Import
======================

1. Place at: <evejs-install>/tools/evejs-character-import/
2. Read GUIDE.md
3. package --export-dir /path/to/character-export-folder
4. import --bundle path/to/players-bundle.json  (server stopped)

Does not perform ESI SSO. Bring your own character data export folder.
INST

chmod +x "${STAGE}/evejs-character-import/evejs-character-import.js" \
  "${STAGE}/evejs-character-import/package-kit.sh"

tar -C "${STAGE}" -czf "${DIST}/${NAME}.tar.gz" evejs-character-import
python3 - <<PY
import pathlib, zipfile
stage = pathlib.Path("${STAGE}")
out = pathlib.Path("${DIST}/${NAME}.zip")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    root = stage / "evejs-character-import"
    for path in root.rglob("*"):
        if path.is_file():
            zf.write(path, path.relative_to(stage).as_posix())
print(out)
PY
(cd "${DIST}" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256" && sha256sum "${NAME}.zip" > "${NAME}.zip.sha256")
rm -rf "${STAGE}"
echo "Wrote ${DIST}/${NAME}.tar.gz and .zip"
