/**
 * Board insights — the dashboard the Kanban board never had.
 *
 * Two views, one page, everything read-only:
 *   List       what is in flight, what is waiting on a person, and every unfinished card
 *              across every board in one filterable list (a live snapshot: no date range)
 *   Dashboard  every graph in one place, driven by the one date range control at the top:
 *              summary counters, completed over time, workload by status, net flow, tasks
 *              by department, created-vs-completed, by assignee, department standups last
 *
 * A "Space" is a named set of boards held in this plugin's own storage, so the same page
 * can read one project or every board without a second board. It ships as a single Space
 * ("All boards"); create your own from the picker, nothing is assumed about your boards.
 *
 * Everything is READ-ONLY. Data comes from this plugin's own backend at
 * /api/plugins/board-insights/*, which opens every kanban.db with SQLite `mode=ro`.
 * Nothing here writes to a board, and nothing here is a core patch: it loads from
 * <hermes home>/plugins/board-insights/desktop/, hot-reloads on save, and survives
 * `hermes update`.
 *
 * The page deliberately fetches once and filters in the browser, so switching Space or
 * searching never waits on a round trip: the whole install is a few hundred cards.
 */

import {
  Badge,
  Button,
  cn,
  Codicon,
  EmptyState,
  ErrorState,
  GlyphSpinner,
  ROUTES_AREA,
  ScrollArea,
  SearchField,
  SIDEBAR_NAV_AREA,
  Tip,
  host,
  profileColor,
  profileColorSoft,
  usePluginI18n,
  useQuery
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'board-insights'

// >>> person-avatar >>>
// A 24px chip per person: the profile's stored avatar when there is one, else its initial in
// the app's own deterministic identity colour. A runtime plugin is evaluated from a blob URL
// and may import only @hermes/plugin-sdk and react, so this block is inlined rather than
// shared as a module.
//
// The picture is the profile's own stored avatar asset, read through the gateway's
// `profiles.get_asset` - the same RPC core's user message uses - so a real uploaded photo
// appears here with no code change. With no asset (or no gateway) the chip is the profile's
// initial in the app's own deterministic identity colour (`profileColor`), the hue the rest
// of the app paints that name with. Nothing is invented: no stock face, no borrowed photo.
const AVATAR_PX = 24
const AVATAR_TTL_MS = 10 * 60 * 1000

// Bucketed by the LIVE gateway instance: a profile swap or a reconnect hands us a new one,
// and then the picture is re-read (the other machine's avatar may be the new one). The
// no-gateway bucket is separate, so "there is no gateway yet" is never remembered as
// "this person has no picture".
const avatarBuckets = new WeakMap() // gateway -> { cache, inflight }
const avatarNoGateway = { cache: new Map(), inflight: new Map() } // id -> { at, url } / Promise

function avatarBucket() {
  const gateway = typeof host.getGateway === 'function' ? host.getGateway() : null
  if (!gateway || typeof gateway !== 'object') return avatarNoGateway
  let bucket = avatarBuckets.get(gateway)
  if (!bucket) {
    bucket = { cache: new Map(), inflight: new Map() }
    avatarBuckets.set(gateway, bucket)
  }
  return bucket
}

const avatarBox = { width: AVATAR_PX, height: AVATAR_PX }

/** The app's hue for a name. `default` and the empty string have none there, and every
 *  such identity would collide on one neutral, so they get a hue hashed here instead —
 *  still deterministic, still the same on every surface, still never a real person's. */
function avatarColor(id) {
  const own = profileColor(id)
  if (own) return own
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  return 'hsl(' + (hash % 360) + ' 68% 58%)'
}

/** Data URL of the profile's stored avatar, or null. One gateway read per person per 10 min. */
function avatarImage(id) {
  const bucket = avatarBucket()
  const hit = bucket.cache.get(id)
  if (hit && Date.now() - hit.at < AVATAR_TTL_MS) return Promise.resolve(hit.url)
  const inflight = bucket.inflight.get(id)
  if (inflight) return inflight
  const run = Promise.resolve()
    .then(() => host.request('profiles.get_asset', { name: id, asset: 'avatar' }))
    .then(result => (result && result.found && result.data) || null)
    .catch(() => null) // no gateway, or a name that is not a profile: the chip is correct
    .then(url => {
      bucket.cache.set(id, { at: Date.now(), url })
      bucket.inflight.delete(id)
      return url
    })
  bucket.inflight.set(id, run)
  return run
}

/**
 * 24px person avatar: the stored picture when the profile has one, else its initial in its
 * own colour, else — for an empty assignee — one neutral dashed placeholder no real person
 * ever wears. A fixed 24px box in every state, so a missing picture never moves a row. The
 * name always sits beside it on every surface, so the chip is aria-hidden (no doubled
 * reading for a screen reader) and `title` gives the mouse the profile name.
 */
function PersonAvatar(props) {
  const raw = String(props.id || '').trim()
  // The board says "unassigned" in some places and nothing in others; both mean the same
  // one placeholder, so neither can borrow a real person's colour.
  const id = raw.toLowerCase() === 'unassigned' ? '' : raw
  const [url, setUrl] = useState(null)

  useEffect(() => {
    let live = true
    if (!id) return undefined
    avatarImage(id).then(found => {
      if (live) setUrl(found)
    })
    return () => {
      live = false
    }
  }, [id])

  const style = Object.assign({}, avatarBox, props.style)
  const extra = props.className || ''

  if (!id) {
    return jsx('span', {
      'aria-hidden': 'true',
      className:
        'inline-flex items-center justify-center rounded-full border border-dashed border-(--ui-stroke-secondary) text-[0.625rem] text-(--ui-text-quaternary) ' +
        extra,
      style,
      title: 'Unassigned',
      children: '\u2014'
    })
  }

  if (url) {
    return jsx('img', {
      'aria-hidden': 'true',
      alt: '',
      className: 'rounded-full object-cover ' + extra,
      src: url,
      style,
      title: id
    })
  }

  const color = avatarColor(id)
  return jsx('span', {
    'aria-hidden': 'true',
    className: 'inline-flex items-center justify-center rounded-full text-[0.625rem] font-medium ' + extra,
    style: Object.assign({}, style, { backgroundColor: profileColorSoft(color, 18), color }),
    title: id,
    children: id.charAt(0).toUpperCase()
  })
}
// <<< person-avatar <<<

// ctx only reaches register(); the components below need ctx.rest / ctx.storage.
let ctxRef = null

// The same tones the board paints its columns with, kept literal for parity with the
// cards' own dots (see plugins/kanban/types.ts COLUMN_META). Everything else is themed.
const STATUS_TONE = {
  triage: 'var(--ui-text-tertiary)',
  todo: 'var(--ui-text-secondary)',
  scheduled: '#a78bfa',
  ready: '#60a5fa',
  running: '#34d399',
  blocked: '#f87171',
  review: '#fbbf24',
  done: 'var(--ui-text-tertiary)'
}

const STATUS_ORDER = ['running', 'blocked', 'review', 'ready', 'todo', 'scheduled', 'triage', 'done']
const toneOf = status => STATUS_TONE[status] || 'var(--ui-text-quaternary)'

// Spaces: named board sets, persisted in this plugin's storage. The only default is the
// view that cannot be wrong on someone else's install - every board they have. A Space is
// created from the picker ("Edit spaces"); nothing here guesses at board names.
const DEFAULT_SPACES = {
  'All boards': null
}

const PRIORITY_TIP =
  'Dispatch order is `priority DESC, created_at ASC` (kanban_db): a HIGHER number is claimed first, 0 is the default, negatives are deprioritised. Dates break ties.'

const RUN_TIP =
  'One Run row per dispatcher claim on a card. status is the lifecycle (running / done / blocked / ready / review / crashed / timed_out / failed / released), outcome the verdict (completed / review_requested / changes_requested / blocked / reclaimed / gave_up). Still "running" with no heartbeat in 10 minutes = stale: the worker died without closing its row.'

// --------------------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------------------

function fmtHours(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const hours = Number(value)
  if (hours < 1) return Math.max(1, Math.round(hours * 60)) + 'm'
  if (hours < 48) return hours.toFixed(1) + 'h'
  return (hours / 24).toFixed(1) + 'd'
}

function fmtDelta(now, prev) {
  if (!prev) return now ? 'no earlier window to compare' : 'no change'
  if (prev === 0) return '+' + now + ' vs 0'
  const change = Math.round(((now - prev) / prev) * 100)
  return (change >= 0 ? '+' : '') + change + '%'
}

function readSpaces() {
  try {
    const stored = ctxRef && ctxRef.storage ? ctxRef.storage.get('spaces') : null
    if (stored && typeof stored.then !== 'function' && typeof stored === 'object' && Object.keys(stored).length) {
      return stored
    }
  } catch {
    /* a storage failure must never take the page down */
  }
  return DEFAULT_SPACES
}

function writeSpaces(spaces) {
  try {
    if (ctxRef && ctxRef.storage) ctxRef.storage.set('spaces', spaces)
  } catch {
    /* read-only session: keep it in memory only */
  }
}

// The date window: one of Today / 7 days / 30 days / Custom, persisted like Spaces so it
// survives refresh and navigation. Only an explicit Reset clears it.
const DEFAULT_RANGE = { preset: '7d' }

function readRange() {
  try {
    const stored = ctxRef && ctxRef.storage ? ctxRef.storage.get('range') : null
    if (stored && typeof stored.then !== 'function' && typeof stored === 'object' && stored.preset) {
      return stored
    }
  } catch {
    /* a storage failure must never take the page down */
  }
  return DEFAULT_RANGE
}

function writeRange(range) {
  try {
    if (ctxRef && ctxRef.storage) ctxRef.storage.set('range', range)
  } catch {
    /* read-only session: keep it in memory only */
  }
}

function dateString(offsetDays) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - offsetDays)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}

// Inclusive calendar-day span between two YYYY-MM-DD strings, on UTC midnights so a
// daylight-saving change cannot skew the count.
function daySpan(from, to) {
  const parse = value => {
    const parts = String(value).split('-').map(Number)
    if (parts.length !== 3 || parts.some(Number.isNaN)) return null
    return Date.UTC(parts[0], parts[1] - 1, parts[2])
  }
  const start = parse(from)
  const end = parse(to)
  if (start == null || end == null) return null
  return Math.round((end - start) / 86400000) + 1
}

function customDays(from, to) {
  if (!from || !to) return { days: null, error: '', note: '' }
  const span = daySpan(from, to)
  if (span == null) return { days: null, error: 'Pick a start and an end date.', note: '' }
  if (span < 1) return { days: null, error: 'End date is before the start date.', note: '' }
  return {
    days: Math.max(1, Math.min(90, span)),
    error: '',
    note: span > 90 ? 'Longer than 90 days — clamped to 90 (server maximum).' : ''
  }
}

function rangeDays(range) {
  if (!range || range.preset === 'today') return 1
  if (range.preset === '30d') return 30
  if (range.preset === 'custom') {
    const result = customDays(range.from, range.to)
    return result.days != null ? result.days : 7
  }
  return 7
}

function useInsights(days) {
  const rest = path => ctxRef.rest(path)
  // overview accepts days 1-90, trends 3-90, so a "Today" (1) window is widened to the
  // smallest trend the chart endpoint will take. The chart labels itself from its data.
  const trendDays = Math.max(3, days)
  const boards = useQuery({ queryKey: [ID, 'boards'], queryFn: () => rest('/boards'), refetchInterval: 120000 })
  const overview = useQuery({ queryKey: [ID, 'overview', days], queryFn: () => rest('/overview?days=' + days), refetchInterval: 60000 })
  const trends = useQuery({ queryKey: [ID, 'trends', trendDays], queryFn: () => rest('/trends?days=' + trendDays), refetchInterval: 60000 })
  const pending = useQuery({ queryKey: [ID, 'pending'], queryFn: () => rest('/pending?limit=400'), refetchInterval: 60000 })
  // The three core charts share one endpoint and one key, so changing the range re-queries
  // them together (no per-chart reload). It takes days 1-90 directly — no 3-day floor — so
  // "Today" is one honest day, never silently widened.
  const charts = useQuery({ queryKey: [ID, 'charts', days], queryFn: () => rest('/charts?days=' + days), refetchInterval: 60000 })
  return { boards, overview, trends, pending, charts, trendDays }
}

// --------------------------------------------------------------------------------------
// Building blocks
// --------------------------------------------------------------------------------------

function StatusDot(props) {
  return jsx('span', {
    'aria-hidden': true,
    className: 'inline-block size-1.5 shrink-0 rounded-full',
    style: { backgroundColor: toneOf(props.status) }
  })
}

function Tile(props) {
  const body = jsxs('div', {
    className: cn(
      'flex min-w-[7.5rem] flex-col gap-0.5 rounded-lg border border-(--ui-stroke-secondary) px-3 py-2',
      props.tone && 'border-(--ui-stroke-secondary)'
    ),
    children: [
      jsx('span', {
        className: 'text-[0.625rem] font-medium uppercase tracking-wide text-(--ui-text-quaternary)',
        children: props.label
      }),
      jsxs('span', {
        className: 'flex items-baseline gap-1.5',
        children: [
          jsx('span', { className: 'text-[1.25rem] font-semibold tabular-nums leading-none', style: props.tone ? { color: props.tone } : undefined, children: props.value }),
          props.hint
            ? jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: props.hint })
            : null
        ]
      })
    ]
  })
  if (!props.tip) return body
  return jsx(Tip, { label: props.tip, children: body })
}

function SectionTitle(props) {
  return jsxs('div', {
    className: 'flex items-center gap-2 pt-1',
    children: [
      jsx('h3', {
        className: 'text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
        children: props.children
      }),
      props.hint
        ? jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: props.hint })
        : null
    ]
  })
}

function TaskLine(props) {
  const task = props.task
  return jsxs('div', {
    className: 'flex items-baseline gap-2 border-b border-(--ui-stroke-secondary) py-1.5 last:border-0',
    children: [
      jsx(StatusDot, { status: task.status }),
      jsx('span', {
        className: 'min-w-0 flex-1 truncate text-[0.8125rem]',
        title: task.title,
        children: task.title
      }),
      jsx('span', { className: 'shrink-0 text-[0.6875rem] text-(--ui-text-quaternary)', children: task.board_name || task.board }),
      jsxs('span', {
        className: 'flex shrink-0 items-center gap-1.5 self-center text-[0.6875rem] text-(--ui-text-quaternary)',
        children: [jsx(PersonAvatar, { id: task.assignee || '' }), task.assignee || null]
      }),
      jsx('span', {
        className: 'shrink-0 font-mono text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)',
        title: props.ageLabel || 'age since created',
        children: fmtHours(props.age(task))
      })
    ]
  })
}

function BoardPicker(props) {
  const boards = props.boards
  const spaces = props.spaces
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [picked, setPicked] = useState([])

  const startEdit = () => {
    setDraft('')
    setPicked(props.selected && spaces[props.selected] ? spaces[props.selected].slice() : boards.map(board => board.slug))
    setEditing(true)
  }

  const toggle = slug => setPicked(current => (current.includes(slug) ? current.filter(item => item !== slug) : current.concat(slug)))

  const save = () => {
    if (!draft.trim()) return
    const next = Object.assign({}, spaces)
    next[draft.trim()] = picked.length ? picked : null
    writeSpaces(next)
    props.onSpaces(next)
    props.onSelect(draft.trim())
    setEditing(false)
  }

  const remove = name => {
    const next = Object.assign({}, spaces)
    delete next[name]
    writeSpaces(next)
    props.onSpaces(next)
    if (props.selected === name) props.onSelect('All boards')
    setEditing(false)
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-1',
        children: [
          Object.keys(spaces).map(name =>
            jsx('button', {
              key: name,
              type: 'button',
              onClick: () => props.onSelect(name),
              className: cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.6875rem] transition-colors',
                props.selected === name
                  ? 'border-(--ui-stroke-secondary) bg-(--chrome-action-hover) text-foreground'
                  : 'border-transparent text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
              ),
              children: [
                jsx(Codicon, { name: props.selected === name ? 'circle-filled' : 'circle-large-outline', size: '0.7rem' }),
                name,
                jsx('span', {
                  className: 'tabular-nums text-(--ui-text-quaternary)',
                  children: String((spaces[name] || props.boards.map(b => b.slug)).length)
                })
              ]
            })
          ),
          jsx(Tip, {
            label: 'A Space is a named set of boards. Edit one to scope this whole page to a project.',
            children: jsx(Button, {
              onClick: editing ? () => setEditing(false) : startEdit,
              size: 'xs',
              variant: 'ghost',
              children: editing ? 'Cancel' : 'Edit spaces'
            })
          })
        ]
      }),
      editing
        ? jsxs('div', {
            className: 'flex flex-col gap-2 rounded-lg border border-(--ui-stroke-secondary) p-2',
            children: [
              jsxs('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx('input', {
                    value: draft,
                    onChange: event => setDraft(event.target.value),
                    placeholder: 'New space name',
                    className: 'h-6 w-48 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 text-[0.75rem] outline-none focus:border-(--ui-accent)'
                  }),
                  jsx(Button, { onClick: save, size: 'xs', variant: 'secondary', disabled: !draft.trim(), children: 'Save space' })
                ]
              }),
              jsx('div', {
                className: 'flex flex-wrap gap-1',
                children: boards.map(board =>
                  jsx('button', {
                    key: board.slug,
                    type: 'button',
                    onClick: () => toggle(board.slug),
                    className: cn(
                      'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[0.6875rem]',
                      picked.includes(board.slug)
                        ? 'border-(--ui-stroke-secondary) text-foreground'
                        : 'border-transparent text-(--ui-text-quaternary)'
                    ),
                    children: [
                      jsx(Codicon, { name: picked.includes(board.slug) ? 'check' : 'circle-large-outline', size: '0.7rem' }),
                      board.icon ? jsx('span', { children: board.icon }) : null,
                      board.name || board.slug
                    ]
                  })
                )
              }),
              jsxs('div', {
                className: 'flex flex-wrap gap-1 pt-0.5',
                children: [
                  jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: 'Replace an existing space with these boards:' }),
                  Object.keys(spaces)
                    .filter(name => name !== 'All boards')
                    .map(name =>
                      jsx(Button, {
                        key: name,
                        onClick: () => {
                          const next = Object.assign({}, spaces)
                          next[name] = picked.length ? picked : null
                          writeSpaces(next)
                          props.onSpaces(next)
                          setEditing(false)
                        },
                        size: 'xs',
                        variant: 'ghost',
                        children: name
                      })
                    ),
                  props.selected !== 'All boards' && props.selected !== undefined
                    ? jsx(Button, { onClick: () => remove(props.selected), size: 'xs', variant: 'ghost', children: 'Delete "' + props.selected + '"' })
                    : null
                ]
              })
            ]
          })
        : null
    ]
  })
}

function RangeControl(props) {
  const range = props.range || DEFAULT_RANGE
  const preset = range.preset || '7d'
  const custom = preset === 'custom' ? customDays(range.from, range.to) : null

  const button = (id, label, onClick) =>
    jsx('button', {
      key: id,
      type: 'button',
      onClick,
      className: cn(
        'rounded-full border px-2.5 py-1 text-[0.6875rem] transition-colors',
        preset === id
          ? 'border-(--ui-stroke-secondary) bg-(--chrome-action-hover) text-foreground'
          : 'border-transparent text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      children: label
    })

  const dateInput = which =>
    jsx('input', {
      type: 'date',
      value: range[which] || '',
      onChange: event =>
        props.onChange({
          preset: 'custom',
          from: which === 'from' ? event.target.value : range.from,
          to: which === 'to' ? event.target.value : range.to
        }),
      className: 'h-6 rounded border border-(--ui-stroke-secondary) bg-transparent px-1.5 text-[0.6875rem] outline-none focus:border-(--ui-accent)'
    })

  return jsxs('div', {
    className: 'flex flex-wrap items-center gap-1.5',
    children: [
      jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: 'Range' }),
      button('today', 'Today', () => props.onChange({ preset: 'today' })),
      button('7d', '7 days', () => props.onChange({ preset: '7d' })),
      button('30d', '30 days', () => props.onChange({ preset: '30d' })),
      button('custom', 'Custom', () => {
        const days = props.days || 7
        props.onChange({ preset: 'custom', from: dateString(days - 1), to: dateString(0) })
      }),
      preset === 'custom'
        ? jsxs('div', {
            className: 'flex items-center gap-1',
            children: [
              dateInput('from'),
              jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: '–' }),
              dateInput('to')
            ]
          })
        : null,
      custom && custom.error
        ? jsx('span', { className: 'text-[0.6875rem]', style: { color: '#f87171' }, children: custom.error })
        : null,
      custom && custom.note
        ? jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: custom.note })
        : null,
      jsx(Button, { onClick: props.onReset, size: 'xs', variant: 'ghost', children: 'Reset' }),
      jsx(Tip, {
        label:
          'The range windows Created, Completed and Net, plus the Trends chart and the Charts view’s Completed-over-time and per-department Done counts. Workload by status, In flight, Needs you, Queue, Pending and Columns are live snapshots and ignore the range.',
        children: jsx('span', {
          className: 'inline-flex items-center gap-1 text-[0.6875rem] text-(--ui-text-quaternary)',
          children: [jsx(Codicon, { name: 'question', size: '0.7rem' }), 'what the range covers']
        })
      })
    ]
  })
}

function TrendChart(props) {
  const days = props.days
  const dips = props.dips || []
  const dipDays = {}
  dips.forEach(dip => {
    dipDays[dip.day] = true
  })
  const max = Math.max(1, ...days.map(day => Math.max(day.created, day.completed)))

  return jsxs('div', {
    className: 'flex flex-col gap-1.5',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-3 text-[0.625rem] text-(--ui-text-quaternary)',
        children: [
          jsxs('span', {
            className: 'inline-flex items-center gap-1',
            children: [
              jsx('span', { className: 'inline-block h-2 w-2 rounded-sm', style: { background: 'var(--ui-accent)' } }),
              'created'
            ]
          }),
          jsxs('span', {
            className: 'inline-flex items-center gap-1',
            children: [
              jsx('span', { className: 'inline-block h-2 w-2 rounded-sm', style: { background: '#34d399' } }),
              'completed'
            ]
          }),
          jsx('span', { className: 'ml-auto', children: 'dips marked below the day' })
        ]
      }),
      jsxs('div', {
        className: 'flex h-32 items-end gap-1 rounded-lg border border-(--ui-stroke-secondary) px-2 pt-2',
        children: days.map(day => {
          const isDip = dipDays[day.day]
          return jsxs(
            'div',
            {
              className: 'flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1',
              title: day.label + ' — ' + day.created + ' created, ' + day.completed + ' completed',
              children: [
                jsxs('div', {
                  className: 'flex h-full w-full items-end justify-center gap-0.5',
                  children: [
                    jsx('div', {
                      className: 'w-1/3 max-w-[10px] rounded-sm',
                      style: { height: Math.round((day.created / max) * 100) + '%', background: 'var(--ui-accent)', opacity: day.created ? 1 : 0 }
                    }),
                    jsx('div', {
                      className: 'w-1/3 max-w-[10px] rounded-sm',
                      style: { height: Math.round((day.completed / max) * 100) + '%', background: '#34d399', opacity: day.completed ? 1 : 0 }
                    })
                  ]
                }),
                jsx('span', {
                  className: 'text-[0.5625rem] tabular-nums',
                  style: { color: isDip ? '#f87171' : 'var(--ui-text-quaternary)' },
                  children: day.label.split(' ')[1]
                }),
                jsx('span', {
                  'aria-hidden': true,
                  className: 'text-[0.5rem] leading-none',
                  style: { color: '#f87171', opacity: isDip ? 1 : 0 },
                  children: '▼'
                })
              ]
            },
            day.day
          )
        })
      })
    ]
  })
}

// --------------------------------------------------------------------------------------
// Charts — the three range-driven panels
// --------------------------------------------------------------------------------------

// A tooltip's payload: the exact count and the card ids behind a segment. No click-through.
function segTooltip(label, count, ids) {
  const list = (ids || []).join(', ')
  return label + ' — ' + count + (list ? ' — ' + list : '')
}

function noData() {
  return jsx('div', {
    className: 'rounded-lg border border-(--ui-stroke-secondary) px-3 py-6 text-center text-[0.75rem] text-(--ui-text-quaternary)',
    children: 'no data in this range'
  })
}

function CompletedOverTimePanel(props) {
  const completed = props.completed || {}
  const buckets = completed.buckets || []
  const total = completed.total || 0
  const granularity = completed.granularity || 'day'

  if (!total) return jsxs('div', { className: 'flex flex-col gap-1.5', children: [
    jsx(SectionTitle, { children: 'Completed over time' }),
    noData()
  ] })

  const maxVal = Math.max(1, ...buckets.map(bucket => Math.max(bucket.count, bucket.ma || 0)))
  const n = buckets.length
  const unit = 40
  const H = 140
  const W = Math.max(1, n * unit)

  const bars = buckets.map((bucket, index) => {
    const h = Math.round((bucket.count / maxVal) * H)
    return jsxs('g', { key: bucket.label, children: [
      jsx('title', { children: segTooltip(bucket.label + ' · completed', bucket.count, bucket.ids) }),
      jsx('rect', {
        x: index * unit + 4,
        y: H - h,
        width: unit - 8,
        height: bucket.count ? Math.max(h, 2) : 0,
        rx: 2,
        fill: '#34d399',
        opacity: bucket.count ? 1 : 0.15
      })
    ] })
  })

  const maPoints = buckets
    .map((bucket, index) => (index * unit + unit / 2) + ',' + Math.round(H - (bucket.ma / maxVal) * H))
    .join(' ')

  const labels = buckets.map(bucket =>
    jsx('span', {
      key: bucket.label,
      className: 'flex-1 text-center text-[0.5625rem] tabular-nums text-(--ui-text-quaternary)',
      children: bucket.label
    })
  )

  return jsxs('div', { className: 'flex flex-col gap-1.5', children: [
    jsx(SectionTitle, {
      hint: total + ' completed · peak ' + maxVal + '/' + (granularity === 'day' ? 'day' : 'week') + ' · ' + n + (granularity === 'day' ? ' day' + (n === 1 ? '' : 's') : ' week' + (n === 1 ? '' : 's')),
      children: 'Completed over time'
    }),
    jsxs('div', { className: 'flex items-center gap-3 text-[0.625rem] text-(--ui-text-quaternary)', children: [
      jsxs('span', { className: 'inline-flex items-center gap-1', children: [
        jsx('span', { className: 'inline-block h-2 w-2 rounded-sm', style: { background: '#34d399' } }), 'completed'
      ] }),
      jsxs('span', { className: 'inline-flex items-center gap-1', children: [
        jsx('span', { className: 'inline-block h-0.5 w-3', style: { background: 'var(--ui-accent)' } }), 'moving average'
      ] })
    ] }),
    jsx('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      preserveAspectRatio: 'none',
      style: { width: '100%', height: H, display: 'block' },
      children: jsxs('g', { children: [
        bars,
        jsx('polyline', { points: maPoints, fill: 'none', stroke: 'var(--ui-accent)', strokeWidth: 2, vectorEffect: 'non-scaling-stroke' })
      ] })
    }),
    jsxs('div', { className: 'flex items-start', children: labels })
  ] })
}

function ByDepartmentPanel(props) {
  const departments = props.departments || {}
  const rows = departments.rows || []
  const total = departments.total || 0

  if (!total) return jsxs('div', { className: 'flex flex-col gap-1.5', children: [
    jsx(SectionTitle, { children: 'Tasks by department' }),
    noData()
  ] })

  const maxTotal = Math.max(1, ...rows.map(row => row.total))

  return jsxs('div', { className: 'flex flex-col gap-1.5', children: [
    jsx(SectionTitle, {
      hint: total + ' cards · done = completed in range · open = live snapshot',
      children: 'Tasks by department'
    }),
    jsxs('div', { className: 'flex flex-col gap-1.5', children: [
      rows.map(row => {
        const doneIds = row.done_ids || []
        const openIds = row.open_ids || []
        const doneTooltip = segTooltip(row.department + ' · done', row.done, doneIds)
        const openTooltip = segTooltip(row.department + ' · open', row.open, openIds)
        return jsxs('div', { key: row.department, className: 'flex items-center gap-2', children: [
          jsx('div', { className: 'w-24 shrink-0 truncate text-right text-[0.75rem]', title: row.department, children: row.department }),
          jsxs('div', {
            className: 'flex h-3.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-(--ui-stroke-secondary)',
            children: [
              row.done
                ? jsx('div', {
                    className: 'h-full shrink-0',
                    style: { width: (row.done / maxTotal) * 100 + '%', background: '#34d399' },
                    title: doneTooltip
                  })
                : null,
              row.open
                ? jsx('div', {
                    className: 'h-full shrink-0',
                    style: { width: (row.open / maxTotal) * 100 + '%', background: 'var(--ui-text-tertiary)' },
                    title: openTooltip
                  })
                : null
            ]
          }),
          jsx('div', { className: 'w-28 shrink-0 text-right text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)', children: [
            row.done + ' done · ' + row.open + ' open'
          ] })
        ] })
      })
    ] })
  ] })
}

function WorkloadByStatusPanel(props) {
  const workload = props.workload || {}
  const rows = workload.rows || []
  const total = workload.total || 0

  if (!total) return jsxs('div', { className: 'flex flex-col gap-1.5', children: [
    jsx(SectionTitle, { children: 'Workload by status' }),
    noData()
  ] })

  return jsxs('div', { className: 'flex flex-col gap-1.5', children: [
    jsx(SectionTitle, {
      hint: total + ' cards · live snapshot of every column, in the board’s own order',
      children: 'Workload by status'
    }),
    jsxs('div', {
      className: 'flex h-6 w-full overflow-hidden rounded-md border border-(--ui-stroke-secondary)',
      children: rows.map(row =>
        jsx('div', {
          key: row.status,
          className: 'h-full',
          style: { width: (row.count / total) * 100 + '%', background: toneOf(row.status) },
          title: segTooltip(row.status, row.count, row.ids)
        })
      )
    }),
    jsxs('div', { className: 'flex flex-wrap gap-x-3 gap-y-1', children: [
      rows.map(row =>
        jsxs('span', { key: row.status, className: 'inline-flex items-center gap-1 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)', title: segTooltip(row.status, row.count, row.ids), children: [
          jsx(StatusDot, { status: row.status }),
          row.status,
          jsx('span', { className: 'text-(--ui-text-quaternary)', children: String(row.count) })
        ] })
      )
    ] })
  ] })
}

// A verbatim quote from a card: quoted, never paraphrased. Empty text falls back to the
// card's status and last-event time so nothing is invented. Long text truncates behind an
// expand control so a wall of quotes can never push the charts off screen.
function QuotedLine(props) {
  const [open, setOpen] = useState(false)
  const text = props.text || ''
  if (!text) {
    return jsx('span', { className: 'text-[0.6875rem] italic text-(--ui-text-quaternary)', children: props.fallback })
  }
  const short = text.length > 200
  const shown = short && !open ? text.slice(0, 200) + '…' : text
  return jsxs('span', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: [
    jsx('span', { children: '\u201c' + shown + '\u201d' }),
    short
      ? jsx('button', {
          type: 'button',
          onClick: () => setOpen(value => !value),
          className: 'ml-1 align-baseline text-[0.625rem] text-(--ui-accent)',
          children: open ? 'show less' : 'show more'
        })
      : null
  ] })
}

function FinishedItem(props) {
  const item = props.item
  const fallback =
    (item.status || 'done') + (item.last_event_h != null ? ' · last event ' + fmtHours(item.last_event_h) + ' ago' : '')
  return jsxs('div', { className: 'flex flex-col gap-0.5 border-b border-(--ui-stroke-secondary) py-1.5 last:border-0', children: [
    jsxs('div', { className: 'flex items-baseline gap-2', children: [
      jsx(StatusDot, { status: item.status }),
      jsx(PersonAvatar, { id: item.assignee || '', className: 'self-center' }),
      jsxs('span', { className: 'min-w-0 flex-1', children: [
        jsx('span', { className: 'text-[0.8125rem]', children: item.title }),
        item.board_name
          ? jsx('span', { className: 'ml-2 text-[0.6875rem] text-(--ui-text-quaternary)', children: item.board_name })
          : null
      ] })
    ] }),
    jsx('div', { className: 'pl-3.5', children: jsx(QuotedLine, { text: item.summary, fallback }) }),
    item.comment
      ? jsx('div', { className: 'pl-3.5', children: jsx(QuotedLine, { text: item.comment, fallback: '' }) })
      : null
  ] })
}

function RunningItem(props) {
  const item = props.item
  return jsxs('div', { className: 'flex items-baseline gap-2 border-b border-(--ui-stroke-secondary) py-1.5 last:border-0', children: [
    jsx(StatusDot, { status: 'running' }),
    jsx(PersonAvatar, { id: item.assignee || '', className: 'self-center' }),
    jsx('span', { className: 'min-w-0 flex-1 truncate text-[0.8125rem]', title: item.title, children: item.title }),
    item.running_h != null
      ? jsx('span', { className: 'shrink-0 font-mono text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)', children: fmtHours(item.running_h) })
      : null
  ] })
}

function BlockedItem(props) {
  const item = props.item
  const kind = item.block_kind === 'needs_input' ? 'waiting on a person' : item.status
  return jsxs('div', { className: 'flex items-baseline gap-2 border-b border-(--ui-stroke-secondary) py-1.5 last:border-0', children: [
    jsx(StatusDot, { status: 'blocked' }),
    jsx(PersonAvatar, { id: item.assignee || '', className: 'self-center' }),
    jsx('span', { className: 'min-w-0 flex-1 truncate text-[0.8125rem]', title: item.title, children: item.title }),
    jsx('span', { className: 'shrink-0 text-[0.6875rem]', style: { color: '#f87171' }, children: kind }),
    item.last_event_h != null
      ? jsx('span', { className: 'shrink-0 font-mono text-[0.6875rem] tabular-nums text-(--ui-text-quaternary)', children: fmtHours(item.last_event_h) + ' ago' })
      : null
  ] })
}

function StandupCard(props) {
  const dept = props.department
  const finished = dept.finished || []
  const running = dept.running || []
  const blocked = dept.blocked || []
  const nothing = !finished.length && !running.length && !blocked.length
  return jsxs('div', { className: 'flex flex-col gap-1.5 rounded-lg border border-(--ui-stroke-secondary) p-2.5', children: [
    jsxs('div', { className: 'flex items-baseline gap-2', children: [
      jsx('span', { className: 'text-[0.75rem] font-medium', children: dept.department }),
      jsx('span', { className: 'text-[0.625rem] tabular-nums text-(--ui-text-quaternary)', children: finished.length + ' finished · ' + running.length + ' running · ' + blocked.length + ' blocked' })
    ] }),
    nothing
      ? jsx('div', { className: 'text-[0.75rem] text-(--ui-text-quaternary)', children: 'Nothing in this range.' })
      : jsxs('div', { className: 'flex flex-col gap-1.5', children: [
          finished.length
            ? jsxs('div', { className: 'flex flex-col gap-0.5', children: [
                jsx('span', { className: 'text-[0.625rem] font-medium uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Finished' }),
                finished.map(item => jsx(FinishedItem, { key: item.board + ':' + item.id, item }))
              ] })
            : null,
          running.length
            ? jsxs('div', { className: 'flex flex-col gap-0.5', children: [
                jsx('span', { className: 'text-[0.625rem] font-medium uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Running now' }),
                running.map(item => jsx(RunningItem, { key: item.board + ':' + item.id, item }))
              ] })
            : null,
          blocked.length
            ? jsxs('div', { className: 'flex flex-col gap-0.5', children: [
                jsx('span', { className: 'text-[0.625rem] font-medium uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Blocked · snapshot' }),
                blocked.map(item => jsx(BlockedItem, { key: item.board + ':' + item.id, item }))
              ] })
            : null
        ] })
  ] })
}

function StandupsPanel(props) {
  const standups = props.standups || {}
  const rows = standups.rows || []
  if (!rows.length) {
    return jsxs('div', { className: 'flex flex-col gap-1.5', children: [
      jsx(SectionTitle, { children: 'Department standups' }),
      noData()
    ] })
  }
  return jsxs('div', { className: 'flex flex-col gap-1.5', children: [
    jsx(SectionTitle, {
      hint: standups.departments + ' departments · ' + standups.finished + ' finished · ' + standups.running + ' running · ' + standups.blocked + ' blocked (snapshot)',
      children: 'Department standups'
    }),
    jsxs('div', { className: 'grid gap-2 lg:grid-cols-2', children: rows.map(dept => jsx(StandupCard, { key: dept.department, department: dept })) })
  ] })
}

function NetFlowPanel(props) {
  const flow = props.flow || {}
  const buckets = flow.buckets || []
  if (!buckets.length) {
    return jsxs('div', { className: 'flex flex-col gap-1.5', children: [
      jsx(SectionTitle, { children: 'Net flow' }),
      noData()
    ] })
  }
  const created = flow.total_created || 0
  const completed = flow.total_completed || 0
  const net = flow.net || 0
  const growing = net > 0
  const shrinking = net < 0
  const signColor = growing ? '#fbbf24' : shrinking ? '#34d399' : 'var(--ui-text-tertiary)'
  const signLabel = growing ? 'backlog growing' : shrinking ? 'backlog shrinking' : 'unchanged'
  const max = Math.max(1, ...buckets.map(b => Math.max(b.created, b.completed)))

  return jsxs('div', { className: 'flex flex-col gap-1.5', children: [
    jsx(SectionTitle, {
      hint: created + ' created · ' + completed + ' completed · ' + (flow.granularity === 'day' ? 'per day' : 'per week'),
      children: 'Net flow'
    }),
    jsxs('div', { className: 'flex items-center gap-3 text-[0.625rem] text-(--ui-text-quaternary)', children: [
      jsxs('span', { className: 'inline-flex items-center gap-1', children: [
        jsx('span', { className: 'inline-block h-2 w-2 rounded-sm', style: { background: 'var(--ui-accent)' } }), 'created'
      ] }),
      jsxs('span', { className: 'inline-flex items-center gap-1', children: [
        jsx('span', { className: 'inline-block h-2 w-2 rounded-sm', style: { background: '#34d399' } }), 'completed'
      ] }),
      jsxs('span', { className: 'ml-auto', style: { color: signColor }, children: [
        jsx('span', { className: 'font-semibold', children: 'net ' + (net > 0 ? '+' : '') + net }),
        ' · ' + signLabel
      ] })
    ] }),
    jsxs('div', {
      className: 'flex h-24 items-end gap-1 rounded-lg border border-(--ui-stroke-secondary) px-2 pt-2',
      children: buckets.map(bucket => {
        const netColor = bucket.net > 0 ? '#fbbf24' : bucket.net < 0 ? '#34d399' : 'var(--ui-text-quaternary)'
        const netText = (bucket.net > 0 ? '+' : '') + bucket.net
        return jsxs('div', {
          className: 'flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1',
          title: bucket.label + ' — created ' + bucket.created + ' · completed ' + bucket.completed + ' · net ' + netText,
          children: [
            jsxs('div', { className: 'flex h-full w-full items-end justify-center gap-0.5', children: [
              jsx('div', {
                className: 'w-1/3 max-w-[10px] rounded-sm',
                style: { height: Math.round((bucket.created / max) * 100) + '%', background: 'var(--ui-accent)', opacity: bucket.created ? 1 : 0 }
              }),
              jsx('div', {
                className: 'w-1/3 max-w-[10px] rounded-sm',
                style: { height: Math.round((bucket.completed / max) * 100) + '%', background: '#34d399', opacity: bucket.completed ? 1 : 0 }
              })
            ] }),
            jsx('span', {
              className: 'text-[0.5625rem] tabular-nums',
              style: { color: bucket.net ? netColor : 'var(--ui-text-quaternary)' },
              children: bucket.net ? netText : '·'
            }),
            jsx('span', { className: 'text-[0.5rem] leading-none text-(--ui-text-quaternary)', children: bucket.label.split(' ')[1] })
          ]
        }, bucket.label)
      })
    })
  ] })
}

// --------------------------------------------------------------------------------------
// Dashboard — every graph in one place, one date range driving all of it
// --------------------------------------------------------------------------------------

// A three-column grid at the default window width, one column when the window is narrow, so
// the page never scrolls sideways. Order is fixed here and asserted by the verify harness:
//   summary | completed over time | workload by status
//   net flow | tasks by department | created vs completed
//   by assignee (full width)
//   department standups (full width, last: the longest panel by far)
function DashboardPanel(props) {
  const overview = props.overview || {}
  const trends = props.trends || {}
  const charts = props.charts || {}
  const days = props.days
  const trendDays = props.trendDays

  return jsxs('div', {
    className: 'grid grid-cols-1 gap-3 lg:grid-cols-3',
    children: [
      jsx(DashboardCard, { children: jsxs('div', { className: 'flex flex-col gap-2', children: [
        jsx(SectionTitle, { hint: 'snapshot counters plus the ' + days + 'd window', children: 'Summary' }),
        jsx(SnapshotCounters, { overview }),
        jsx(WindowTiles, { tiles: overview.tiles || {}, days }),
        jsx(SectionTitle, { hint: 'cycle · runs ' + Math.min(7, trendDays || 14) + 'd', children: 'Cycle and runs' }),
        jsx(TrendTiles, { trends, trendDays })
      ] }) }),
      jsx(DashboardCard, { children: jsx(CompletedOverTimePanel, { completed: charts.completed_over_time }) }),
      jsx(DashboardCard, { children: jsx(WorkloadByStatusPanel, { workload: charts.workload_by_status }) }),
      jsx(DashboardCard, { children: jsx(NetFlowPanel, { flow: charts.net_flow }) }),
      jsx(DashboardCard, { children: jsx(ByDepartmentPanel, { departments: charts.by_department }) }),
      jsx(DashboardCard, { children: jsx(CreatedVsCompletedPanel, { trends, trendDays }) }),
      jsx(DashboardCard, { className: 'lg:col-span-3', children: jsx(ByAssigneePanel, { trends, trendDays }) }),
      jsx(DashboardCard, { className: 'lg:col-span-3', children: jsx(StandupsPanel, { standups: charts.standups }) })
    ]
  })
}

// --------------------------------------------------------------------------------------
// Pieces both views share
// --------------------------------------------------------------------------------------

// What makes up the queue number: a column list with no counts in it reads as a template
// nobody filled in, and "ready 1" alone hides the eleven cards behind it.
function queueHint(columns, tiles) {
  const parts = ['triage', 'todo', 'scheduled', 'ready']
    .filter(name => Number(columns[name]) > 0)
    .map(name => columns[name] + ' ' + name)
  return parts.length ? parts.join(' · ') : (tiles.queue || 0) + ' waiting to be picked up'
}

// List's counters: a live snapshot, so they never move with the date range.
function SnapshotCounters(props) {
  const overview = props.overview || {}
  const tiles = overview.tiles || {}

  return jsxs('div', {
    className: 'flex flex-wrap gap-2',
    children: [
      jsx(Tile, {
        label: 'In flight',
        value: tiles.in_flight,
        tone: '#34d399',
        hint: tiles.running + ' running · ' + tiles.blocked + ' blocked',
        tip: 'Cards a worker has claimed or that are waiting on a review. The blocked ones are also counted under Needs you - the tiles overlap on purpose, one reads work in progress, the other reads work stuck.'
      }),
      jsx(Tile, {
        label: 'Needs you',
        value: tiles.blocked + tiles.review,
        tone: '#f87171',
        hint: tiles.blocked + ' blocked · ' + tiles.review + ' review',
        tip: 'Blocked plus review: the two columns that cannot move without a person.'
      }),
      jsx(Tile, {
        label: 'Queue',
        value: tiles.queue,
        tone: '#60a5fa',
        hint: queueHint(overview.columns || {}, tiles),
        tip: 'Everything waiting to be picked up, in dispatch order.'
      })
    ]
  })
}

// The three counters the date range owns. They sit in the Dashboard's summary block and never
// in List, so the one range control cannot silently relabel a snapshot number.
function WindowTiles(props) {
  const tiles = props.tiles || {}
  const days = props.days

  return jsxs('div', {
    className: 'flex flex-wrap gap-2',
    children: [
      jsx(Tile, {
        label: 'Created ' + days + 'd',
        value: tiles['created_' + days + 'd'] || 0,
        tip: 'Cards created in the last ' + days + ' days across the boards in this Space.'
      }),
      jsx(Tile, {
        label: 'Completed ' + days + 'd',
        value: tiles['completed_' + days + 'd'] || 0,
        tone: '#34d399',
        hint: fmtDelta(tiles['completed_' + days + 'd'] || 0, tiles['completed_prev_' + days + 'd'] || 0),
        tip: 'Completed this window, with the change against the window before it.'
      }),
      jsx(Tile, {
        label: 'Net ' + days + 'd',
        value: (tiles['net_' + days + 'd'] > 0 ? '+' : '') + (tiles['net_' + days + 'd'] || 0),
        tone: tiles['net_' + days + 'd'] > 0 ? '#fbbf24' : '#34d399',
        hint: 'backlog ' + (tiles['net_' + days + 'd'] > 0 ? 'growing' : 'shrinking'),
        tip: 'Created minus completed. Positive means the backlog grew faster than it was cleared.'
      })
    ]
  })
}

// One card per Dashboard panel, so the grid reads as blocks rather than one long column.
function DashboardCard(props) {
  return jsx('div', {
    className: cn('flex min-w-0 flex-col gap-1.5 rounded-lg border border-(--ui-stroke-secondary) p-2.5', props.className),
    children: props.children
  })
}

function ListPanel(props) {
  const overview = props.overview
  const columns = overview.columns || {}

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsx('div', {
        className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
        children: 'Live snapshot: every unfinished card across the boards in this Space.'
      }),
      jsx(SnapshotCounters, { overview }),
      jsxs('div', {
        className: 'flex flex-col gap-1',
        children: [
          jsx(SectionTitle, { hint: 'blocked and in review, longest wait first', children: 'Waiting on a person' }),
          (overview.blockers || []).length
            ? overview.blockers.map(task => jsx('div', { className: 'flex flex-col gap-1 border-b border-(--ui-stroke-secondary) py-1.5 last:border-0', children: [
                jsxs('div', { className: 'flex items-baseline gap-2', children: [
                  jsx(StatusDot, { status: task.status }),
                  jsxs('span', { className: 'min-w-0 flex-1', children: [
                    jsx('span', { className: 'text-[0.8125rem]', children: task.title })
                  ] }),
                  jsx('span', { className: 'shrink-0 text-[0.6875rem] text-(--ui-text-quaternary)', children: task.board_name || task.board }),
                  jsx(Tip, { label: 'Time since it stopped: waiting on a person, not on compute.', children: jsx('span', { className: 'shrink-0 font-mono text-[0.6875rem] tabular-nums', style: { color: '#f87171' }, children: fmtHours(task.waiting_h || task.age_h) }) })
                ] })
              ] }, task.id))
            : jsx('div', { className: 'text-[0.75rem] text-(--ui-text-quaternary)', children: 'Nothing is blocked. Good.' })
        ]
      }),
      jsxs('div', {
        className: 'grid gap-4 md:grid-cols-2',
        children: [
          jsxs('div', {
            className: 'flex flex-col gap-1',
            children: [
              jsx(SectionTitle, { hint: 'running longest first', children: 'In flight now' }),
              (overview.running_top || []).length
                ? overview.running_top.map(task => jsx(TaskLine, { key: task.id, task, age: item => item.running_h }), 'run')
                : jsx('div', { className: 'text-[0.75rem] text-(--ui-text-quaternary)', children: 'No worker is running a card.' })
            ]
          }),
          jsxs('div', {
            className: 'flex flex-col gap-1',
            children: [
              jsx(SectionTitle, { hint: 'oldest card first', children: 'Sitting in the queue' }),
              (overview.oldest_ready || []).length
                ? overview.oldest_ready.map(task => jsx(TaskLine, { key: task.id, task, age: item => item.age_h }))
                : jsx('div', { className: 'text-[0.75rem] text-(--ui-text-quaternary)', children: 'The queue is empty.' })
            ]
          })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2 pt-1 text-[0.6875rem] text-(--ui-text-quaternary)',
        children: [
          jsx(SectionTitle, { children: 'Columns' }),
          STATUS_ORDER.filter(status => columns[status])
            .map(status =>
              jsxs('span', { className: 'inline-flex items-center gap-1', children: [
                jsx(StatusDot, { status }),
                status,
                jsx('span', { className: 'tabular-nums text-(--ui-text-tertiary)', children: String(columns[status]) })
              ] }, status)
            )
        ]
      }),
      jsxs('div', {
        className: 'flex flex-col gap-2 border-t border-(--ui-stroke-secondary) pt-3',
        children: [
          jsx(SectionTitle, { hint: 'live snapshot · age, run and waiting times as of now', children: 'Every unfinished card' }),
          jsx(PendingPanel, { tasks: props.tasks, counts: props.counts, inline: true })
        ]
      })
    ]
  })
}

// The created-vs-completed series: the chart the old Trends view drew, now one card in the
// Dashboard grid.
function CreatedVsCompletedPanel(props) {
  const series = (props.trends || {}).series || { days: [], dips: [] }

  return jsxs('div', {
    className: 'flex flex-col gap-1.5',
    children: [
      jsx(SectionTitle, { hint: series.days.length + ' days · local time', children: 'Created vs completed' }),
      jsx(TrendChart, { days: series.days, dips: series.dips })
    ]
  })
}

// The runs tile has to reconcile with its own total: showing only ok and failed leaves
// whatever else finished (reclaimed, blocked, still alive) unexplained, which reads as a
// bug. Every bucket that is non-zero is named.
function runHint(runs) {
  const named = [
    [runs.ok, 'ok'],
    [runs.failed, 'failed'],
    [runs.reclaimed, 'reclaimed'],
    [runs.changes, 'changes'],
    [runs.review, 'review'],
    [runs.blocked, 'blocked'],
    [runs.active, 'running'],
    [runs.stale, 'stale'],
    [runs.other, 'other']
  ]
  const parts = named.filter(([count]) => Number(count) > 0).map(([count, name]) => count + ' ' + name)
  return parts.length ? parts.join(' · ') : 'no runs yet'
}

// Cycle and run health: the five tiles the old Trends view carried. by_assignee and runs are
// capped server-side at min(days, 7); the labels come from that same cap, so a 30-day
// selection never sits over 7-day data.
function TrendTiles(props) {
  const trends = props.trends || {}
  const cycle = trends.cycle || {}
  const runs = trends.runs || {}
  const cappedDays = Math.min(7, props.trendDays || 14)

  return jsxs('div', {
    className: 'flex flex-wrap gap-2',
    children: [
      jsx(Tile, {
        label: 'Run time median',
        value: fmtHours(cycle.run ? cycle.run.median_h : null),
        hint: (cycle.run ? cycle.run.n : 0) + ' cards',
        tip: 'From a worker claiming the card to completion — the part you can actually tune.'
      }),
      jsx(Tile, {
        label: 'Lead time median',
        value: fmtHours(cycle.lead ? cycle.lead.median_h : null),
        hint: (cycle.lead ? cycle.lead.n : 0) + ' cards',
        tip: 'From the card being created to done, including the time it sat in the queue.'
      }),
      jsx(Tile, {
        label: 'Runs ' + cappedDays + 'd',
        value: runs.total || 0,
        hint: runHint(runs),
        tone: runs.failed ? '#f87171' : undefined,
        tip: RUN_TIP
      }),
      jsx(Tile, {
        label: 'Handed to a person',
        value: (runs.review || 0) + (runs.changes || 0),
        tone: (runs.changes || 0) > 0 ? '#fbbf24' : undefined,
        hint: (runs.review || 0) + ' review · ' + (runs.changes || 0) + ' changes',
        tip: 'Runs that ended waiting on a human: review_requested means a reviewer has it, changes_requested means it came back for edits. Those two are your queue.'
      }),
      jsx(Tile, {
        label: 'Stale runs',
        value: runs.stale || 0,
        tone: runs.stale ? '#fbbf24' : undefined,
        hint: (runs.active || 0) + ' alive',
        tip: 'Claims still marked running with no heartbeat in 10 minutes: the worker is gone but the row never closed. Nothing on the board shows this.'
      })
    ]
  })
}

// Open / completed / failed per assignee: the table the old Trends view carried.
function ByAssigneePanel(props) {
  const assigns = (props.trends || {}).by_assignee || []
  const cappedDays = Math.min(7, props.trendDays || 14)

  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsx(SectionTitle, { hint: 'open cards, completed ' + cappedDays + 'd, failed runs', children: 'By assignee' }),
      jsxs('table', {
        className: 'w-full text-[0.75rem]',
        children: [
          jsx('thead', {
            children: jsxs('tr', {
              className: 'text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary)',
              children: [
                jsx('th', { className: 'py-1 text-left font-medium', children: 'Assignee' }),
                jsx('th', { className: 'py-1 text-right font-medium', children: 'Open' }),
                jsx('th', { className: 'py-1 text-right font-medium', children: 'Running' }),
                jsx('th', { className: 'py-1 text-right font-medium', children: 'Blocked' }),
                jsx('th', { className: 'py-1 text-right font-medium', children: 'Ready' }),
                jsx('th', { className: 'py-1 text-right font-medium', children: 'Done ' + cappedDays + 'd' }),
                jsx('th', { className: 'py-1 text-right font-medium', children: 'Failed ' + cappedDays + 'd' })
              ]
            })
          }),
          jsx('tbody', {
            children: assigns.map(person =>
              jsxs('tr', {
                className: 'border-t border-(--ui-stroke-secondary)',
                children: [
                  jsx('td', {
                    className: 'py-1 text-left',
                    children: jsxs('span', {
                      className: 'flex items-center gap-1.5',
                      children: [jsx(PersonAvatar, { id: person.assignee }), person.assignee]
                    })
                  }),
                  jsx('td', { className: 'py-1 text-right tabular-nums', children: person.open }),
                  jsx('td', { className: 'py-1 text-right tabular-nums', children: person.running }),
                  jsx('td', { className: 'py-1 text-right tabular-nums', style: person.blocked ? { color: '#f87171' } : undefined, children: person.blocked }),
                  jsx('td', { className: 'py-1 text-right tabular-nums', children: person.ready }),
                  jsx('td', { className: 'py-1 text-right tabular-nums', style: person.completed ? { color: '#34d399' } : undefined, children: person.completed }),
                  jsx('td', { className: 'py-1 text-right tabular-nums', style: person.failed ? { color: '#f87171' } : undefined, children: person.failed })
                ]
              }, person.assignee)
            )
          })
        ]
      })
    ]
  })
}

function PendingPanel(props) {
  const tasks = props.tasks
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState('open')
  const counts = props.counts || {}

  const needle = filter.trim().toLowerCase()
  const shown = tasks.filter(task => {
    if (status !== 'open' && task.status !== status) return false
    if (!needle) return true
    return (task.title + ' ' + task.id + ' ' + (task.body || '') + ' ' + (task.assignee || '')).toLowerCase().includes(needle)
  })

  // Oldest first: the card nobody has touched is the one worth seeing.
  const sorted = shown.slice().sort((left, right) => {
    const rank = item => STATUS_ORDER.indexOf(item.status)
    const byStatus = rank(left) - rank(right)
    if (byStatus !== 0) return byStatus
    return (right.age_h || 0) - (left.age_h || 0)
  })

  return jsxs('div', {
    className: props.inline ? 'flex flex-col gap-2' : 'flex h-full flex-col gap-2',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx(SearchField, { value: filter, onChange: value => setFilter(value), placeholder: 'Filter every unfinished card…' }),
          jsx(Tip, {
            label: 'Priority: higher runs first. The rest is the board’s own dispatch order — priority DESC, then oldest first.',
            children: jsx('span', {
              className: 'inline-flex items-center gap-1 text-[0.6875rem] text-(--ui-text-quaternary)',
              children: [jsx(Codicon, { name: 'question', size: '0.7rem' }), 'how priority works']
            })
          }),
          jsx('span', { className: 'ml-auto text-[0.6875rem] tabular-nums text-(--ui-text-quaternary)', children: shown.length + ' of ' + tasks.length })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-1',
        children: [
          jsx('button', {
            type: 'button',
            onClick: () => setStatus('open'),
            className: cn(
              'rounded-full border px-2.5 py-1 text-[0.6875rem]',
              status === 'open' ? 'border-(--ui-stroke-secondary) bg-(--chrome-action-hover) text-foreground' : 'border-transparent text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'
            ),
            children: 'All open'
          }),
          STATUS_ORDER.filter(name => counts[name])
            .map(name =>
              jsxs('button', {
                type: 'button',
                onClick: () => setStatus(status === name ? 'open' : name),
                className: cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[0.6875rem]',
                  status === name ? 'border-(--ui-stroke-secondary) bg-(--chrome-action-hover) text-foreground' : 'border-transparent text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'
                ),
                children: [jsx(StatusDot, { status: name }), name, jsx('span', { className: 'tabular-nums text-(--ui-text-quaternary)', children: String(counts[name]) })]
              }, name)
            )
        ]
      }),
      sorted.length
        ? jsx(props.inline ? 'div' : ScrollArea, {
            className: props.inline ? undefined : 'min-h-0 flex-1',
            children: jsx('div', {
              children: sorted.map(task =>
                jsxs('div', {
                  className: 'flex items-start gap-2 border-b border-(--ui-stroke-secondary) px-1 py-1.5 hover:bg-(--chrome-action-hover)',
                  children: [
                    jsx(StatusDot, { status: task.status }),
                    jsxs('div', {
                      className: 'min-w-0 flex-1',
                      children: [
                        jsx('div', { className: 'truncate text-[0.8125rem]', title: task.title, children: task.title }),
                        jsxs('div', {
                          className: 'flex flex-wrap items-center gap-2 pt-0.5 text-[0.75rem] text-(--ui-text-tertiary)',
                          children: [
                            jsx('span', { children: task.board_name || task.board }),
                            jsx('span', { className: 'font-mono', children: task.id }),
                            task.assignee
                              ? jsxs('span', { className: 'flex items-center gap-1.5', children: [jsx(PersonAvatar, { id: task.assignee }), task.assignee] })
                              : jsxs('span', { className: 'flex items-center gap-1.5 text-(--ui-text-quaternary)', children: [jsx(PersonAvatar, { id: '' }), 'unassigned'] }),
                            task.priority !== null && task.priority !== undefined
                              ? jsx(Tip, {
                                  label: PRIORITY_TIP,
                                  children: jsx('span', { className: 'cursor-help font-mono', children: 'p' + task.priority })
                                })
                              : null,
                            task.comments ? jsx('span', { children: task.comments + (task.comments === 1 ? ' comment' : ' comments') }) : null,
                            task.last_event_h !== null && task.last_event_h !== undefined
                              ? jsx('span', { children: 'last event ' + fmtHours(task.last_event_h) + ' ago' })
                              : null
                          ]
                        })
                      ]
                    }),
                    jsxs('div', {
                      className: 'shrink-0 text-right text-[0.6875rem] tabular-nums',
                      children: [
                        jsxs('div', { className: 'text-(--ui-text-tertiary)', children: ['age ', fmtHours(task.age_h)] }),
                        task.status === 'running'
                          ? jsx('div', { className: 'text-(--ui-text-quaternary)', children: ['run ', fmtHours(task.running_h)] })
                          : null,
                        task.waiting_h !== null && task.waiting_h !== undefined && (task.status === 'blocked' || task.status === 'review')
                          ? jsx('div', { style: { color: '#f87171' }, children: ['waiting ', fmtHours(task.waiting_h)] })
                          : null
                      ]
                    })
                  ]
                }, task.board + ':' + task.id)
              )
            })
          })
        : jsx(EmptyState, { title: 'Nothing matches', description: 'No unfinished card in this Space matches that filter.' })
    ]
  })
}

function InsightsPage() {
  const t = usePluginI18n(ID)
  const [view, setView] = useState('list')
  const [spaces, setSpaces] = useState(readSpaces)
  // Open on every board. A Space the user made is one click away in the picker; the page
  // never guesses which project you meant.
  const [space, setSpace] = useState(() => {
    const names = Object.keys(readSpaces())
    return names.includes('All boards') ? 'All boards' : names[0]
  })
  // The date window, defaulting to 7 days so today's view is unchanged until a range is picked.
  const [range, setRange] = useState(readRange)
  const days = rangeDays(range)
  const data = useInsights(days)

  const changeRange = next => {
    writeRange(next)
    setRange(next)
  }

  const active = spaces[space] || null
  const inSpace = rows => (active ? rows.filter(row => active.includes(row.board || row.slug)) : rows)

  if (data.overview.isPending) {
    return jsxs('div', {
      className: 'flex h-full items-center justify-center gap-2 text-xs text-(--ui-text-tertiary)',
      children: [jsx(GlyphSpinner, {}), t('loading')]
    })
  }
  if (data.overview.isError) {
    return jsx(ErrorState, { title: t('error'), description: t('errorTip') })
  }

  const boards = (data.boards.data && data.boards.data.boards) || []
  // A fresh install has no boards at all. That is not an error and not an empty dashboard:
  // say what this page needs and where it comes from, once, instead of painting zeroes.
  if (!data.boards.isPending && !boards.length) {
    return jsx('div', {
      className: 'flex h-full items-center justify-center p-6',
      children: jsx(EmptyState, {
        title: 'No Kanban boards yet',
        description:
          'Board insights reads the Kanban store on this machine, read-only. Create a board on the Kanban page and it appears here - there is nothing to configure.'
      })
    })
  }

  const overview = data.overview.data || {}
  const trends = data.trends.data || {}
  const pending = data.pending.data || {}
  const charts = data.charts.data || {}
  const errors = (overview.errors || []).concat(trends.errors || [], pending.errors || [], charts.errors || [])

  const scopedTasks = inSpace(pending.tasks || [])
  const counts = {}
  scopedTasks.forEach(task => {
    counts[task.status] = (counts[task.status] || 0) + 1
  })

  const views = [
    { id: 'list', label: 'List' },
    { id: 'dashboard', label: 'Dashboard' }
  ]

  return jsxs('div', {
    className: 'flex h-full flex-col gap-3 p-3',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx(Codicon, { name: 'graph', size: '0.9rem' }),
          jsx('span', { className: 'text-[0.8125rem] font-medium', children: 'Board insights' }),
          jsx('span', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: boards.length + ' boards · read-only'
          }),
          jsxs('div', {
            className: 'ml-auto flex items-center gap-1',
            children: [
              views.map(item =>
                jsx('button', {
                  key: item.id,
                  type: 'button',
                  onClick: () => setView(item.id),
                  className: cn(
                    'rounded px-2 py-1 text-[0.75rem] transition-colors',
                    view === item.id
                      ? 'bg-(--chrome-action-hover) text-foreground'
                      : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
                  ),
                  children: item.label
                }, 'view')
              ),
              jsx(Button, {
                onClick: () => {
                  data.boards.refetch()
                  data.overview.refetch()
                  data.trends.refetch()
                  data.pending.refetch()
                  data.charts.refetch()
                },
                size: 'xs',
                variant: 'ghost',
                children: t('refresh')
              })
            ]
          })
        ]
      }),
      // The range drives the Dashboard's charts only. On the List it would be a control that
      // changes nothing, and the page had to explain itself twice because of it.
      view === 'dashboard'
        ? jsx(RangeControl, { range, days, onChange: changeRange, onReset: () => changeRange({ preset: '7d' }) })
        : null,
      jsx(BoardPicker, { boards, spaces, selected: space, onSelect: setSpace, onSpaces: setSpaces }),
      errors.length
        ? jsx('div', {
            className: 'rounded border border-(--ui-stroke-secondary) px-2 py-1 text-[0.6875rem] text-(--ui-text-secondary)',
            children: errors.join(' · ')
          })
        : null,
      jsx(ScrollArea, {
        className: 'min-h-0 flex-1',
        children:
          view === 'list'
            ? jsx(ListPanel, {
                overview: Object.assign({}, overview, {
                  blockers: inSpace(overview.blockers || []),
                  running_top: inSpace(overview.running_top || []),
                  oldest_ready: inSpace(overview.oldest_ready || [])
                }),
                tasks: scopedTasks,
                counts
              })
            : jsx(DashboardPanel, { overview, trends, charts, days, trendDays: data.trendDays })
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Board insights',

  register(ctx) {
    ctxRef = ctx
    ctx.i18n.register({
      en: {
        loading: 'Reading the boards…',
        error: 'Could not read the boards',
        errorTip:
          'The board-insights backend could not read a kanban.db. Check the plugin is enabled (hermes plugins list) and that the boards folder is readable.',
        refresh: 'Refresh'
      }
    })

    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/insights' },
      render: () => jsx(InsightsPage, {})
    })

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { codicon: 'graph', label: 'Board insights', path: '/insights' }
    })
  }
}
