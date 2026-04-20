import { test, expect } from '@playwright/test'
import type { PluginCompletePayload } from '../src/shared/types'

/**
 * Contract test for the CompPortal /plugin/complete endpoint (T-H13).
 *
 * Catches drift between the Electron uploader and the server handler. Posts
 * a canned payload matching `PluginCompletePayload` to the preview deployment,
 * asserts the handler ingests the parallel photo arrays (photos,
 * photo_thumbnails, photo_captured_at) and the legacy `capture_times` alias.
 *
 * Skips when CompPortal preview creds aren't available so CI doesn't require
 * live infrastructure. Run locally with:
 *   COMPPORTAL_PREVIEW_URL=https://preview.compsync.net \
 *   COMPPORTAL_PLUGIN_KEY=csm_xxx \
 *   COMPPORTAL_TEST_ENTRY_ID=<uuid of a disposable entry> \
 *   COMPPORTAL_TEST_COMPETITION_ID=<uuid> \
 *   npx playwright test tests/contract-plugin-complete.spec.ts
 */

const previewUrl = process.env.COMPPORTAL_PREVIEW_URL
const pluginKey = process.env.COMPPORTAL_PLUGIN_KEY
const entryId = process.env.COMPPORTAL_TEST_ENTRY_ID
const competitionId = process.env.COMPPORTAL_TEST_COMPETITION_ID

const creds = previewUrl && pluginKey && entryId && competitionId

test.describe('CompPortal /plugin/complete contract', () => {
  test.skip(!creds, 'Preview URL / plugin key / entry IDs not set in env — see file header for required vars.')

  test('accepts photos + photo_thumbnails + photo_captured_at arrays', async () => {
    const photos = ['photos/P2234501.JPG', 'photos/P2234502.JPG']
    const photo_thumbnails = ['photos/P2234501_thumb.webp', 'photos/P2234502_thumb.webp']
    const photo_captured_at = ['2026-04-19T18:00:00.000Z', '2026-04-19T18:00:01.000Z']

    const payload: PluginCompletePayload = {
      entryId: entryId!,
      competitionId: competitionId!,
      uploadRunId: `contract-${Date.now()}`,
      video_start_timestamp: '2026-04-19T17:59:30.000Z',
      video_end_timestamp: '2026-04-19T18:01:00.000Z',
      files: {
        photos,
        photo_thumbnails,
        photo_captured_at,
      },
    }

    const res = await fetch(`${previewUrl}/api/plugin/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pluginKey}`,
      },
      body: JSON.stringify(payload),
    })

    expect(res.status, await res.text()).toBe(200)
  })

  test('accepts legacy capture_times alias', async () => {
    const photos = ['photos/P2234601.JPG']
    const capture_times = ['2026-04-19T19:00:00.000Z']

    const payload: PluginCompletePayload = {
      entryId: entryId!,
      competitionId: competitionId!,
      uploadRunId: `contract-alias-${Date.now()}`,
      files: {
        photos,
        capture_times,
      },
    }

    const res = await fetch(`${previewUrl}/api/plugin/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pluginKey}`,
      },
      body: JSON.stringify(payload),
    })

    expect(res.status, await res.text()).toBe(200)
  })
})
