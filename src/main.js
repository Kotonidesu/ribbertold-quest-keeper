/**
 * Electron main process. Owns the overlay window, tray menu and global
 * shortcuts, and is the only place that talks to Supabase.
 *
 * The renderer is sandboxed and asks for everything over IPC (see preload.js),
 * so the access token and the project key never reach the page.
 *
 * Campaigns live on the server. Nothing about them is stored on disk any more
 * beyond the session and which campaign this machine is looking at.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, screen, nativeImage, clipboard } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const remote = require('./remote')
const { signIn, signOut, currentUser } = require('./auth')
const updates = require('./updates')

const WIDTH = 380
const MARGIN = 24
const TOGGLE_SHORTCUT = 'CommandOrControl+Shift+Q'

let win = null
let tray = null
let clickThrough = false
let channel = null
let channelStatus = 'CLOSED'
let updateStatus = null

// Which campaign is on screen is this machine's preference, not shared state:
// two players in the same campaign should not shove each other's view around.
const prefsPath = () => path.join(app.getPath('userData'), 'prefs.json')

function readPrefs () {
  try {
    return JSON.parse(fs.readFileSync(prefsPath(), 'utf8'))
  } catch {
    return {}
  }
}

function writePrefs (prefs) {
  fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2))
}

function createWindow () {
  const { workArea } = screen.getPrimaryDisplay()

  win = new BrowserWindow({
    width: WIDTH,
    height: 400,
    x: workArea.x + workArea.width - WIDTH - MARGIN,
    y: workArea.y + MARGIN,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    // Load-bearing, see the note below setAlwaysOnTop.
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // These three lines together, plus fullscreenable:false above, are what put
  // the panel over a fullscreened Roll20 on macOS. Confirmed working; do not
  // simplify any of them away.
  //
  // 'screen-saver' is the highest level that still behaves, and plain
  // alwaysOnTop loses to other floating windows. visibleOnFullScreen is what
  // reaches another app's fullscreen Space, and it only holds while this window
  // cannot itself go fullscreen.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

function setClickThrough (enabled) {
  clickThrough = enabled
  // forward:true keeps hover events flowing to the renderer so the panel can
  // still react visually while being transparent to clicks.
  win.setIgnoreMouseEvents(enabled, { forward: true })
  buildTrayMenu()
}

function buildTrayMenu () {
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: win && win.isVisible() ? 'Hide quest log' : 'Show quest log',
      accelerator: TOGGLE_SHORTCUT,
      click: toggleVisibility
    },
    {
      label: 'Click through',
      type: 'checkbox',
      checked: clickThrough,
      click: () => setClickThrough(!clickThrough)
    },
    { type: 'separator' },
    ...(updateStatus ? [{ label: `Update ${updateStatus}`, enabled: false }, { type: 'separator' }] : []),
    { label: 'Quit', role: 'quit' }
  ]))
}

function toggleVisibility () {
  if (win.isVisible()) {
    win.hide()
  } else {
    // show() rather than showInactive(): on macOS an unactivated transparent
    // frameless window gets no mouse-tracking region, so every click falls
    // through to whatever is behind it.
    win.show()
    win.setIgnoreMouseEvents(clickThrough, { forward: true })
  }
  buildTrayMenu()
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide()

  createWindow()

  // macOS gets a template image and inverts it itself. Windows does no such
  // inversion and its taskbar may be light or dark, so it gets a pale fill with
  // a dark outline that reads on either.
  const icon = process.platform === 'win32' ? 'tray-win.png' : 'trayTemplate.png'

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', icon)))
  tray.setToolTip('Ribbertold Quest Keeper')
  buildTrayMenu()

  // Fails silently if another app already owns the combination, which would
  // quietly leave the tray as the only way to bring a hidden panel back.
  if (!globalShortcut.register(TOGGLE_SHORTCUT, toggleVisibility)) {
    console.error(`Ribbertold Quest Keeper: could not register ${TOGGLE_SHORTCUT}. Use the menu bar icon to show the panel.`)
  }

  updates.start(app, status => {
    updateStatus = status
    buildTrayMenu()
  })
})

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => globalShortcut.unregisterAll())

/**
 * Everything the panel needs to draw itself, in one object.
 *
 * Returns a `user` of null when signed out rather than throwing, because being
 * signed out is a normal state the panel renders, not a failure.
 */
async function buildState () {
  const user = await currentUser()
  if (!user) return { user: null }

  const campaigns = await remote.load(user.id)
  const prefs = readPrefs()

  // A remembered campaign that has since been left or deleted must not leave
  // the panel pointing at nothing.
  const active = campaigns.some(c => c.id === prefs.activeCampaignId)
    ? prefs.activeCampaignId
    : (campaigns[0] && campaigns[0].id) || null

  return {
    user: { id: user.id, name: user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name) },
    campaigns,
    activeCampaignId: active,
    live: channelStatus === 'SUBSCRIBED'
  }
}

/**
 * Keeps the panel in step with whatever anyone else changes.
 *
 * Changes are coalesced before reloading. A single edit elsewhere can produce
 * several row events, and a reorder produces two updates in quick succession,
 * so reacting to each one would mean several redundant round trips for one
 * visible change.
 *
 * This client's own writes come back too. Rather than suppress them, which
 * risks dropping a genuine change that lands in the same window, the extra
 * reload is simply allowed: it is idempotent, and correctness is worth more
 * than the saved request.
 */
function startRealtime () {
  if (channel) return

  let pending = null

  channel = remote.subscribe(
    () => {
      clearTimeout(pending)
      pending = setTimeout(async () => {
        if (!win || win.isDestroyed()) return
        win.webContents.send('state:changed', await buildState())
      }, 250)
    },
    status => {
      // Remembered as well as sent. The channel announces its status once, when
      // it connects, so a renderer that loads or reloads afterwards would never
      // hear it and would claim to be offline while working perfectly.
      channelStatus = status

      if (!win || win.isDestroyed()) return
      // The panel says so when live updates stop arriving, because a quest log
      // that has quietly stopped updating is worse than one that admits it.
      win.webContents.send('realtime:status', status)
    }
  )
}

ipcMain.handle('state:load', async () => {
  const state = await buildState()
  if (state.user) startRealtime()
  return state
})

ipcMain.handle('auth:signIn', async () => {
  await signIn()
  startRealtime()
})

ipcMain.handle('auth:signOut', async () => {
  if (channel) {
    await channel.unsubscribe()
    channel = null
  }
  await signOut()
})

ipcMain.handle('campaign:setActive', (event, id) => {
  writePrefs({ ...readPrefs(), activeCampaignId: id })
})

ipcMain.handle('data:mutate', async (event, action) => {
  const user = await currentUser()
  if (!user) throw new Error('Sign in first')

  return remote.mutate(action, user.id)
})

ipcMain.handle('campaign:join', async (event, code) => {
  const campaignId = await remote.joinCampaign(code)

  // Joining makes a campaign appear for the first time, so open it rather than
  // leaving the user to hunt for it behind the chevrons.
  writePrefs({ ...readPrefs(), activeCampaignId: campaignId })
  return campaignId
})

// Via main rather than navigator.clipboard, which needs a secure context the
// file:// renderer does not reliably count as.
ipcMain.on('clipboard:write', (event, text) => clipboard.writeText(text))

ipcMain.on('window:hide', () => {
  win.hide()
  buildTrayMenu()
})

// The panel sizes itself to its content; the window follows so the transparent
// area never swallows clicks meant for whatever is behind it.
ipcMain.on('window:fit', (event, height) => {
  const { workArea } = screen.getPrimaryDisplay()
  const { x, y } = win.getBounds()
  const capped = Math.min(Math.ceil(height), workArea.height - MARGIN * 2)

  // Height only. Re-deriving x/y here would yank the panel back to the corner
  // every time it collapses or a quest is ticked off.
  win.setBounds({ x, y, width: WIDTH, height: capped })
})
