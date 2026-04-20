import React from 'react'
import RoutineTable from './RoutineTable'

export default function NextRoutines(): React.ReactElement {
  return <RoutineTable windowMode="next" count={5} />
}
