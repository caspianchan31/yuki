/** Background errors are visible without logging provider payloads or credential-bearing URLs. */
export function backgroundFailure(phase: string, error: unknown) {
  const rawCode =
    error instanceof Error && "code" in error
      ? (error as Error & { code?: unknown }).code
      : undefined;
  const code =
    typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : undefined;
  console.error({
    timestamp: new Date().toISOString(),
    context: { phase },
    error: error instanceof Error ? error.name : "Background operation failed",
    ...(code ? { code } : {}),
  });
}

/** Provider failures keep status and request ID for support, never bodies or credentials. */
export function providerFailure(phase: string, error: unknown) {
  const detail = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  console.error({
    timestamp: new Date().toISOString(),
    context: {
      phase,
      ...(typeof detail.status === "number" ? { status: detail.status } : {}),
      ...(typeof detail.requestId === "string" ? { requestId: detail.requestId } : {}),
    },
    error: error instanceof Error ? error.name : "Provider request failed",
  });
}

/** The desktop provider's error for
 * the log only, its name, code and message and the same of its cause. Addresses and keys are
 * taken out of the message and it is cut short. */
export function desktopFailure(phase: string, error: unknown) {
  const scrub = (text: string) =>
    text
      .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<address>")
      .replace(/\b(sk-)[A-Za-z0-9_-]+/g, "$1…")
      .replace(/\b(api[_-]?key|token|authorization|password)(["']?\s*[:=]\s*)\S+/gi, "$1$2…")
      .slice(0, 300);
  const describe = (value: unknown) => {
    if (!(value instanceof Error)) return { error: typeof value };
    const rawCode = (value as Error & { code?: unknown }).code;
    const code =
      typeof rawCode === "number" ||
      (typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode))
        ? String(rawCode)
        : undefined;
    return { error: value.name, message: scrub(value.message), ...(code ? { code } : {}) };
  };
  const cause = error instanceof Error ? error.cause : undefined;
  console.error({
    timestamp: new Date().toISOString(),
    context: { phase },
    ...describe(error),
    ...(cause !== undefined ? { cause: describe(cause) } : {}),
  });
}
