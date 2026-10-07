import type { ScreenPointDip } from './contracts'

export interface ScreenPointEvent {
  screenX: number
  screenY: number
}

export interface MovementEvent {
  movementX: number
  movementY: number
}

export function screenPoint(event: ScreenPointEvent): ScreenPointDip {
  return {
    x: event.screenX,
    y: event.screenY
  }
}

export function movementDelta(event: MovementEvent): ScreenPointDip {
  return {
    x: event.movementX,
    y: event.movementY
  }
}
