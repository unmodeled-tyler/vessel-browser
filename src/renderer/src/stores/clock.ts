import { createSignal } from "solid-js";

const [now, setNow] = createSignal(Date.now());

let started = false;

export function useNow(): typeof now {
  if (!started) {
    started = true;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener("unload", () => clearInterval(id));
  }
  return now;
}
