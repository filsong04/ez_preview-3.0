# Import speed pass 1

## What changed

1. The original media file is still assigned directly to the HTML video element first.
2. Automatic background proxy prebuilding now starts paused. Importing a folder no longer automatically starts FFmpeg jobs for every non-current clip. The existing Resume queue control remains available for deliberate proxy prebuilding.
3. The native FFmpeg metadata probe now waits for `loadeddata`, then yields 900 ms before probing. Opening Video Info triggers the probe immediately. This avoids competing with first-frame loading for ordinary directly playable files.
4. If Chromium cannot decode a selected clip, the existing compatibility-proxy fallback is unchanged.

## Expected impact and limits

This pass is designed to improve initial responsiveness for directly playable files and folders with many clips by avoiding automatic background transcodes and deferring metadata inspection. The time saved has not yet been measured. Unsupported active media can still wait for an FFmpeg proxy to finish; that is the target for a separate libmpv prototype.

## Manual A/B test

On the same Windows PC and the same media files, compare RC2 with RC3: (a) one H.264 MP4, (b) a folder with 10 or more clips, and (c) one MXF or ProRes file. Time from clicking Open to the first visible frame; note CPU use and UI responsiveness. Do not compare different files or preview-resolution settings.
