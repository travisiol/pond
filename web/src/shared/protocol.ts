/**
 * What crosses the socket. Control messages are JSON; the 20 Hz world
 * snapshot is a compact binary frame (see `encodeState` / `decodeState`)
 * because JSON at that rate is most of the bandwidth and none of the game.
 */
import type { RULES } from "./rules";
import type { DeathCause, Timing } from "./sim";

// ─────────────────────────── client → server ───────────────────────────

export type ClientMessage =
  | { t: "hello"; session?: string }
  | { t: "spawn"; name?: string }
  /** a = heading in radians, b = sprint, c = cash-out held. */
  | { t: "input"; a: number; b: 0 | 1; c: 0 | 1 }
  | { t: "ping"; n: number };

// ─────────────────────────── server → client ───────────────────────────

export interface YouState {
  address: string;
  name: string | null;
  /** Whole coins sitting in the lobby: deposited or cashed out, not in the ocean. */
  lobbyCoins: number;
  /** Same balance in wei, as a decimal string. */
  lobbyWei: string;
  /** Cumulative entitlement the server will sign vouchers up to. */
  claimableWei: string;
  /** Cumulative amount the chain has already paid this address. */
  claimedWei: string;
}

export interface RosterEntry {
  id: number;
  name: string;
  skin: number;
  bot: boolean;
}

export interface BoardRow {
  id: number;
  name: string;
  coins: number;
  kills: number;
}

export interface Economy {
  /** Price of one life, in coins. */
  entryCoins: number;
  /** Basis points of the entry taken as a fee. */
  feeBps: number;
  /** Basis points of that fee that go to the pot. */
  feePotShareBps: number;
}

export type ServerMessage =
  | {
      t: "welcome";
      rules: typeof RULES;
      /** The waiting clocks actually in force (a local server may shorten them). */
      timing: Timing;
      economy: Economy;
      /** True when deposits are watched on chain and vouchers can be signed. */
      live: boolean;
      /** Why `live` is false, in words a player can act on. */
      liveNote: string | null;
      /** True when the money is play money (practice ocean or dev faucet). */
      practice: boolean;
      arena: string | null;
      chainId: number;
      devFaucet: boolean;
      you: YouState | null;
      fishId: number | null;
    }
  | { t: "you"; you: YouState }
  | { t: "roster"; full?: boolean; add?: RosterEntry[]; remove?: number[] }
  | { t: "spawned"; id: number; stake: number; fee: number }
  | {
      t: "death";
      id: number;
      name: string;
      killerId: number | null;
      killerName: string | null;
      cause: DeathCause;
      coins: number;
      gained: number;
      x: number;
      y: number;
      mine: boolean;
    }
  | { t: "extracted"; id: number; name: string; coins: number; x: number; y: number; mine: boolean }
  | { t: "board"; top: BoardRow[]; alive: number; players: number; floor: number; pot: number }
  | { t: "error"; message: string }
  | { t: "pong"; n: number; serverTime: number };

// ───────────────────────────── binary state ─────────────────────────────

export const STATE_FRAME = 0x02;

export const FLAG_BOOST = 1;
export const FLAG_SHIELD = 2;
export const FLAG_CASHING = 4;
export const FLAG_BOT = 8;
export const FLAG_CAN_CASH = 16;
export const FLAG_ORPHAN = 32;

export interface FishWire {
  id: number;
  x: number;
  y: number;
  angle: number;
  coins: number;
  flags: number;
  /** Cash-out progress, 0..1. */
  cash: number;
}

export interface PelletWire {
  id: number;
  x: number;
  y: number;
  value: number;
}

export interface StateWire {
  tick: number;
  time: number;
  camX: number;
  camY: number;
  myId: number;
  fish: FishWire[];
  pellets: PelletWire[];
}

const ANGLE_SCALE = 10000;
const HEADER = 1 + 4 + 4 + 2 + 2 + 2 + 2;
const FISH_BYTES = 2 + 4 + 4 + 2 + 4 + 1 + 1;
const PELLET_BYTES = 4 + 2 + 2 + 4;

export function encodeState(s: StateWire): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER + s.fish.length * FISH_BYTES + 2 + s.pellets.length * PELLET_BYTES);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o, STATE_FRAME);
  o += 1;
  v.setUint32(o, s.tick >>> 0);
  o += 4;
  v.setFloat32(o, s.time);
  o += 4;
  v.setInt16(o, clampI16(s.camX));
  o += 2;
  v.setInt16(o, clampI16(s.camY));
  o += 2;
  v.setUint16(o, s.myId & 0xffff);
  o += 2;
  v.setUint16(o, s.fish.length);
  o += 2;
  for (const f of s.fish) {
    v.setUint16(o, f.id & 0xffff);
    o += 2;
    v.setFloat32(o, f.x);
    o += 4;
    v.setFloat32(o, f.y);
    o += 4;
    v.setInt16(o, Math.round(f.angle * ANGLE_SCALE));
    o += 2;
    v.setUint32(o, Math.min(0xffffffff, Math.max(0, f.coins)) >>> 0);
    o += 4;
    v.setUint8(o, f.flags & 0xff);
    o += 1;
    v.setUint8(o, Math.round(Math.min(1, Math.max(0, f.cash)) * 255));
    o += 1;
  }
  v.setUint16(o, s.pellets.length);
  o += 2;
  for (const p of s.pellets) {
    v.setUint32(o, p.id >>> 0);
    o += 4;
    v.setInt16(o, clampI16(p.x));
    o += 2;
    v.setInt16(o, clampI16(p.y));
    o += 2;
    v.setUint32(o, Math.min(0xffffffff, Math.max(0, p.value)) >>> 0);
    o += 4;
  }
  return buf;
}

export function decodeState(buf: ArrayBuffer): StateWire | null {
  const v = new DataView(buf);
  if (v.byteLength < HEADER || v.getUint8(0) !== STATE_FRAME) return null;
  let o = 1;
  const tick = v.getUint32(o);
  o += 4;
  const time = v.getFloat32(o);
  o += 4;
  const camX = v.getInt16(o);
  o += 2;
  const camY = v.getInt16(o);
  o += 2;
  const myId = v.getUint16(o);
  o += 2;
  const fishCount = v.getUint16(o);
  o += 2;
  const fish: FishWire[] = new Array(fishCount);
  for (let i = 0; i < fishCount; i++) {
    const id = v.getUint16(o);
    o += 2;
    const x = v.getFloat32(o);
    o += 4;
    const y = v.getFloat32(o);
    o += 4;
    const angle = v.getInt16(o) / ANGLE_SCALE;
    o += 2;
    const coins = v.getUint32(o);
    o += 4;
    const flags = v.getUint8(o);
    o += 1;
    const cash = v.getUint8(o) / 255;
    o += 1;
    fish[i] = { id, x, y, angle, coins, flags, cash };
  }
  const pelletCount = v.getUint16(o);
  o += 2;
  const pellets: PelletWire[] = new Array(pelletCount);
  for (let i = 0; i < pelletCount; i++) {
    const id = v.getUint32(o);
    o += 4;
    const x = v.getInt16(o);
    o += 2;
    const y = v.getInt16(o);
    o += 2;
    const value = v.getUint32(o);
    o += 4;
    pellets[i] = { id, x, y, value };
  }
  return { tick, time, camX, camY, myId, fish, pellets };
}

function clampI16(n: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(n)));
}
