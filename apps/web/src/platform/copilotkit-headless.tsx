/**
 * Phase C (docs/web.md): what the shared code imports as "@copilotkit/react-native/headless"
 * (the Vite alias points here). The hooks are react-core's own headless entry; the provider is
 * the lightweight one the React Native package ships (no CopilotKit UI, CSS or Radix in the
 * bundle), the same core instance and contexts, ported line for line from
 * @copilotkit/react-native 1.70.1 (src/CopilotKitProvider.tsx, src/hooks/useRenderTool.ts).
 */
import { CopilotKitContext, LicenseContext } from "@copilotkit/react-core/v2/context";
import { CopilotKitCoreReact, useFrontendTool } from "@copilotkit/react-core/v2/headless";
import { createLicenseContextValue } from "@copilotkit/shared";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

export * from "@copilotkit/react-core/v2/headless";

type CoreConfig = ConstructorParameters<typeof CopilotKitCoreReact>[0];
type CoreError = Parameters<
  NonNullable<Parameters<CopilotKitCoreReact["subscribe"]>[0]["onError"]>
>[0];

export interface CopilotKitProviderProps {
  children?: ReactNode;
  runtimeUrl?: string;
  headers?: Record<string, string> | (() => Record<string, string>);
  credentials?: RequestCredentials;
  useSingleEndpoint?: boolean;
  properties?: Record<string, unknown>;
  onError?: (event: CoreError) => void;
  debug?: CoreConfig["debug"];
  defaultThrottleMs?: number;
}

const transport = (single?: boolean) =>
  single === true ? "single" : single === false ? "rest" : "auto";

export function CopilotKitProvider({
  children,
  runtimeUrl,
  headers: headersProp,
  credentials,
  useSingleEndpoint,
  properties,
  onError,
  debug,
  defaultThrottleMs,
}: CopilotKitProviderProps) {
  const resolvedHeaders = typeof headersProp === "function" ? headersProp() : headersProp;
  const stableHeaders = useMemo(() => resolvedHeaders ?? {}, [JSON.stringify(resolvedHeaders)]);
  const stableProperties = useMemo(() => properties ?? {}, [JSON.stringify(properties)]);
  const ref = useRef<CopilotKitCoreReact | null>(null);
  if (ref.current === null) {
    const instance = new CopilotKitCoreReact({
      runtimeUrl,
      runtimeTransport: transport(useSingleEndpoint),
      headers: stableHeaders,
      credentials,
      properties: stableProperties,
      debug,
    } as CoreConfig);
    if (defaultThrottleMs !== undefined) instance.setDefaultThrottleMs(defaultThrottleMs);
    ref.current = instance;
  }
  const copilotkit = ref.current;
  useEffect(() => {
    copilotkit.setRuntimeUrl(runtimeUrl);
    copilotkit.setRuntimeTransport(transport(useSingleEndpoint));
    copilotkit.setHeaders(stableHeaders);
    copilotkit.setCredentials(credentials);
    copilotkit.setProperties(stableProperties);
    copilotkit.setDebug(debug);
  }, [
    runtimeUrl,
    useSingleEndpoint,
    stableHeaders,
    credentials,
    stableProperties,
    debug,
    copilotkit,
  ]);
  useEffect(() => {
    copilotkit.setDefaultThrottleMs(defaultThrottleMs);
  }, [copilotkit, defaultThrottleMs]);
  const [executingToolCallIds, setExecuting] = useState<ReadonlySet<string>>(() => new Set());
  const [licenseStatus, setLicenseStatus] =
    useState<CopilotKitCoreReact["licenseStatus"]>(undefined);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onToolExecutionStart: ({ toolCallId }) =>
        setExecuting((prev) => (prev.has(toolCallId) ? prev : new Set(prev).add(toolCallId))),
      onToolExecutionEnd: ({ toolCallId }) =>
        setExecuting((prev) => {
          if (!prev.has(toolCallId)) return prev;
          const next = new Set(prev);
          next.delete(toolCallId);
          return next;
        }),
      onError: (event) => {
        if (onErrorRef.current) onErrorRef.current(event);
        else console.error(`[CopilotKit] Error (${event.code}):`, event.error, event.context ?? {});
      },
      onRuntimeConnectionStatusChanged: () => setLicenseStatus(copilotkit.licenseStatus),
    });
    return () => subscription.unsubscribe();
  }, [copilotkit]);
  const context = useMemo(
    () => ({ copilotkit, executingToolCallIds }),
    [copilotkit, executingToolCallIds],
  );
  const license = useMemo(() => createLicenseContextValue(licenseStatus), [licenseStatus]);
  return (
    <CopilotKitContext.Provider value={context as never}>
      <LicenseContext.Provider value={license}>{children}</LicenseContext.Provider>
    </CopilotKitContext.Provider>
  );
}

/** Registers a frontend tool and its renderer (as @copilotkit/react-native's useRenderTool). */
export function useRenderTool(options: Parameters<typeof useFrontendTool>[0], deps?: unknown[]) {
  const { name, description, parameters, render, handler, agentId } = options;
  useFrontendTool(
    { name, description, parameters, handler, agentId, render } as Parameters<
      typeof useFrontendTool
    >[0],
    deps,
  );
}
