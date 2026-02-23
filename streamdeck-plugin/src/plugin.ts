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
} from './actions/overlay-toggle'

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

conn.connect()
streamDeck.connect()
