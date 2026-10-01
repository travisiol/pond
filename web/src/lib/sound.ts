"use client";

// Every sound is synthesised: no audio files to load or license.

import { createStore } from "./store";

const pref = createStore<{ on: boolean }>("pond.sound.v1", { on: false });

let ac: AudioContext | null = null;

function ctx(): AudioContext | null {
  if (!pref.get().on || typeof window === "undefined") return null;
  if (!ac) {
    try {
      ac = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ac.state === "suspended") void ac.resume();
  return ac;
}

function tone(freq: number, dur: number, type: OscillatorType, gain: number, slide = 0, delay = 0) {
  const a = ctx();
  if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

// A pentatonic scale keeps any run of pickups in tune.
const SCALE = [392, 440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5];

export const sound = {
  use: () => pref.use().on,
  toggle() {
    pref.set({ on: !pref.get().on });
    if (pref.get().on) sound.chime(2);
  },
  plop: () => tone(520, 0.16, "sine", 0.18, -360),
  chime: (step = 0) => tone(SCALE[((step % SCALE.length) + SCALE.length) % SCALE.length], 0.5, "triangle", 0.14),
  bump: () => tone(120, 0.2, "sine", 0.22, -60),
  bell: () => {
    tone(880, 0.9, "sine", 0.12);
    tone(1320, 0.7, "sine", 0.05);
  },
  tick: () => tone(1200, 0.04, "square", 0.04),
  win() {
    [2, 4, 5, 7].forEach((s, i) => tone(SCALE[s], 0.5, "triangle", 0.14, 0, i * 0.11));
  },
  lose() {
    tone(330, 0.35, "triangle", 0.13, -120);
    tone(220, 0.5, "triangle", 0.11, -90, 0.18);
  },
};
