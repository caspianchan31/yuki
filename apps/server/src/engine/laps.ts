// v1.7.2 对话快: what a reply waits for before the model is asked, step by step, in one log line.
export function laps(now: () => number = () => performance.now()) {
  const start = now();
  let last = start;
  const parts: string[] = [];
  return {
    lap(name: string) {
      const at = now();
      parts.push(`${name} ${Math.round(at - last)}`);
      last = at;
    },
    line: () => `${parts.join(", ")}; ${Math.round(now() - start)} ms in all`,
  };
}
