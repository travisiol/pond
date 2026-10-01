(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40 && !document.querySelector(".card button"); i++) await wait(250);
  [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("Dive in")).click();
  await wait(1500);
  const c = document.querySelector(".stage > canvas");
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + r.width * 0.66, clientY: r.top + r.height * 0.52, bubbles: true }));
  await wait(2500);
  return "aimed";
})()
