"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { GameClient } from "@/game/net";
import { OceanScene } from "@/game/scene";
import { canEat } from "@/shared/rules";
import { sound } from "@/lib/sound";
import { Hud } from "./Hud";
import { Lobby } from "./Lobby";

/** Test pilot for `?auto`: eats what it can, runs from what it must. */
function autopilot(client: GameClient): { angle: number; boost: boolean } | null {
  const me = client.fish.get(client.myId);
  if (!me) return null;
  let best = 0;
  let angle: number | null = null;
  let lunge = false;
  for (const f of client.fish.values()) {
    if (f.id === me.id) continue;
    const d = Math.hypot(f.x - me.x, f.y - me.y);
    if (canEat(f.coins, me.coins) && d < 380) return { angle: Math.atan2(me.y - f.y, me.x - f.x), boost: d < 170 };
    if (canEat(me.coins, f.coins) && f.coins / (90 + d) > best) {
      best = f.coins / (90 + d);
      angle = Math.atan2(f.y - me.y, f.x - me.x);
      // Smaller sharks are faster: a meal has to be run down.
      lunge = d < 320;
    }
  }
  for (const p of client.pellets.values()) {
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (p.value / (60 + d) > best) {
      best = p.value / (60 + d);
      angle = Math.atan2(p.y - me.y, p.x - me.x);
      lunge = false;
    }
  }
  return angle === null ? null : { angle, boost: lunge };
}

export function Game() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [client] = useState(() => new GameClient());
  const held = useRef({ boost: false, cash: false, keys: new Set<string>(), px: 0, py: 0, moved: false });
  useSyncExternalStore(client.subscribe, client.getVersion, client.getVersion);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const query = window.location.search;
    const auto = query.includes("auto");
    // `?pilot` steers like `?auto` but leaves entering (and the server) to you.
    const pilot = auto || query.includes("pilot");
    // Test handle: the scripted runs in scripts/ read the client through it.
    if (process.env.NODE_ENV !== "production" || pilot) (window as unknown as { __game: GameClient }).__game = client;
    client.start(query.includes("practice") || auto);

    let scene: OceanScene;
    try {
      scene = new OceanScene(canvas, overlay);
    } catch {
      overlay.textContent = "This browser could not start WebGL, which the game needs.";
      return;
    }

    const h = held.current;
    const key = (e: KeyboardEvent, down: boolean) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const k = e.key.toLowerCase();
      if (k === " " || k.startsWith("arrow")) e.preventDefault();
      if (down) h.keys.add(k);
      else h.keys.delete(k);
    };
    const kd = (e: KeyboardEvent) => key(e, true);
    const ku = (e: KeyboardEvent) => key(e, false);
    const move = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      h.px = e.clientX - r.left;
      h.py = e.clientY - r.top;
      h.moved = true;
    };
    const down = (e: PointerEvent) => {
      move(e);
      // On a touch screen a finger steers; sprint has its own button.
      if (e.pointerType === "mouse") h.boost = true;
    };
    const up = () => {
      h.boost = false;
    };
    const blur = () => {
      h.keys.clear();
      h.boost = false;
      h.cash = false;
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);

    let raf = 0;
    let last = performance.now();
    let lastAngle = 0;
    let keySteer = false;
    let fresh = true;
    let lastPhase = client.phase;
    let lastMealId = 0;
    let autoSpawnAt = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      const now = t / 1000;
      const r = canvas.getBoundingClientRect();
      scene.resize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)));

      const me = client.fish.get(client.myId);
      if (client.phase !== "playing") fresh = true;
      if (client.phase === "playing" && me) {
        if (fresh) {
          fresh = false;
          keySteer = false;
          lastAngle = me.angle;
        }
        const k = h.keys;
        let dx = 0;
        if (k.has("arrowleft") || k.has("a")) dx -= 1;
        if (k.has("arrowright") || k.has("d")) dx += 1;
        if (dx) {
          // Keys turn at a steady, unhurried rate from wherever it is heading.
          if (!keySteer) lastAngle = me.angle;
          keySteer = true;
          h.moved = false;
          scene.clearAim();
          lastAngle += dx * 1.7 * dt;
        } else if (h.moved) {
          // The pointer is a destination: the shark swims to the spot under it.
          keySteer = false;
          lastAngle = scene.pointerAim(h.px, h.py, me.x, me.y) ?? lastAngle;
        }
        let boost = h.boost || k.has(" ") || k.has("shift");
        const cash = h.cash || k.has("c");
        if (pilot) {
          const p = autopilot(client);
          if (p) {
            lastAngle = p.angle;
            boost = p.boost;
          }
        }
        client.setInput(lastAngle, boost, cash);
      }
      if (auto && client.phase !== "playing" && client.phase !== "connecting" && now > autoSpawnAt) {
        autoSpawnAt = now + 2;
        client.acknowledge();
        client.spawn("Pilot");
      }
      if (client.lastMeal && client.lastMeal.id !== lastMealId) {
        lastMealId = client.lastMeal.id;
        sound.bump();
        sound.win();
      }
      if (client.phase !== lastPhase) {
        if (client.phase === "dead") sound.lose();
        if (client.phase === "cashed") sound.win();
        lastPhase = client.phase;
      }

      client.update(now, dt);
      scene.render(client, now, dt);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", blur);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      scene.dispose();
      client.close();
    };
  }, [client]);

  const playing = client.phase === "playing";
  return (
    <div className="stage">
      <canvas ref={canvasRef} className={playing ? "playing" : undefined} />
      <div ref={overlayRef} className="overlay" aria-hidden="true" />
      <Hud
        client={client}
        onBoost={(v) => (held.current.boost = v)}
        onCash={(v) => (held.current.cash = v)}
      />
      {!playing && <Lobby client={client} />}
    </div>
  );
}
