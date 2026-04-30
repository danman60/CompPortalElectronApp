/**
 * 18-sequential-recordings — N takes in sequence on N different routines.
 * Models the operator's normal flow: RECORD → STOP → NEXT → RECORD → STOP → ...
 */
export const name = 'Sequential recordings — N routines'
export const description = 'Inject 5 takes on 5 different routines, all distinct'

export async function run(api) {
  const routines = (await api.routines()).body
  if (routines.length < 5) return { ok: false, why: 'need 5+ routines' }
  const targets = routines.slice(0, 5)
  const takeIds = []
  const baseMs = new Date('2026-04-30T01:00:00.000Z').getTime()

  for (let i = 0; i < 5; i++) {
    const startedAt = new Date(baseMs + i * 5 * 60_000).toISOString()
    const stoppedAt = new Date(baseMs + i * 5 * 60_000 + 90_000).toISOString()
    const inj = await api.injectTake({
      startedAt, stoppedAt,
      mkvPath: `C:\\test\\seq-${i}.mkv`,
      currentRoutineId: targets[i].id,
    })
    if (inj.status !== 200) return { ok: false, why: `inject ${i} failed` }
    takeIds.push(inj.body.take.takeId)
  }

  // All 5 takes should be in snapshot, each pointing at its own routine
  const snap = (await api.snapshot()).body
  for (let i = 0; i < 5; i++) {
    const t = snap.takes.find((x) => x.takeId === takeIds[i])
    api.assert(t, `take ${i} present`)
    api.assertEq(t.currentRoutineId, targets[i].id, `take ${i} → routine ${targets[i].entryNumber}`)
  }
  return { ok: true }
}
