/**
 * Whether the server offers environments (one probe per client),
 * without React Native; the Environments page stays in environments-screen.tsx.
 */
import { useEffect, useState } from "react";
import type { MuseApi } from "./api";
import { environmentsUnavailable } from "./environments";
import { useWorkspace } from "./workspace";

// One probe per session, shared by every menu entry: GET /api/environments answers the
// feature-off 503 when the server's computer provider has no environments, and then the feature
// stays hidden. Only a definitive answer is kept; any other failure (network, a proxy 503 while
// the API restarts) is forgotten so the next mount asks again.
const probes = new WeakMap<MuseApi, Promise<boolean | undefined>>();
function probe(api: MuseApi) {
  let pending = probes.get(api);
  if (!pending) {
    pending = api.request<unknown>("/api/environments").then(
      () => true,
      (error) => {
        if (environmentsUnavailable(error)) return false;
        probes.delete(api);
        return undefined;
      },
    );
    probes.set(api, pending);
  }
  return pending;
}
/** Whether the server offers environments; undefined until the probe answers, or when it could not. */
export function useEnvironmentsAvailable(): boolean | undefined {
  const { api } = useWorkspace();
  const [available, setAvailable] = useState<boolean>();
  useEffect(() => {
    let alive = true;
    void probe(api).then((value) => {
      if (alive) setAvailable(value);
    });
    return () => {
      alive = false;
    };
  }, [api]);
  return available;
}
