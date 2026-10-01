(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const g = window.__game;
  for (let i = 0; i < 40 && g.phase !== "lobby"; i++) await wait(250);
  [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("Dive in")).click();
  await wait(1500);
  const c = document.querySelector(".stage > canvas");
  const r = c.getBoundingClientRect();
  const me = () => g.fish.get(g.myId);
  const move = (fx, fy) => c.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true }));
  // Radians turned during each of `n` consecutive seconds.
  const turned = async (n) => {
    const out = [];
    for (let s = 0; s < n; s++) {
      let total = 0;
      let prev = me()?.angle;
      for (let t = 0; t < 10; t++) {
        await wait(100);
        const m = me();
        if (!m) return "eaten";
        let d = m.angle - prev;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        total += d;
        prev = m.angle;
      }
      out.push(Number(total.toFixed(2)));
    }
    return out;
  };
  const out = { phase: g.phase };
  move(0.5, 0.35);
  out.pointAhead = await turned(2);
  move(0.8, 0.55);
  out.pointRight = await turned(4);
  move(0.2, 0.55);
  out.pointLeft = await turned(4);
  move(0.5, 0.35);
  out.backToAhead = await turned(3);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" }));
  out.keyD = await turned(2);
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "d" }));
  out.keyReleased = await turned(2);
  return out;
})()
