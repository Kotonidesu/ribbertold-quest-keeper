/**
 * The campaign data, backed by Supabase.
 *
 * Replaces the file-backed store. The shape handed to the renderer is
 * deliberately unchanged, so the panel keeps working as it did; the difference
 * is that reads are now three queries against three tables and every edit is a
 * row operation rather than a document rewrite.
 *
 * Two things drive most of the design here:
 *
 * Row operations, not document writes. A tick is an UPDATE of one column, so
 * two people editing the same campaign no longer overwrite each other.
 *
 * Refusals are checked, not assumed. A policy that blocks an UPDATE matches
 * zero rows and raises nothing, so every mutation asks for its rows back and
 * treats an empty result as a refusal. Without that, a player editing the DM's
 * list would look like it worked.
 */

const { supabase } = require('./supabase')

/** Fields the renderer needs, named as the renderer expects them. */
function shapeQuest (quest, objectives) {
  return {
    id: quest.id,
    title: quest.title,
    location: quest.location,
    status: quest.status,
    dmOnly: quest.dm_only,
    objectives: objectives
      .filter(o => o.quest_id === quest.id)
      .map(o => ({ id: o.id, text: o.body, done: o.done }))
  }
}

/**
 * Runs a query and insists it actually did something.
 *
 * @param {object} query A supabase-js builder, with .select() already chained
 *   on writes so there are rows to count.
 * @param {boolean} expectRows False for reads that may legitimately be empty.
 */
async function run (query, expectRows = true) {
  const { data, error } = await query

  if (error) throw new Error(error.message)

  // An empty result from a write means a policy filtered the row out. The
  // database does not consider that an error, but the user should.
  if (expectRows && (!data || data.length === 0)) {
    throw new Error('That change was refused. You may not have permission.')
  }

  return data
}

/**
 * Everything the signed-in user can see, assembled into the panel's shape.
 *
 * Row level security does the filtering, so this asks for all rows and gets
 * back only the permitted ones. Quests in the DM's hidden list simply do not
 * arrive for a player.
 */
async function load (userId) {
  const [campaigns, quests, objectives, memberships] = await Promise.all([
    run(supabase.from('campaigns').select('id, name, invite_code').order('name'), false),
    run(supabase.from('quests').select('*').order('position'), false),
    run(supabase.from('objectives').select('*').order('position'), false),
    run(supabase.from('campaign_members').select('campaign_id, role').eq('user_id', userId), false)
  ])

  const roleOf = Object.fromEntries(memberships.map(m => [m.campaign_id, m.role]))

  return campaigns.map(campaign => ({
    id: campaign.id,
    name: campaign.name,
    inviteCode: campaign.invite_code,
    role: roleOf[campaign.id] || 'player',
    quests: quests
      .filter(q => q.campaign_id === campaign.id)
      .map(q => shapeQuest(q, objectives))
  }))
}

/** Appends after the current last item in a list. */
async function nextPosition (table, column, parentId) {
  const rows = await run(
    supabase.from(table).select('position').eq(column, parentId).order('position', { ascending: false }).limit(1),
    false
  )

  return rows.length ? rows[0].position + 1 : 1
}

/**
 * Swaps an item with its neighbour.
 *
 * Swapping the two position values rather than recomputing a midpoint keeps the
 * float space from narrowing over repeated moves, and only ever touches the two
 * rows that actually changed places.
 */
async function move (table, column, parentId, id, delta) {
  const siblings = await run(
    supabase.from(table).select('id, position').eq(column, parentId).order('position'),
    false
  )

  const from = siblings.findIndex(s => s.id === id)
  const to = from + delta

  if (from < 0 || to < 0 || to >= siblings.length) return

  await run(supabase.from(table).update({ position: siblings[to].position }).eq('id', siblings[from].id).select())
  await run(supabase.from(table).update({ position: siblings[from].position }).eq('id', siblings[to].id).select())
}

/** The quest an objective sits in. Objectives are ordered within their quest. */
async function objectiveQuest (objectiveId) {
  const rows = await run(supabase.from('objectives').select('quest_id').eq('id', objectiveId), false)
  if (!rows.length) throw new Error('That objective no longer exists')
  return rows[0].quest_id
}

/**
 * Applies one edit.
 *
 * @param {object} action `{ type, campaignId?, questId?, objectiveId?, ... }`,
 *   the same vocabulary the file-backed version used.
 * @param {string} userId The signed-in user, needed when creating a campaign.
 */
async function mutate (action, userId) {
  switch (action.type) {
    case 'campaign:create': {
      // Via an RPC, not an insert: reading back a freshly inserted campaign is
      // refused, because the creator's membership row does not exist yet at the
      // moment RETURNING checks the read policy. See supabase/schema.sql.
      const { data, error } = await supabase.rpc('create_campaign')
      if (error) throw new Error(error.message)
      return data.id
    }

    case 'campaign:rename':
      await run(supabase.from('campaigns').update({ name: action.name }).eq('id', action.campaignId).select())
      return

    case 'campaign:delete':
      await run(supabase.from('campaigns').delete().eq('id', action.campaignId).select())
      return

    case 'quest:create': {
      const position = await nextPosition('quests', 'campaign_id', action.campaignId)
      const rows = await run(supabase.from('quests')
        .insert({ campaign_id: action.campaignId, position, dm_only: action.dmOnly === true })
        .select())
      return rows[0].id
    }

    case 'quest:update': {
      const fields = {}
      if ('title' in action.fields) fields.title = action.fields.title
      if ('location' in action.fields) fields.location = action.fields.location
      if ('status' in action.fields) fields.status = action.fields.status
      if ('dmOnly' in action.fields) fields.dm_only = action.fields.dmOnly

      await run(supabase.from('quests').update(fields).eq('id', action.questId).select())
      return
    }

    case 'quest:delete':
      await run(supabase.from('quests').delete().eq('id', action.questId).select())
      return

    case 'quest:move':
      await move('quests', 'campaign_id', action.campaignId, action.questId, action.delta)
      return

    case 'objective:create': {
      const position = await nextPosition('objectives', 'quest_id', action.questId)
      const rows = await run(supabase.from('objectives')
        .insert({ quest_id: action.questId, position })
        .select())
      return rows[0].id
    }

    case 'objective:update':
      await run(supabase.from('objectives').update({ body: action.text }).eq('id', action.objectiveId).select())
      return

    case 'objective:toggle': {
      // Read first: there is no server-side "flip this boolean".
      const rows = await run(supabase.from('objectives').select('done').eq('id', action.objectiveId), false)
      if (!rows.length) throw new Error('That objective no longer exists')

      await run(supabase.from('objectives').update({ done: !rows[0].done }).eq('id', action.objectiveId).select())
      return
    }

    case 'objective:delete':
      await run(supabase.from('objectives').delete().eq('id', action.objectiveId).select())
      return

    case 'objective:move':
      await move('objectives', 'quest_id', await objectiveQuest(action.objectiveId), action.objectiveId, action.delta)
      return

    default:
      throw new Error(`Unknown action: ${action.type}`)
  }
}

/**
 * Watches for changes anyone makes, including this client's own.
 *
 * Row level security applies to the stream as well as to reads, so a player
 * never receives events for the DM's hidden quests, not even a bare id.
 *
 * The callback carries no payload on purpose. Postgres sends the changed row,
 * but acting on it would mean maintaining a second, subtly different way to
 * update state alongside the loader. Reloading is a handful of queries and is
 * always right.
 *
 * @param {Function} onChange Called on any change to the subscribed tables.
 * @param {Function} onStatus Called with the channel's connection status.
 * @returns {object} The channel, for unsubscribing.
 */
function subscribe (onChange, onStatus) {
  const channel = supabase.channel('ribbertold')

  for (const table of ['campaigns', 'campaign_members', 'quests', 'objectives']) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, onChange)
  }

  channel.subscribe(status => onStatus(status))

  return channel
}

/** Joins by invite code and returns the campaign id. */
async function joinCampaign (code) {
  const { data, error } = await supabase.rpc('join_campaign', { code })
  if (error) throw new Error(error.message)
  return data
}

module.exports = { load, mutate, subscribe, joinCampaign }
