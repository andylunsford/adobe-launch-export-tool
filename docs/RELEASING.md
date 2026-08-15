# Releasing

Installers for all three platforms are built by GitHub Actions. You do not need
a Mac to ship the macOS build.

## Cutting a release

```bash
npm version minor && git push --follow-tags
```

Pushing a `v*` tag triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which builds on `macos-latest`, `windows-latest`, and `ubuntu-latest` in
parallel and attaches the results to a **draft** GitHub Release:

| Platform | Artifact |
| --- | --- |
| macOS | `.dmg` (universal) |
| Windows | `.exe` (NSIS installer, x64) |
| Linux | `.AppImage` (x64 + arm64) |

The Release is left as a draft on purpose — review the artifacts, then publish
it manually from the GitHub UI.

To smoke-test installers without cutting a release, run the workflow manually
from **Actions → Release → Run workflow**. The build matrix runs and uploads
artifacts, but the publish job is skipped for non-tag runs.

## Code signing

Signing is wired into the workflow but **inactive**. With no secrets set, builds
succeed and produce unsigned installers, and the workflow log carries a warning
for each platform. Adding the secrets below turns signing on — no workflow edit
required.

Unsigned means macOS users hit a Gatekeeper block (right-click → **Open** to
bypass) and Windows users hit a SmartScreen warning (**More info** → **Run
anyway**). For an audience on managed corporate machines, both are likely to be
hard blocks rather than warnings, since endpoint policy often disallows the
bypass entirely.

### macOS

Requires an Apple Developer Program membership ($99/yr) and a **Developer ID
Application** certificate.

Export the cert as a `.p12`, then base64 it:

```bash
base64 -i DeveloperID.p12 | pbcopy
```

Add these repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | base64 of the `.p12` |
| `MAC_CSC_KEY_PASSWORD` | the `.p12` export password |

That covers signing. **Notarization** — required for macOS 10.15+ to launch the
app without a warning — additionally needs an app-specific password from
appleid.apple.com:

| Secret | Value |
| --- | --- |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password |
| `APPLE_TEAM_ID` | 10-character Team ID |

The workflow already passes these three through. To make electron-builder act on
them, add a `notarize` block to `build.mac` in `package.json`:

```json
"mac": {
  "hardenedRuntime": true,
  "notarize": { "teamId": "YOURTEAMID" }
}
```

Signing without notarizing is worse than useless on modern macOS — do both or
neither.

### Windows

Two routes:

- **Azure Trusted Signing** (~$10/month) — the cheapest current option, and
  supported directly now that the project is on electron-builder 26. Needs an
  `azureSignOptions` block in `build.win` plus Azure credentials as secrets. No
  hardware token, so it works in CI.
- **Traditional OV certificate** ($200–400/yr) — since June 2023 these ship on
  hardware tokens, which CI cannot read. Usable only via a cloud signing service
  or a self-hosted runner.

Azure Trusted Signing is the recommended route; the OV path exists mainly if you
already own a certificate.

For the OV/`.p12` route, add:

| Secret | Value |
| --- | --- |
| `WIN_CSC_LINK` | base64 of the `.pfx`/`.p12` |
| `WIN_CSC_KEY_PASSWORD` | the export password |

Note that OV certificates build SmartScreen reputation gradually — the warning
persists for a while after the first signed release. EV certificates get
immediate reputation, at higher cost.

## Known risks

**macOS universal build + native module.** `build.mac` targets `universal`,
which makes electron-builder produce x64 and arm64 app bundles and merge them.
`better-sqlite3` is a native module, and `postinstall` (`electron-rebuild -f -w
better-sqlite3`) rebuilds it only for the runner's own architecture —
`macos-latest` is arm64. If the merge step fails on a mismatched binary, the fix
is to drop the universal target in favour of two per-arch DMGs:

```json
"target": [{ "target": "dmg", "arch": ["x64", "arm64"] }]
```

That produces two downloads instead of one, but builds reliably. This is the
most likely first-run failure; everything else in the matrix is standard.
