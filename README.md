# Ribbertold Quest Keeper

An always-on-top quest log that sits in the top-right corner of your desktop,
styled after Skyrim's parchment journal. Campaigns live in Supabase, so a group
playing remotely shares one list, with a separate hidden list only the DM sees.

## Running it

```
npm install
npm start
```

It needs a Supabase project of its own. Copy `config.example.json` to
`config.json` and fill in the project URL and the publishable anon key, then run
`supabase/schema.sql` in the project's SQL editor. That file is re-runnable, so
applying it again after a change is safe. Sign-in is Discord OAuth, which has to
be enabled under Authentication, and `http://127.0.0.1:8721/**` has to be in the
project's Redirect URLs or sign-in will complete and land nowhere.

`config.json` is gitignored. The anon key is designed to ship inside client
apps and is useless on its own: every table refuses everything until row level
security says otherwise, which is why the policies in `schema.sql` are the
actual security boundary and not a formality.

The panel appears in the top-right of your primary display. There is no Dock
icon; the app lives in the menu bar under the frog.

If it dies immediately with `Cannot read properties of undefined (reading
'whenReady')`, you are running it from VS Code's integrated terminal, which
exports `ELECTRON_RUN_AS_NODE=1` and makes the Electron binary behave like
plain Node. Launch it with `env -u ELECTRON_RUN_AS_NODE npm start`, or use a
normal Terminal window.

## Using it

On first run the panel offers a Discord sign-in. That opens your real browser
rather than an in-app window, so you can see the address bar and your existing
Discord session and password manager work; the app never handles credentials.
The session is kept so it survives a restart.

Drag the header to move the panel, and it stays where you put it. Click an
objective to check it off. The chevrons either side of the campaign name switch
campaigns, and the choice is remembered per machine rather than shared, so two
players in one campaign do not shove each other's view around.

The **edit** chip at the top left turns on edit mode, and reads **done** while
it is on. Everything becomes editable in place. Click
any title, location or objective to type into it; it saves when you click away
or press Enter, and Escape abandons the change. Emptying a title puts the old
one back rather than erasing it, so a mis-select cannot cost you a quest name.
Locations are optional and may be left blank.

In edit mode the campaign's invite code sits under the admin row; click it to
copy. Anyone in the campaign can see it, because any member can read it from
the database anyway and hiding it in the panel would be decoration rather than
a restriction. `join a campaign` swaps that line for a field to type someone
else's code into, and the empty state offers the same thing, since a player
invited to their first campaign has nothing to edit yet.

A DM also gets a **dm only** section below the shared list, with its own
`+ new hidden quest` row. Players never receive those quests from the server at
all, so they cannot see them, count them, or discover that they exist.

Edit mode also adds `+ new campaign`, `+ new quest` and `+ add objective` rows,
a small control on each quest that cycles active, completed and failed, `↑` and
`↓` for reordering, and a `×` on every row. Deletes take two clicks: the first
arms the button and turns it red, the second removes the item, and it disarms
itself after a few seconds. New items are focused and selected the moment they
appear, so you can type straight over the placeholder.

Reordering is arrows rather than dragging because a 380px panel leaves drop
targets almost no room, and a misjudged drag would land somewhere unintended.
At the ends of a list the arrow that would do nothing is hidden but keeps its
space, so rows do not shift about as items move.

Editing is behind a chip rather than always on because display mode spends
its clicks on ticking objectives off. If titles were editable all the time,
normal use would start editing text by accident. In edit mode the tick moves
onto the diamond bullet, since the row itself is busy holding a text field.

The two controls at the right of the header are collapse and hide. Collapse
rolls the panel up to just its title bar, which is the useful state during a
session when you want the campaign name on screen but not the whole log; click
the `+` to bring it back. Hide removes it entirely, and the menu bar item or
`Cmd+Shift+Q` brings it back.

There is no OS-level minimise. The window is frameless with no Dock icon, so
there is nowhere for it to minimise to; the roll-up serves that purpose instead.

The menu bar icon has two things worth knowing about. "Click through" makes the
panel ignore the mouse entirely, so clicks pass to whatever is behind it. Turn
it on while you play and off when you want to tick something. "Open
campaigns.json…" opens the data file in your default editor, and the app
reloads it the moment you save.

That is an escape hatch rather than the normal way in, now that editing and
reordering both happen in the panel. What it is still good for is pasting in a
batch of quests, and repairing a file the app will not load.

## Where the data lives

Campaigns, quests and objectives are rows in Supabase. Nothing about them is
stored on disk. Two small files sit in Electron's userData directory: the
signed-in session, and which campaign this machine is looking at.

`src/remote.js` maps each edit onto row operations, so ticking an objective is
an UPDATE of one column rather than a rewrite of the whole campaign. That is
what stops two people editing at once from overwriting each other.

Every mutation asks for its affected rows back and treats an empty result as a
refusal. This matters more than it sounds: a policy that blocks an UPDATE
matches zero rows and raises nothing, so without that check a player editing the
DM's list would look like it had worked. Writing data a policy forbids does
raise, so the two failures look nothing alike and both have to be handled.

Roles live on the membership rather than the person, so the same account is DM
of one campaign and a player in another. Everyone in a campaign edits the shared
list freely: add, rename, tick, reorder, delete. Three things stay with the DM,
each enforced by the database rather than by what the UI offers: the campaign
itself, the hidden list, and moving quests between the two lists. `schema.sql`
explains each policy, and the reasoning behind the create-campaign RPC, which
exists because `insert ... returning` cannot work when the creator's membership
row does not exist yet at the moment the read policy is checked.

## Tuning the look

All of it lives in `src/renderer/styles.css`, and the colours are variables at
the top of the file. The parchment is built from CSS gradients plus an inline
SVG noise texture rather than an image, so there is nothing to swap out if you
want a different paper tone; change `--parchment` and `--parchment-dark`.

The menu bar icon is generated rather than hand-drawn. Shapes live as SVG in
`tools/make-tray-icon.js`, authored in a 32-unit viewBox so one source drives
every size. `npm run icons` rewrites the whole set: `trayTemplate.png` and
`trayTemplate@2x.png` for macOS, `tray-win.png` and `tray-win@2x.png` for
Windows, and a 256px preview of each for eyeballing the shape, which are
gitignored and not part of the icon set. The `@2x` files are what Retina
displays actually use.

Two variants exist because the platforms want opposite things. macOS takes a
template image, black plus alpha, and inverts it itself for dark menu bars.
Windows does no inversion, and its taskbar may be light or dark while
`nativeTheme` only reports the *app* theme, so there is no reliable way to
choose a colour at runtime. The Windows icon dodges the question with a pale
fill and a dark outline, which reads on either background. `src/main.js` picks
between them by platform.

Shapes are authored as SVG masks (white is ink, black is transparent) and the
variants do the painting, so one drawing serves both. The Windows outline comes
from an `feMorphology` dilate, which has to be applied to a group wrapping the
masked shape: on the shape itself, SVG runs filters before masks, so it would
grow a plain square and then cut the shape out of it, yielding no outline.

Two knobs control how large the mark reads. `SIZES` sets the pixel dimensions,
and 18pt is near the practical ceiling for a 22pt menu bar. Each shape's
`box` is the viewBox it crops to, so tightening it scales the drawing up
without touching the geometry.

Two shapes ship with it. `npm run icons` builds the frog in a wizard hat;
`npm run icons -- d20` switches to a d20. Add another by writing a function
returning SVG markup and registering it in `SHAPES`.

Window size and position are in `src/main.js` (`WIDTH` and `MARGIN`). Height is
automatic: the renderer measures the panel and the window resizes to match, so
the transparent region never eats clicks meant for the desktop.

Four settings in `createWindow` are load-bearing and easy to mistake for
clutter: `fullscreenable: false`, the `screen-saver` always-on-top level, and
`setVisibleOnAllWorkspaces` with `visibleOnFullScreen: true`. Together they are
what keeps the panel visible over a fullscreened Roll20 on macOS, confirmed
working. Remove any one and it drops behind.

## Releasing an update

Bump `version` in package.json, commit, then tag it:

```
git tag v1.0.1 && git push origin v1.0.1
```

GitHub Actions builds the Windows installer and publishes it to a Release.
Installed Windows copies pick it up within six hours, download it in the
background, and apply it the next time the app quits. Nothing interrupts a
session, so someone mid-game is at worst one version behind until they close it.

The build runs on a Windows runner because NSIS, the only Windows target
electron-updater can update, cannot be built on macOS without wine. `config.json`
is written in CI from the `SUPABASE_URL` and `SUPABASE_ANON_KEY` repository
secrets, since it is gitignored.

**macOS does not auto-update, on purpose.** Squirrel.Mac only accepts an update
signed by the same identity as the running app, and there is no Developer ID
certificate, so every check would fail. Rebuild the Mac copy locally with
`npm run dist:mac` instead.

One rule when changing the database: old clients keep running against the shared
server. Additive schema changes (new columns, looser policies) are safe
indefinitely. Destructive ones are not, and a tightened policy fails silently by
returning no rows rather than an error, so ship the schema change and the new
build together.

## Building for other people

`npm run dist` produces a `.dmg` for macOS (Apple Silicon and Intel) and a
`.zip` for Windows in `dist/`. `config.json` is bundled, so there is nothing for
a recipient to set up beyond signing in.

Neither build is code signed. Windows shows "Windows protected your PC" on first
run: More info, then Run anyway. A downloaded `.dmg` is quarantined and needs
right-click then Open the first time.

`build/after-pack.js` ad-hoc signs the macOS bundle, and it is not optional.
Without it the app keeps Electron's own signature, which claims
`Identifier=Electron` and does not match the bundle around it. Gatekeeper
rejects that outright and Finder silently refuses to launch it, while running
the binary directly still works, so the fault is easy to miss in testing and
certain to appear for whoever you send the build to.

## Known limits

None currently known.

## What's next

**Realtime.** Every change is currently a full reload, and other people's
changes only appear when you make one of your own. Subscribing to the campaign
would make a tick land on everyone's screen as it happens.

Nothing structural. Code signing, if the unsigned-app warnings become tiresome,
and an auto-update channel so a fix does not mean sending everyone a new file.
