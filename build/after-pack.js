/**
 * Ad-hoc signs the macOS bundle after packing.
 *
 * Without this the app keeps Electron's own linker signature, which claims
 * `Identifier=Electron` and does not match the bundle around it. Gatekeeper
 * rejects that outright with "code has no resources but signature indicates
 * they must be present", and Finder refuses to launch it. Running the binary
 * directly still works, which makes the fault easy to miss in testing and
 * guaranteed to show up for whoever you send the build to.
 *
 * Ad-hoc is not a substitute for a Developer ID: a downloaded copy is still
 * quarantined and still needs right-click then Open the first time. It only
 * ensures the signature is coherent rather than broken.
 */

const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack (context) {
  if (context.electronPlatformName !== 'darwin') return

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
