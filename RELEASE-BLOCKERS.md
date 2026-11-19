# EZ Preview · Public Release Gates

This folder is a release-candidate build system, not yet an approved paid public release.

## Required before selling or publicly distributing installers

- [ ] **FFmpeg licensing review.** `ffmpeg-static` 5.3.0 declares GPL-3.0-or-later, and the binary may include GPL components such as `libx264`. Confirm the exact binary version/configuration and all included library licenses. Prepare and distribute the corresponding source/build scripts or a legally compliant written offer as applicable, and include the full required license text and notices. Obtain qualified legal review if the app itself is intended to remain proprietary. See the draft `THIRD_PARTY_NOTICES.md` and https://www.npmjs.com/package/ffmpeg-static.
- [ ] **Copyright holder and end-user terms.** Decide the legal copyright/publisher name, product license/EULA, refund/support terms, and a contact channel. Those details were not invented in this package.
- [ ] **macOS signing and notarization.** Use a Developer ID Application certificate and Apple notarization credentials for the modern build, then verify the DMG on a clean Mac. Direct-distribution signing/notarization is important for Gatekeeper behavior on macOS 10.15+. See https://www.electron.build/docs/mac/ and https://www.electron.build/v26/docs/features/code-signing/notarization/.
- [ ] **Windows signing.** Sign the installer with a trusted code-signing certificate if feasible, then test installation/uninstallation on clean Windows 10/11 systems. Unsigned programs can trigger Microsoft SmartScreen warnings.
- [ ] **Compatibility decision.** Electron 32.3.3 is end-of-support but is the Catalina-compatible legacy runtime. Electron 33+ dropped Catalina; Electron 38+ requires macOS 12+. The legacy installer must not be described as receiving current Electron security updates.
- [ ] **Clean-machine QA.** Test Intel Catalina legacy if that target is offered, macOS 12+ Intel, macOS 12+ Apple silicon, and Windows x64. Test opening/importing folder trees, multiple clips, queue cancel/retry, sound/mute, LUT persistence, cache reuse/clear, fullscreen aspect ratio, source-resolution PNG, and preview-capture fallback.
- [ ] **Privacy statement.** Confirm the actual release build does not upload user videos/LUTs or perform unexpected network requests. Describe local-only processing accurately and disclose any future update or analytics endpoints.
- [ ] **Reproducible dependencies.** Review and commit the generated `package-lock.json` before the stable release. The release-candidate workflow creates one transient shared lock for all builds, but the lock is not committed in this source bundle.
- [ ] **Release integrity.** Record SHA-256 hashes for every installer and retain the build logs, npm lockfile, SBOM, and license inventory alongside the release. RC3 artifact jobs are configured to include the lockfile, SBOM, third-party notice draft, and checksums.

## Security and licensing context

The source currently bundles native FFmpeg as a separate executable, not as a renderer library. That does not remove the obligation to inspect the exact binary and follow its distribution terms. This checklist is engineering guidance, not legal advice.
