/**
 * Discord sign-in.
 *
 * The hop chain is: app opens the real browser, browser goes to Discord,
 * Discord returns to Supabase, Supabase returns to a one-shot loopback server
 * this file starts. That last hop is why `http://127.0.0.1:8721/**` has to be
 * in the project's Redirect URLs allowlist.
 *
 * The system browser rather than an in-app window on purpose: users can see the
 * address bar and judge what they are signing in to, existing Discord sessions
 * and password managers work, and the app never handles the credentials.
 */

const http = require('node:http')
const { shell } = require('electron')

const { supabase } = require('./supabase')

const PORT = 8721
const REDIRECT_URL = `http://127.0.0.1:${PORT}/callback`
const TIMEOUT_MS = 3 * 60 * 1000

const DONE_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Signed in</title>
<body style="font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 4rem; color: #2f2617; background: #e6d8b8">
  <h1 style="font-weight: 600">Signed in</h1>
  <p>You can close this tab and return to Ribbertold Quest Keeper.</p>
</body>`

const FAILED_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Sign-in failed</title>
<body style="font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 4rem; color: #2f2617; background: #e6d8b8">
  <h1 style="font-weight: 600">Sign-in failed</h1>
  <p>Return to Ribbertold Quest Keeper and try again.</p>
</body>`

/**
 * Runs a server just long enough to catch one redirect back from Supabase.
 *
 * @returns {Promise<string>} The authorization code to exchange for a session.
 */
function awaitCallback () {
  return new Promise((resolve, reject) => {
    let settled = false

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URL)
      const code = url.searchParams.get('code')
      const failure = url.searchParams.get('error_description') || url.searchParams.get('error')

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(code ? DONE_PAGE : FAILED_PAGE)

      if (settled) return
      settled = true

      // Close after responding, or the browser is left waiting on a dead socket.
      server.close()
      clearTimeout(timer)

      if (code) resolve(code)
      else reject(new Error(failure || 'Discord returned no authorization code'))
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      server.close()
      reject(new Error('Timed out waiting for Discord'))
    }, TIMEOUT_MS)

    server.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      reject(error.code === 'EADDRINUSE'
        ? new Error(`Port ${PORT} is busy. Close whatever is using it and try again.`)
        : error)
    })

    // Loopback only. Binding 0.0.0.0 would expose the callback to the network.
    server.listen(PORT, '127.0.0.1')
  })
}

/**
 * Opens Discord in the browser and resolves once a session exists.
 *
 * @returns {Promise<object>} The signed-in user.
 */
async function signIn () {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'discord',
    options: { redirectTo: REDIRECT_URL, skipBrowserRedirect: true }
  })

  if (error) throw error

  // Listen before opening the browser: the round trip can complete faster than
  // the server would otherwise be ready for it.
  const codePromise = awaitCallback()
  await shell.openExternal(data.url)

  const { data: session, error: exchangeError } = await supabase.auth.exchangeCodeForSession(await codePromise)
  if (exchangeError) throw exchangeError

  return session.user
}

async function signOut () {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

/** @returns {Promise<object|null>} The current user, or null if signed out. */
async function currentUser () {
  const { data } = await supabase.auth.getSession()
  return data.session ? data.session.user : null
}

module.exports = { signIn, signOut, currentUser, REDIRECT_URL }
