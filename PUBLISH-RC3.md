# Publish EZ Preview RC3 to GitHub Actions

This creates a private source repository and runs the macOS/Windows release-candidate builds. It does **not** publish a public app release by itself.

## 1. Create an empty private repository

On GitHub, create a new **private** repository (for example `ez-preview-release`). Do not pre-add a README, license, or `.gitignore`, because this source folder already contains its own files.

## 2. Run the push helper on your Mac

1. Download and extract `EZ-Preview-Release-RC3-BuildKit.zip`.
2. Open Terminal and change into the extracted `ez_preview_release_rc3` folder.
3. Run:

   ```bash
   ./scripts/publish-rc3-to-github.sh
   ```

4. Paste the URL for the empty private GitHub repository, then type `PUSH` when the confirmation prompt appears.

The helper initializes Git, pushes the source to `main`, and creates/pushes `v1.0.0-rc.3`. GitHub Actions should start automatically. It will not touch an existing `.git` folder and it asks for explicit confirmation before any push.

If Git is missing, run `xcode-select --install` in Terminal to install Apple's Command Line Tools, then retry.

## 3. Watch the builds

Open the repository's **Actions** tab and open **Build EZ Preview release candidates**. The workflow produces artifacts for:

- macOS 12+ Intel: DMG + ZIP
- macOS 12+ Apple silicon: DMG + ZIP
- macOS Catalina Intel compatibility build: DMG + ZIP (Electron 32.3.3, end-of-support)
- Windows x64: NSIS installer + portable EXE

Download the build artifacts from the completed workflow run. The artifacts include the build-profile lockfile, SPDX SBOM, FFmpeg build/license reports, third-party notice draft, and SHA-256 checksums.

## 4. Important release boundary

Without signing secrets, the CI builds are for internal RC testing and will be unsigned/unnotarized. Do not sell or publicly distribute them as a polished release. Before a paid release, finish the gates in `RELEASE-BLOCKERS.md`, particularly FFmpeg/GPL compliance, app terms/publisher identity, code signing/notarization, and clean-machine QA. GitHub Actions cannot provide signing identities or legal clearance automatically.
