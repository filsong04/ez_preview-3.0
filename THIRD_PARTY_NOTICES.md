# Third-party notices · Release candidate draft

EZ Preview includes third-party software. This file is a draft inventory, not a completed public-release legal notice.

## FFmpeg binary

- Package: `ffmpeg-static` npm package, version 5.3.0
- Package-declared license: GPL-3.0-or-later
- Project: https://github.com/eugeneware/ffmpeg-static
- Package metadata: https://www.npmjs.com/package/ffmpeg-static
- Binary sources described by the package include separately built Windows and macOS binaries.

The exact FFmpeg binary and its compile-time options must be inspected for each platform build. It may include GPL components, including libx264. Before distribution, include the required full license text, notices, corresponding source/build configuration or a compliant source-offer mechanism, and any further notices for libraries included by the binary. Do not treat this draft as proof of compliance.

## Electron and electron-builder

- Electron is MIT-licensed: https://github.com/electron/electron
- electron-builder is MIT-licensed: https://github.com/electron-userland/electron-builder

The full app dependency tree contains additional third-party packages. Keep `package-lock.json` with each release and generate a complete license inventory/SBOM before public distribution.

## Build profile note

The normal release candidate uses Electron 44.9.0. The optional Catalina-compatible legacy artifact uses Electron 32.3.3, which has reached end-of-support. See `RELEASE-BLOCKERS.md`.
