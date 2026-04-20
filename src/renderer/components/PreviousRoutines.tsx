import React from 'react'
import RoutineTable from './RoutineTable'

export default function PreviousRoutines(): React.ReactElement {
  return <RoutineTable windowMode="previous" count={5} />
}
