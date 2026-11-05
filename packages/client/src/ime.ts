// Fork: Enter that confirms an input-method composition (Chinese pinyin with English letters in
// between, Japanese, Korean…) must not send the message. Browsers flag such key events with
// isComposing, and Safari reports the confirming Enter with keyCode 229 after composition ends.
export function isComposingKey(nativeEvent: unknown): boolean {
  if (!nativeEvent || typeof nativeEvent !== "object") return false;
  const event = nativeEvent as { isComposing?: unknown; keyCode?: unknown };
  return event.isComposing === true || event.keyCode === 229;
}
