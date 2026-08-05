/**
 * Self-updating, on Windows only.
 *
 * macOS is deliberately excluded. Squirrel.Mac verifies that an update is
 * signed by the same identity as the running app, and this app has no Developer
 * ID. Attempting it would fail on every check and fill the log with noise, so
 * the Mac build is updated by rebuilding it.
 *
 * Updates download in the background and install when the app next quits.
 * Nothing interrupts a session: a quest log that restarts itself mid-game is
 * worse than one that is a version behind.
 */

const { autoUpdater } = require('electron-updater')

// Six hours. Frequent enough that a fix lands the same evening, rare enough to
// be invisible.
const CHECK_INTERVAL = 6 * 60 * 60 * 1000

/**
 * @param {Function} onStatus Called with a short human-readable status, or null
 *   when there is nothing worth saying.
 */
function start (app, onStatus) {
  // In development there is no app-update.yml, and every check throws.
  if (!app.isPackaged || process.platform !== 'win32') return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', info => onStatus(`version ${info.version} ready, restart to apply`))

  // Reported rather than swallowed, but never as a dialog: being unable to
  // reach GitHub is not something the user needs to act on mid-session.
  autoUpdater.on('error', error => console.error('Update check failed:', error.message))

  autoUpdater.checkForUpdates()
  setInterval(() => autoUpdater.checkForUpdates(), CHECK_INTERVAL)
}

module.exports = { start }
