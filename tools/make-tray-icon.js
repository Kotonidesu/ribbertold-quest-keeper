/**
 * Generates the menu bar icon. Run `npm run icons` to rebuild the current
 * shape, or `npm run icons -- d20` to switch to the other one.
 *
 * macOS template images must be black plus alpha so the OS can invert them for
 * dark menu bars, which is why nothing here carries colour. Shapes are authored
 * in a fixed 32-unit viewBox and the SVG scales them, so the same source drives
 * every output size.
 */

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ASSETS = path.join(__dirname, '..', 'assets')

app.commandLine.appendSwitch('force-device-scale-factor', '1')

/**
 * A d20 seen face-on: pointy-top hexagon silhouette, the upper face as a
 * centred triangle, and struts splaying from each corner of that face to the
 * two hexagon corners flanking it. Running the struts straight out to the
 * corner directly above instead gives three lines at 120 degrees, which the eye
 * reads as an isometric cube.
 *
 * @returns {string} SVG markup in a 32-unit space.
 */
function d20 () {
  const c = 16
  const outer = 13.4
  const inner = 5.9

  const at = (radius, deg) => {
    const rad = (deg * Math.PI) / 180
    return [c + radius * Math.cos(rad), c - radius * Math.sin(rad)]
  }

  const points = (radius, angles) => angles.map(a => at(radius, a).map(n => n.toFixed(2)).join(',')).join(' ')

  const struts = [90, 210, 330].flatMap(deg => [deg - 60, deg + 60].map(target => {
    const [x1, y1] = at(inner, deg)
    const [x2, y2] = at(outer, target)
    return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`
  })).join('')

  return `<rect width="32" height="32" fill="#000"/>
  <g fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
    <polygon points="${points(outer, [90, 150, 210, 270, 330, 30])}"/>
    <polygon points="${points(inner, [90, 210, 330])}"/>
    ${struts}
  </g>`
}

/**
 * A frog in a wizard hat, as a solid silhouette with the eyes and mouth punched
 * out. Outlines would collapse into a smudge at menu bar size, so the shape
 * carries the read and the holes supply the face.
 *
 * The hat is a brimless cone on purpose. A brim is the widest thing in the mark
 * and it pushes the eyes down into the head, costing the frog its most
 * recognisable feature. Without one the eyes sit on top where they belong,
 * breaking the head's silhouette, and the cone rises between them.
 *
 * The cone is wide enough to pass behind both eyes, and depth comes from mask
 * ordering rather than a drawn line. The hat goes down first, a ring is knocked
 * out along the frog's silhouette, then the frog is filled back in over it.
 * Only the outer half of that ring survives, so a transparent gap appears
 * exactly where the hat runs behind the head and eyes and nowhere else.
 *
 * That gap is why no mark spans the cone's base. Anything horizontal at that
 * height sits between the eyes and gets read as a facial feature: curved it
 * becomes a second smile, straight it becomes a unibrow.
 *
 * @returns {string} SVG markup in a 32-unit space.
 */
function frog () {
  const body = `<ellipse cx="16" cy="21.5" rx="10" ry="7.2"/>
    <circle cx="7.6" cy="15.2" r="4.6"/>
    <circle cx="24.4" cy="15.2" r="4.6"/>`

  return `<rect width="32" height="32" fill="#000"/>
  <path d="M 8.6 15.4 Q 12 8 16.8 1.4 Q 20.6 8.6 23.4 15.4 Z" fill="#fff"/>
  <g fill="none" stroke="#000" stroke-width="1.9">${body}</g>
  <g fill="#fff">${body}</g>
  <g fill="#000">
    <circle cx="7.6" cy="15.2" r="1.9"/>
    <circle cx="24.4" cy="15.2" r="1.9"/>
  </g>
  <path d="M 10.5 23.5 Q 16 27.5 21.5 23.5" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round"/>`
}

/**
 * Each shape pairs its draw function with the viewBox to crop to. Draw
 * functions return mask contents: white is ink, black is transparent. Painting
 * the result is the variants' job, so one shape serves both platforms.
 *
 * The frog is drawn with slack around it, so cropping to its actual bounds
 * scales the mark up without redrawing anything. The d20 already reaches its
 * edges.
 */
const SHAPES = {
  d20: { draw: d20, box: '0 0 32 32' },
  frog: { draw: frog, box: '1.55 0.6 28.9 28.9' }
}

const OUTLINE = 1.1

/**
 * How the masked shape gets painted.
 *
 * macOS wants a template image: black plus alpha, which the OS inverts itself
 * for dark menu bars. Windows does no such inversion, and its taskbar can be
 * light or dark while nativeTheme only reports the *app* theme, so there is no
 * reliable way to pick a colour at runtime. A pale fill with a dark outline
 * sidesteps the question by reading on either background.
 */
const VARIANTS = {
  template: {
    base: 'trayTemplate',
    preview: 'tray-preview',
    pad: 0,
    paint: () => '<rect width="32" height="32" fill="#000" mask="url(#cut)"/>'
  },
  // The application icon: the same frog on a parchment tile, rather than a bare
  // silhouette. Sized and shaped for a Dock and a taskbar, not a menu bar.
  app: {
    base: 'app-icon',
    preview: 'app-icon-preview',
    pad: 5,
    sizes: [{ size: 1024, suffix: '' }],
    paint: box => {
      const [x, y, w, h] = box.split(/\s+/).map(Number)
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w * 0.22}" fill="#e6d8b8"/>
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w * 0.22}" fill="none" stroke="#9c7c34" stroke-width="0.6"/>
        <rect width="32" height="32" fill="#2f2617" mask="url(#cut)"/>`
    }
  },

  contrast: {
    // Deliberately not named "…Template": macOS treats that suffix as an
    // instruction to invert the image, which is exactly wrong for this one.
    base: 'tray-win',
    preview: 'tray-preview-win',
    pad: OUTLINE,
    // The dilate has to wrap the masked rect in a group. On the rect itself the
    // filter runs before the mask, so it would grow a plain square and then cut
    // the shape out of it, producing no outline at all.
    paint: () => `<filter id="grow"><feMorphology operator="dilate" radius="${OUTLINE}"/></filter>
      <g filter="url(#grow)">
        <rect width="32" height="32" fill="#161310" mask="url(#cut)"/>
      </g>
      <rect width="32" height="32" fill="#f2ece0" mask="url(#cut)"/>`
  }
}

// 18pt rather than 16pt. The macOS menu bar is 22pt tall, so this is close to
// the practical ceiling before the glyph starts crowding the bar. The 256px
// preview is for eyeballing the shape and is not shipped.
const outputs = variant => (variant.sizes
  ? variant.sizes.map(({ size, suffix }) => ({ size, file: `${variant.base}${suffix}.png` }))
  : [
      { size: 18, file: `${variant.base}.png` },
      { size: 36, file: `${variant.base}@2x.png` },
      { size: 256, file: `${variant.preview}.png` }
    ])

const shape = process.argv[2] || 'frog'

/** Grows a viewBox on every side, so a dilated outline is not clipped. */
function expand (box, amount) {
  const [x, y, w, h] = box.split(/\s+/).map(Number)
  return [x - amount, y - amount, w + amount * 2, h + amount * 2].join(' ')
}

// One offscreen window reused across sizes. A second offscreen window fails to
// load anything at all, so it is created once and resized per icon.
let win = null

async function render (size, file, variantName) {
  if (win) {
    win.setSize(size, size)
  } else {
    win = new BrowserWindow({
      width: size,
      height: size,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { offscreen: true }
    })
  }

  const { draw, box } = SHAPES[shape]
  const variant = VARIANTS[variantName]

  const cropped = expand(box, variant.pad)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${cropped}">
    <mask id="cut">${draw()}</mask>
    ${variant.paint(cropped)}
  </svg>`

  // A temp file rather than a data: URL, which Chromium rejects intermittently
  // when several are loaded in a row.
  const page = path.join(app.getPath('temp'), `ribbertold-icon-${size}-${variantName}.html`)
  fs.writeFileSync(page, `<body style="margin:0;background:transparent">${svg}</body>`)

  await win.loadFile(page)
  await new Promise(r => setTimeout(r, 250))

  // capturePage honours the display's scale factor, not the switch above, so on
  // a Retina screen it hands back double. That extra detail is worth keeping as
  // supersampling, so render large and resize down to the size actually wanted.
  const captured = await win.webContents.capturePage()
  const image = captured.resize({ width: size, height: size, quality: 'best' })
  const out = path.join(ASSETS, file)

  fs.writeFileSync(out, image.toPNG())
  fs.unlinkSync(page)

  return { file, size: image.getSize(), bytes: fs.statSync(out).size }
}

app.whenReady().then(async () => {
  if (!SHAPES[shape]) {
    console.error(`Unknown shape "${shape}". Available: ${Object.keys(SHAPES).join(', ')}`)
    app.exit(1)
    return
  }

  const written = []

  try {
    for (const [name, variant] of Object.entries(VARIANTS)) {
      for (const { size, file } of outputs(variant)) {
        written.push(await render(size, file, name))
      }
    }
  } catch (error) {
    console.error('Icon generation failed:', error.message)
    app.exit(1)
    return
  }

  console.log(JSON.stringify({ shape, written }, null, 2))
  app.quit()
})
