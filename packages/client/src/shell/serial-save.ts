/** A setting that is saved on every edit (动作审查 on the settings sheet). The edits show at once, so a
 * second one can start before the first one's answer is back: saves therefore go out one at a time, in the
 * order they were made, and only the newest save's answer (or failure) reaches the screen. An older
 * answer used to overwrite the newer edit on screen, and the next edit then built on the old list and
 * dropped a sentence. */
export function createLatestSaver<T>(options: {
  put: (value: T) => Promise<T>;
  onSaved: (value: T) => void;
  onError: (error: unknown) => void;
}): (value: T) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  let newest = 0;
  return (value) => {
    const mine = ++newest;
    tail = tail.then(async () => {
      try {
        const saved = await options.put(value);
        if (mine === newest) options.onSaved(saved);
      } catch (error) {
        if (mine === newest) options.onError(error);
      }
    });
    return tail;
  };
}
