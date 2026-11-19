# RC3 import-speed and build notes

## Import-speed pass 1

- Preserved the direct HTML video playback path as the first attempt.
- Background proxy prebuilding now starts paused by default for each app session. Importing a folder therefore no longer starts FFmpeg conversions for every non-current item; users can explicitly resume the existing proxy queue when prebuilding is desired.
- Deferred the extra native FFmpeg metadata probe until the browser has delivered its first frame, then waited 900 ms before starting the probe. Opening Video Info triggers metadata probing immediately because the user explicitly requested it.
- Selecting unsupported media still uses the existing compatibility-proxy fallback. This pass does not yet replace the Chromium renderer with libmpv.
- Added `scripts/smoke-test-import-performance.cjs` and wired it into the all-tests runner.
- Corrected the Electron Builder NSIS configuration and bumped the build version to `1.0.0-rc.3`.

## Validation note

In the authoring environment, JavaScript syntax checks, release preflight, and the static media-browser, fullscreen/language, branding, LUT storage, PNG fallback, and import-performance smoke tests were run. Tests that require the `ffmpeg-static` dependency could not all be executed locally because that package is not installed in this authoring environment. Windows and macOS GitHub Actions jobs must run the full suite on their target runners.

## Next: separate libmpv proof of concept

Do not merge a native renderer into the shipping app yet. The current UI assumes an HTML video element for LUT processing, scopes, split comparison, playback events, and PNG capture. The next experiment should be a separate branch/prototype that validates libmpv playback and frame access without replacing the stable renderer. See `LIBMPV-PROTOTYPE-PLAN.md`.
