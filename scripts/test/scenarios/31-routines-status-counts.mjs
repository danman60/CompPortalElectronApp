/**
 * 31-routines-status-counts — verify /debug/state.routineStatusCounts
 * matches the actual routines list. Catches counter drift.
 */
export const name = 'routineStatusCounts matches actual routine statuses'
export const description = 'Aggregate counts in /debug/state are accurate'

export async function run(api) {
  const state = (await api.state()).body
  const routines = (await api.routines()).body
  const expected = {}
  for (const r of routines) {
    expected[r.status] = (expected[r.status] || 0) + 1
  }
  const actual = state.routineStatusCounts
  for (const status of Object.keys(expected)) {
    api.assertEq(actual[status], expected[status], `count for status=${status}`)
  }
  // Total should match
  const totalExpected = Object.values(expected).reduce((a, b) => a + b, 0)
  const totalActual = Object.values(actual).reduce((a, b) => a + b, 0)
  api.assertEq(totalActual, totalExpected, 'total status count')
  return { ok: true }
}
