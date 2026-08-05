/**
 * The Supabase client, and where the signed-in session is kept.
 *
 * Everything runs in the main process. The renderer never sees the client, the
 * key, or the access token: it asks over IPC and gets plain data back, which is
 * the same boundary the file-backed version had.
 */

const { createClient } = require('@supabase/supabase-js')
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const config = require('../config.json')

const SESSION_FILE = path.join(app.getPath('userData'), 'session.json')

/**
 * Session storage on disk, so signing in survives a restart.
 *
 * supabase-js expects a web Storage shape. Missing or unreadable files are
 * treated as "not signed in", which is correct on a first run and the only
 * sensible reading of a corrupted one.
 */
function fileStorage (file) {
  const readAll = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }

  const writeAll = data => fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 })

  return {
    getItem: key => readAll()[key] ?? null,
    setItem: (key, value) => {
      const data = readAll()
      data[key] = value
      writeAll(data)
    },
    removeItem: key => {
      const data = readAll()
      delete data[key]
      writeAll(data)
    }
  }
}

const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: {
    // PKCE returns the grant as a query parameter. The implicit flow returns it
    // in the URL fragment, which a browser never sends to a server, so a
    // loopback listener would never see it.
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    // Nothing navigates in the main process, so there is no URL to inspect.
    detectSessionInUrl: false,
    storage: fileStorage(SESSION_FILE)
  }
})

module.exports = { supabase, SESSION_FILE }
