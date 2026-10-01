/**
 * One viewer's snapshot of the world: the fish and orbs inside a box around
 * the camera. The server builds one per socket per tick; the browser's
 * practice ocean builds one for itself.
 */
import { wrapAngle } from "./geometry";
import { lengthFor } from "./rules";
import type { World } from "./sim";
import {
  FLAG_BOOST,
  FLAG_BOT,
  FLAG_CAN_CASH,
  FLAG_CASHING,
  FLAG_ORPHAN,
  FLAG_SHIELD,
  type FishWire,
  type StateWire,
} from "./protocol";

export const VIEW_HALF_W = 1900;
export const VIEW_HALF_H = 1900;

export interface Viewer {
  camX: number;
  camY: number;
  /** The fish this viewer drives, if alive. */
  myId: number;
}

export function buildState(world: World, v: Viewer): StateWire {
  const x0 = v.camX - VIEW_HALF_W;
  const x1 = v.camX + VIEW_HALF_W;
  const y0 = v.camY - VIEW_HALF_H;
  const y1 = v.camY + VIEW_HALF_H;

  const fish: FishWire[] = [];
  for (const f of world.fish.values()) {
    if (!f.alive) continue;
    const pad = lengthFor(f.coins, world.entry) + 40;
    if (f.x < x0 - pad || f.x > x1 + pad || f.y < y0 - pad || f.y > y1 + pad) continue;
    let flags = 0;
    if (f.boosting) flags |= FLAG_BOOST;
    if (world.time < f.shieldUntil) flags |= FLAG_SHIELD;
    if (f.cashing) flags |= FLAG_CASHING;
    if (f.bot) flags |= FLAG_BOT;
    if (world.canCash(f)) flags |= FLAG_CAN_CASH;
    if (f.orphanedAt !== null) flags |= FLAG_ORPHAN;
    fish.push({
      id: f.id,
      x: f.x,
      y: f.y,
      angle: wrapAngle(f.angle),
      coins: f.coins,
      flags,
      cash: f.cash / world.timing.cashSeconds,
    });
  }

  const me = v.myId ? world.fish.get(v.myId) : undefined;
  const pellets = world.pelletsInRect(x0, y0, x1, y1).map((p) => ({ id: p.id, x: p.x, y: p.y, value: p.value }));
  return {
    tick: world.tick,
    time: world.time,
    camX: v.camX,
    camY: v.camY,
    myId: me && me.alive ? me.id : 0,
    fish,
    pellets,
  };
}
