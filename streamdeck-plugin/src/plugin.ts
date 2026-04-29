import streamDeck from '@elgato/streamdeck'
import * as conn from './connection'

import { NextFullAction } from './actions/next-full'
import { NextRoutineAction } from './actions/next-routine'
import { PrevAction } from './actions/prev'
import { SkipAction } from './actions/skip'
import { RecordAction } from './actions/record'
import { StreamAction } from './actions/stream'
import { SaveReplayAction } from './actions/save-replay'
import {
  OverlayLowerThirdAction,
  OverlayCounterAction,
  OverlayClockAction,
  OverlayLogoAction,
  OverlayStartingSoonAction,
} from './actions/overlay-toggle'
import { JudgeMeterAction } from './actions/judge-meter'
import { CycleTransitionAction } from './actions/cycle-transition'

streamDeck.actions.registerAction(new NextFullAction())
streamDeck.actions.registerAction(new NextRoutineAction())
streamDeck.actions.registerAction(new PrevAction())
streamDeck.actions.registerAction(new SkipAction())
streamDeck.actions.registerAction(new RecordAction())
streamDeck.actions.registerAction(new StreamAction())
streamDeck.actions.registerAction(new SaveReplayAction())
streamDeck.actions.registerAction(new OverlayLowerThirdAction())
streamDeck.actions.registerAction(new OverlayCounterAction())
streamDeck.actions.registerAction(new OverlayClockAction())
streamDeck.actions.registerAction(new OverlayLogoAction())
streamDeck.actions.registerAction(new OverlayStartingSoonAction())
streamDeck.actions.registerAction(new JudgeMeterAction())
streamDeck.actions.registerAction(new CycleTransitionAction())

conn.connect()
streamDeck.connect()
