# EZ Preview · Release Candidate 2 (v1.0.0-rc.3)

EZ Preview is a local video/LUT preview desktop app. This package is the cross-platform release-build source, based on the verified Stage 24 app and branded with the supplied EZ logo.

## App branding

The custom black-and-yellow EZ mark is bundled as `build/icon.icns`, `build/icon.ico`, `build/icon.png`, and `build/icon.svg`. The original supplied image is preserved at `build/ez-logo-original.png`; details are in `build/ICON-ASSETS-README.md`.

## Installers to be built

- **macOS 12+ Intel:** DMG and ZIP, Electron 44.9.0
- **macOS 12+ Apple silicon:** DMG and ZIP, Electron 44.9.0
- **macOS Catalina 10.15 Intel legacy:** DMG and ZIP, Electron 32.3.3. This runtime has reached end-of-support and is offered as a compatibility build only.
- **Windows x64:** NSIS installer and portable executable, Electron 44.9.0

The release candidate source is not itself an installer. Build outputs are created by the `.github/workflows/build-release.yml` workflow on native platform runners. The normal installed application bundles Electron and FFmpeg, so end users do not need Node.js/npm and video processing runs locally.

## Current validation status

The release preflight and all included native smoke tests passed in the available Linux authoring environment, including the supplied-logo icon checks, proxy/audio generation, PNG export, LUT storage, cache reuse, cancellation, fullscreen geometry, and bilingual UI checks. This environment cannot reach npm's registry and is not a native macOS/Windows signing environment, so the `.dmg`, `.app`, `.exe`, and NSIS installer have **not** been generated or signed here. The GitHub Actions workflow creates the platform-specific RC artifacts after this source is pushed to a repository.

## Build and QA

Import-speed changes are documented in [IMPORT-SPEED-PASS1.md](IMPORT-SPEED-PASS1.md), while the libmpv experiment remains separate in [LIBMPV-PROTOTYPE-PLAN.md](LIBMPV-PROTOTYPE-PLAN.md).

See [BUILD-RELEASE.md](BUILD-RELEASE.md) for build instructions, [PUBLISH-RC3.md](PUBLISH-RC3.md) for the guided GitHub Actions setup, and [RELEASE-BLOCKERS.md](RELEASE-BLOCKERS.md) for requirements before a paid public release. The current app feature set is preserved: LUT library, audio, 960/1920 proxy modes, fullscreen aspect-ratio handling, media browser/folder queue, persistent proxy cache, fullscreen, KO/EN UI, and original-resolution PNG with preview-capture fallback.

Automated smoke tests are run for each OS build. They are not a substitute for opening and installing each produced artifact on a clean target system.
