import { createSignal } from "solid-js";

const [now, setNow] = createSignal(Date.now());

let started = false;

export function useNow(): typeof now {
  if (!started) {
    started = true;
    window.setInterval(() => setNow(Date.now()), 1000);
  }
  return now;
}
