/**
 * Renders the quest log, and in edit mode the controls for changing it.
 *
 * Campaigns now come from the server, which gives the panel three states it
 * never had: signed out, loading, and failed. Each is drawn here rather than
 * left as a blank panel, because a HUD that silently shows nothing is
 * indistinguishable from one that thinks you have no quests.
 *
 * Editing sits behind an explicit mode because display mode spends its clicks
 * on ticking objectives off. If titles were always editable, ordinary use would
 * start editing text by accident.
 *
 * Every mutation is a round trip now, so structural changes reload before
 * re-rendering. Text commits deliberately do not: the DOM already shows what
 * was typed, and rebuilding it would drop the caret mid-edit.
 */

const hudEl = document.getElementById('hud')
const campaignEl = document.getElementById('campaign')
const adminEl = document.getElementById('admin')
const noticeEl = document.getElementById('notice')
const questsEl = document.getElementById('quests')
const footerEl = document.getElementById('footer')
const prevEl = document.getElementById('prev')
const nextEl = document.getElementById('next')
const editEl = document.getElementById('edit')
const collapseEl = document.getElementById('collapse')
const closeEl = document.getElementById('close')

const STATUSES = ['active', 'completed', 'failed']

const state = {
  status: 'loading',
  user: null,
  campaigns: [],
  activeCampaignId: null,
  message: '',
  live: false
}

let editing = false
let busy = false
let joining = false

function activeCampaign () {
  return state.campaigns.find(c => c.id === state.activeCampaignId) || state.campaigns[0] || null
}

/** True when the signed-in user runs the campaign on screen. */
function isDm () {
  const campaign = activeCampaign()
  return !!campaign && campaign.role === 'dm'
}

function notify (message) {
  state.message = message
  noticeEl.textContent = message
  noticeEl.hidden = !message
  fit()
}

/** Adopts a state object, whether fetched or pushed. */
function applyState (next) {
  state.user = next.user
  state.campaigns = next.campaigns || []
  state.activeCampaignId = next.activeCampaignId
  state.status = next.user ? 'ready' : 'signedOut'
  state.live = next.live === true
}

/**
 * Reloads everything from the server.
 *
 * Failures land in the panel rather than the console: losing the connection
 * mid-session is expected, and the user needs to know the list is stale.
 */
async function refresh () {
  try {
    applyState(await window.questHud.loadState())
  } catch (error) {
    state.status = 'error'
    state.message = error.message
  }
}

/** Sends an edit without redrawing, for text that is already on screen. */
async function send (action) {
  try {
    await window.questHud.mutate(action)
    notify('')
  } catch (error) {
    notify(error.message)
  }
}

/**
 * Sends an edit, reloads, and redraws. `focusSelector` names a field to put the
 * caret in afterwards, so a freshly created item is ready to type into; the
 * last match wins, since new items append.
 */
async function apply (action, focusSelector) {
  if (busy) return
  busy = true

  try {
    await window.questHud.mutate(action)
    notify('')
    await refresh()
  } catch (error) {
    notify(error.message)
  } finally {
    busy = false
  }

  render()

  if (!focusSelector) return

  const matches = hudEl.querySelectorAll(focusSelector)
  if (matches.length) selectAll(matches[matches.length - 1])
}

function selectAll (el) {
  el.focus()

  const range = document.createRange()
  range.selectNodeContents(el)

  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * Text the user can type into when edit mode is on, a plain span otherwise.
 * Commits on blur or Enter, reverts on Escape. Blank input reverts too unless
 * the field is optional, so a mis-select cannot silently erase a title.
 */
function editable (text, { placeholder = '', optional = false, commit }) {
  const el = document.createElement('span')
  el.className = 'field'
  el.textContent = text

  if (!editing) return el

  el.contentEditable = 'plaintext-only'
  el.spellcheck = false
  if (placeholder) el.dataset.placeholder = placeholder

  el.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      el.blur()
    } else if (event.key === 'Escape') {
      el.textContent = text
      el.blur()
    }
  })

  el.addEventListener('blur', () => {
    const value = el.textContent.trim()
    if (value === text) return

    if (!value && !optional) {
      el.textContent = text
      return
    }

    el.textContent = value
    commit(value)
  })

  return el
}

/**
 * Two-step delete. The first click arms the button, the second removes the
 * item, so a stray click in a 380px panel cannot destroy a quest. It disarms
 * itself after a few seconds rather than sitting armed waiting to be hit.
 */
function deleteButton (label, onDelete, text = '×') {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'delete'
  el.textContent = text
  el.title = label

  let armed = null

  el.addEventListener('click', event => {
    event.stopPropagation()

    if (armed) {
      clearTimeout(armed)
      onDelete()
      return
    }

    el.classList.add('delete--armed')
    el.textContent = `${text}?`
    el.title = `${label}? Click again to confirm`

    armed = setTimeout(() => {
      armed = null
      el.classList.remove('delete--armed')
      el.textContent = text
      el.title = label
    }, 2500)
  })

  return el
}

/**
 * Up and down arrows for reordering. Arrows rather than dragging because a
 * 380px panel gives drop targets almost no room, and a misjudged drag would
 * land somewhere unintended.
 *
 * At either end of a list the relevant arrow is hidden but keeps its space, so
 * rows do not shift sideways as items move.
 */
function moveButtons (index, count, move) {
  return [
    { glyph: '↑', delta: -1, label: 'Move up', atEnd: index === 0 },
    { glyph: '↓', delta: 1, label: 'Move down', atEnd: index === count - 1 }
  ].map(({ glyph, delta, label, atEnd }) => {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = atEnd ? 'move move--end' : 'move'
    el.textContent = glyph
    el.title = label

    el.addEventListener('click', event => {
      event.stopPropagation()
      move(delta)
    })

    return el
  })
}

function addRow (label, onClick) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'add-row'
  el.textContent = label
  el.addEventListener('click', onClick)
  return el
}

function statusButton (quest) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'quest__status'
  el.textContent = quest.status
  el.title = 'Cycle status'

  el.addEventListener('click', () => {
    const next = STATUSES[(STATUSES.indexOf(quest.status) + 1) % STATUSES.length]
    apply({ type: 'quest:update', questId: quest.id, fields: { status: next } })
  })

  return el
}

function renderObjective (quest, objective, index) {
  const el = document.createElement('li')
  el.className = objective.done ? 'objective objective--done' : 'objective'

  const toggle = () => apply({ type: 'objective:toggle', objectiveId: objective.id })

  const bullet = document.createElement('span')
  bullet.className = 'objective__bullet'

  el.append(bullet, editable(objective.text, {
    commit: text => send({ type: 'objective:update', objectiveId: objective.id, text })
  }))

  if (editing) {
    // The row is busy hosting a text field, so the tick moves onto the bullet.
    bullet.classList.add('objective__bullet--button')
    bullet.title = objective.done ? 'Mark not done' : 'Mark done'
    bullet.addEventListener('click', toggle)

    el.append(
      ...moveButtons(index, quest.objectives.length, delta =>
        apply({ type: 'objective:move', objectiveId: objective.id, delta })),
      deleteButton('Delete objective', () => apply({ type: 'objective:delete', objectiveId: objective.id }))
    )
  } else {
    el.addEventListener('click', toggle)
  }

  return el
}

function renderQuest (campaign, quest, index, siblings) {
  const el = document.createElement('article')
  el.className = `quest quest--${quest.status}`
  el.dataset.id = quest.id

  const head = document.createElement('div')
  head.className = 'quest__head'

  const title = document.createElement('h2')
  title.className = 'quest__title'
  title.append(editable(quest.title, {
    commit: value => send({ type: 'quest:update', questId: quest.id, fields: { title: value } })
  }))
  head.append(title)

  if (editing) {
    head.append(
      statusButton(quest),
      ...moveButtons(index, siblings.length, delta =>
        apply({ type: 'quest:move', campaignId: campaign.id, questId: quest.id, delta })),
      deleteButton('Delete quest', () => apply({ type: 'quest:delete', questId: quest.id }))
    )
  }
  el.append(head)

  if (quest.location || editing) {
    const location = document.createElement('p')
    location.className = 'quest__location'
    location.append(editable(quest.location || '', {
      placeholder: 'add location',
      optional: true,
      commit: value => send({ type: 'quest:update', questId: quest.id, fields: { location: value } })
    }))
    el.append(location)
  }

  const list = document.createElement('ul')
  list.className = 'quest__objectives'
  list.append(...quest.objectives.map((o, i) => renderObjective(quest, o, i)))
  el.append(list)

  if (editing) {
    el.append(addRow('+ add objective', () => apply(
      { type: 'objective:create', questId: quest.id },
      `.quest[data-id="${quest.id}"] .objective .field`
    )))
  }

  return el
}

function sectionHeading (text) {
  const el = document.createElement('p')
  el.className = 'section'
  el.textContent = text
  return el
}

/**
 * The campaign's invite code, with a click to copy it.
 *
 * Shown to every member, not just the DM. Any member can read the code from the
 * database anyway, so hiding it in the panel would be decoration rather than a
 * restriction, and pretending otherwise is worse than being plain about it.
 */
function inviteCode (campaign) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'invite'
  el.title = 'Copy this code for someone to join with'

  const label = document.createElement('span')
  label.className = 'invite__label'
  label.textContent = 'invite'

  const code = document.createElement('span')
  code.className = 'invite__code'
  code.textContent = campaign.inviteCode

  el.append(label, code)

  el.addEventListener('click', () => {
    window.questHud.copy(campaign.inviteCode)

    label.textContent = 'copied'
    setTimeout(() => { label.textContent = 'invite' }, 1600)
  })

  return el
}

/** The field for joining someone else's campaign by code. */
function joinForm () {
  const form = document.createElement('div')
  form.className = 'join'

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'join__input'
  input.placeholder = 'invite code'
  input.maxLength = 12
  input.spellcheck = false

  const submit = async () => {
    const code = input.value.trim()
    if (!code) return

    input.disabled = true
    notify('')

    try {
      const campaignId = await window.questHud.joinCampaign(code)
      joining = false
      await refresh()
      state.activeCampaignId = campaignId
      render()
    } catch (error) {
      notify(error.message)
      input.disabled = false
      input.focus()
      input.select()
    }
  }

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') submit()
    if (event.key === 'Escape') {
      joining = false
      notify('')
      render()
    }
  })

  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'join__go'
  go.textContent = 'join'
  go.addEventListener('click', submit)

  form.append(input, go)
  return form
}

function renderAdmin (campaign) {
  if (!editing || !campaign) {
    adminEl.replaceChildren()
    return
  }

  const actions = document.createElement('div')
  actions.className = 'admin__row'

  actions.append(
    addRow('+ new campaign', () => apply({ type: 'campaign:create' }, '.hud__campaign .field')),
    addRow('join a campaign', () => {
      joining = true
      render()
      const input = adminEl.querySelector('.join__input')
      if (input) input.focus()
    })
  )

  // Only a DM may delete a campaign, and never the last one on screen.
  if (campaign.role === 'dm' && state.campaigns.length > 1) {
    actions.append(deleteButton(
      'Delete campaign',
      () => apply({ type: 'campaign:delete', campaignId: campaign.id }),
      'delete campaign'
    ))
  }

  const rows = [actions]
  rows.push(joining ? joinForm() : inviteCode(campaign))

  adminEl.replaceChildren(...rows)
}

/** The sign-in screen. Nothing else in the panel works without this. */
function renderSignedOut () {
  campaignEl.textContent = 'Ribbertold'

  const wrap = document.createElement('div')
  wrap.className = 'state'

  const text = document.createElement('p')
  text.className = 'state__text'
  text.textContent = 'Sign in to load your campaigns.'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'state__button'
  button.textContent = 'Sign in with Discord'
  button.addEventListener('click', async () => {
    button.disabled = true
    button.textContent = 'Waiting for Discord…'

    try {
      await window.questHud.signIn()
      await refresh()
    } catch (error) {
      notify(error.message)
    }

    render()
  })

  wrap.append(text, button)
  questsEl.replaceChildren(wrap)
  footerEl.textContent = 'not signed in'
}

function renderMessage (heading, detail, action) {
  const wrap = document.createElement('div')
  wrap.className = 'state'

  const text = document.createElement('p')
  text.className = 'state__text'
  text.textContent = heading

  wrap.append(text)

  if (detail) {
    const small = document.createElement('p')
    small.className = 'state__detail'
    small.textContent = detail
    wrap.append(small)
  }

  if (action) wrap.append(action)
  questsEl.replaceChildren(wrap)
}

/** Signed in, but with nothing on the server yet. */
function renderEmpty () {
  campaignEl.textContent = 'No campaigns'

  const buttons = document.createElement('div')
  buttons.className = 'state__actions'

  const create = document.createElement('button')
  create.type = 'button'
  create.className = 'state__button'
  create.textContent = 'Create a campaign'
  create.addEventListener('click', () => apply({ type: 'campaign:create' }))
  buttons.append(create)

  // Without this a player invited to someone else's campaign has nowhere to
  // type the code: the join control lives in edit mode, and edit mode needs a
  // campaign to edit.
  const join = document.createElement('button')
  join.type = 'button'
  join.className = 'state__button'
  join.textContent = 'Join with an invite code'
  join.addEventListener('click', () => {
    const form = joinForm()
    buttons.replaceChildren(form)
    form.querySelector('.join__input').focus()
  })
  buttons.append(join)

  renderMessage('Nothing here yet.', null, buttons)
  footerEl.textContent = state.user ? `signed in as ${state.user.name}` : ''
}

function renderLog () {
  const campaign = activeCampaign()
  const multiple = state.campaigns.length > 1

  prevEl.hidden = !multiple
  nextEl.hidden = !multiple
  editEl.hidden = false

  campaignEl.replaceChildren(editable(campaign.name, {
    // Renaming belongs to the DM, so a player gets plain text.
    commit: name => send({ type: 'campaign:rename', campaignId: campaign.id, name })
  }))

  renderAdmin(campaign)

  const shared = campaign.quests.filter(q => !q.dmOnly)
  const hidden = campaign.quests.filter(q => q.dmOnly)

  const children = shared.map((q, i) => renderQuest(campaign, q, i, shared))

  if (editing) {
    children.push(addRow('+ new quest', () => apply(
      { type: 'quest:create', campaignId: campaign.id },
      '.quest__title .field'
    )))
  }

  // The DM's own list, which players never receive from the server at all.
  if (isDm() && (hidden.length || editing)) {
    children.push(sectionHeading('dm only'))
    children.push(...hidden.map((q, i) => renderQuest(campaign, q, i, hidden)))

    if (editing) {
      children.push(addRow('+ new hidden quest', () => apply(
        { type: 'quest:create', campaignId: campaign.id, dmOnly: true },
        '.quest__title .field'
      )))
    }
  }

  questsEl.replaceChildren(...children)

  const open = shared.filter(q => q.status !== 'completed').length
  footerEl.textContent = `${open} active ${open === 1 ? 'quest' : 'quests'}${state.live ? '' : ' · not live'}`
}

function render () {
  hudEl.classList.toggle('hud--editing', editing)

  // Only the log has campaigns to page through or edit.
  const isLog = state.status === 'ready' && state.campaigns.length > 0
  prevEl.hidden = !isLog
  nextEl.hidden = !isLog
  editEl.hidden = !isLog

  if (state.status === 'loading') {
    campaignEl.textContent = 'Ribbertold'
    renderMessage('Loading…')
    footerEl.textContent = ''
  } else if (state.status === 'signedOut') {
    renderSignedOut()
  } else if (state.status === 'error') {
    campaignEl.textContent = 'Ribbertold'
    renderMessage('Could not reach the server.', state.message)
    footerEl.textContent = 'offline'
  } else if (state.campaigns.length === 0) {
    renderEmpty()
  } else {
    renderLog()
  }

  fit()
}

function cycleCampaign (step) {
  const index = state.campaigns.findIndex(c => c.id === activeCampaign().id)
  const next = state.campaigns[(index + step + state.campaigns.length) % state.campaigns.length]

  state.activeCampaignId = next.id
  render()
  window.questHud.setActiveCampaign(next.id)
}

function fit () {
  window.questHud.fitWindow(hudEl.getBoundingClientRect().height)
}

function toggleEditing () {
  editing = !editing
  joining = false
  notify('')

  editEl.classList.toggle('hud__edit--on', editing)
  editEl.textContent = editing ? 'done' : 'edit'
  editEl.setAttribute('aria-pressed', String(editing))
  editEl.setAttribute('aria-label', editing ? 'Finish editing' : 'Edit quests')
  render()
}

function toggleCollapse () {
  const collapsed = hudEl.classList.toggle('hud--collapsed')

  collapseEl.textContent = collapsed ? '+' : '−'
  collapseEl.setAttribute('aria-label', collapsed ? 'Expand quest log' : 'Collapse quest log')
  fit()
}

prevEl.addEventListener('click', () => cycleCampaign(-1))
nextEl.addEventListener('click', () => cycleCampaign(1))
editEl.addEventListener('click', toggleEditing)
collapseEl.addEventListener('click', toggleCollapse)
closeEl.addEventListener('click', () => window.questHud.hide())

/**
 * Someone else changed something.
 *
 * Redrawing while a field has focus would drop the caret and throw away
 * half-typed text, so the update waits for that field to finish. It reloads
 * afterwards rather than applying the state it was handed, because by then the
 * user's own commit has probably landed and the pushed copy is already stale.
 */
window.questHud.onStateChanged(next => {
  const active = document.activeElement

  if (active && active.classList.contains('field')) {
    active.addEventListener('blur', () => {
      setTimeout(async () => {
        await refresh()
        render()
      }, 400)
    }, { once: true })
    return
  }

  applyState(next)
  render()
})

/**
 * A quest log that has quietly stopped receiving updates is worse than one that
 * admits it, so the footer says when the connection is not live.
 */
window.questHud.onRealtimeStatus(status => {
  const live = status === 'SUBSCRIBED'
  if (live === state.live) return

  state.live = live
  render()
})

async function init () {
  render()
  await refresh()
  render()
}

init()
