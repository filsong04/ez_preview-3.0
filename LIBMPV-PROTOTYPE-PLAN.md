# libmpv playback prototype plan

## Why this stays separate

The current EZ Preview renderer uses an HTML `<video>` element as the source for LUT rendering, scopes, split comparison, playback events, and PNG capture. A libmpv-backed element is not a drop-in replacement; frame access and synchronization for those features must be proven before integration.

## Candidate to evaluate

`electron-mpv-video` is a candidate because it aims to bring libmpv playback into Electron while keeping HTML UI overlays, and currently documents native targets for Windows x64 and macOS arm64. It requires an external libmpv SDK/runtime and a source-built native addon. Its shared-texture renderer requires Electron 40+ and currently lists Electron 40.10.5 as its test baseline, so our Electron version must be tested rather than assumed compatible.

Project: https://github.com/yscoder/electron-mpv-video
libmpv render API examples: https://github.com/mpv-player/mpv-examples/tree/master/libmpv

## Required prototype tests

- Windows x64 and macOS Apple Silicon build and launch.
- Open representative MP4/H.264, HEVC MOV, ProRes MOV, MPEG-2 MXF, XAVC/MXF, and camera RAW samples.
- Measure import-to-first-frame time and CPU use against the existing renderer.
- Verify seeking, pause/play, audio, aspect fit, fullscreen, LUT, scopes, split comparison, and PNG capture.
- Keep Chromium playback as fallback until the new renderer passes these tests.

## Constraints / risks

- The candidate does not currently list macOS Intel as a supported native target; the existing app has a macOS Intel profile. The existing Chromium renderer may need to remain as a fallback for Intel Macs.
- Native builds require the matching libmpv headers, link libraries, runtime files, and platform build tooling. The final app must bundle required dependencies.
- libmpv/mpv and the FFmpeg build have separate license obligations. Verify the precise configuration and third-party notices before distributing it.
- Do not add this dependency to the shipping package until a separate prototype passes platform and feature tests.
