/**
 * Render harness for the `board-insights` plugin page.
 *
 * NOT part of the plugin. This is the harness the page was built and verified against: copy
 * it (and desktop/plugin.js as __bi_runtime.mjs) into `apps/desktop/src/contrib/` of a
 * Hermes checkout, run
 *
 *   npx vitest run --project ui src/contrib/__bi_shot.test.tsx
 *
 * then `python verify/shot.py list` and `python verify/shot.py dashboard` for the PNGs.
 *
 * Loads the REAL plugin.js copied in as __bi_runtime.mjs, registers it through the app's
 * own createPluginContext, renders /insights against recorded fixtures, and dumps the
 * resulting DOM for a headless-Chrome screenshot. Nothing here is a mock of the component
 * under test: only the HTTP layer and the gateway are stubbed.
 *
 *   npx vitest run --project ui src/contrib/__bi_shot.test.tsx
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { queryClient } from '@hermes/plugin-sdk'

import { $gateway } from '@/store/gateway'
import { nousTheme } from '@/themes/presets'

import { createPluginContext, type HermesPlugin } from './plugin'
import { registry } from './registry'

const PKG = 'C:/Users/enriq/projects/board-insights'
const FIX = PKG + '/verify/fixtures'
const OUT = PKG + '/verify/shots.json'

const fixture = (name: string) => JSON.parse(readFileSync(`${FIX}/${name}.json`, 'utf8'))

const api = vi.fn(async (request: { path: string }) => {
  const base = new URL(request.path, 'http://localhost').pathname

  if (base.startsWith('/api/logs')) return { ok: true }
  if (base.endsWith('/boards')) return fixture('boards')
  if (base.endsWith('/overview')) return fixture('overview_7')
  if (base.endsWith('/trends')) return fixture('trends_14')
  if (base.endsWith('/charts')) return fixture('charts_7')
  if (base.endsWith('/pending')) return fixture('pending')
  if (base.endsWith('/health')) return { ok: true }

  throw new Error('unexpected request path: ' + request.path)
})

const plugin = ((await import('./__bi_runtime.mjs')) as { default: HermesPlugin }).default

const page = () => {
  const row = registry
    .getArea('routes')
    .find(contribution => (contribution.data as { path?: string })?.path === '/insights')

  return row?.render as undefined | (() => unknown)
}

const dump = (view: string, container: HTMLElement) =>
  writeFileSync(
    OUT,
    JSON.stringify(
      Object.assign(JSON.parse(readFileSync(OUT, 'utf8') || '{}'), {
        [view]: container.innerHTML,
        themeCss: themeCss()
      }),
      null,
      0
    ),
    'utf8'
  )

/** The app paints its theme with JS: root.style vars + the `dark` class (themes/context.tsx).
 *  Reproduce the same vars and class here so a static screenshot is not a light-theme lie. */
const themeCss = () => {
  const colors = (nousTheme.darkColors ?? nousTheme.colors) as unknown as Record<string, string>
  const vars: Record<string, string | undefined> = {
    '--theme-foreground': colors.foreground,
    '--theme-primary': colors.primary,
    '--theme-secondary': colors.secondary,
    '--theme-accent-soft': colors.accent,
    '--theme-midground': colors.midground ?? colors.ring,
    '--theme-warm': colors.primary,
    '--theme-background-seed': colors.background,
    '--theme-sidebar-seed': colors.sidebarBackground ?? colors.background,
    '--theme-card-seed': colors.card,
    '--theme-elevated-seed': colors.popover,
    '--theme-bubble-seed': colors.userBubble ?? colors.popover,
    '--dt-primary-foreground': colors.primaryForeground,
    '--dt-secondary-foreground': colors.secondaryForeground,
    '--dt-accent-foreground': colors.accentForeground,
    '--dt-border': colors.border,
    '--dt-input': colors.input,
    '--dt-ring': colors.ring,
    '--dt-muted': colors.muted
  }

  return (
    'html.dark{' +
    Object.entries(vars)
      .filter(([, value]) => Boolean(value))
      .map(([name, value]) => `${name}:${value}`)
      .join(';') +
    ';color-scheme:dark}'
  )
}

beforeAll(async () => {
  writeFileSync(OUT, '{}', 'utf8')
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { api }
  await plugin.register(createPluginContext('board-insights'))
})

describe('board-insights render', () => {
  it('dumps the list view and the dashboard view', async () => {
    const Render = page()

    expect(typeof Render, 'no /insights route registered').toBe('function')

    const list = render(<QueryClientProvider client={queryClient}>{Render!() as never}</QueryClientProvider>)

    await waitFor(() => expect(screen.getAllByText('Board insights').length).toBeGreaterThan(0), { timeout: 20_000 })
    await waitFor(() => expect(screen.queryByText('Every unfinished card')).toBeTruthy(), { timeout: 20_000 })

    dump('list', list.container)

    fireEvent.click(screen.getAllByText('Dashboard')[0])
    await waitFor(() => expect(screen.getByText('Department standups')).toBeTruthy(), { timeout: 20_000 })

    dump('dashboard', list.container)

    cleanup()
    $gateway.set(null)
  }, 120_000)
})
