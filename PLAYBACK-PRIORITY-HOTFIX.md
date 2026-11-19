# EZ Preview RC4 · Playback priority

## Changes

- Selecting another clip no longer waits for an active compatibility conversion.
- The previous conversion job is invalidated immediately so a late FFmpeg result cannot replace the newly selected source.
- Desktop native FFmpeg conversion is canceled asynchronously when switching clips.
- Browser FFmpeg fallback is terminated when switching clips.
- Native compatibility jobs re-check their identity after yielding to the background queue and stop if they are stale.
- Existing direct-original playback, paused-by-default background proxy queue, deferred metadata probe, and compatibility fallback remain in place.

## Scope and verification

This is a targeted playback-priority improvement on the RC3 source. It does not replace Chromium with libmpv, and it does not claim universal RAW codec support. Existing LUT, scopes, split comparison, adjustments, audio, fullscreen, and PNG export code is retained.

Run `npm run test:native` and perform Windows GUI A/B tests with H.264 MP4, HEVC MOV, ProRes/MXF, and a folder containing at least 10 clips. A Windows EXE has not been built or validated by this source-package update.
