/**
 * The one panel shape. Not an RN Modal: it renders inside the shell
 * (PanelHost places it over the whole app), so the drawer and the panel never fight for focus.
 * Phone: a sheet from the bottom, up to 92% high. From 768 up: a centred card, 600 wide (`wide`
 * 860). Escape and the scrim close it; `onBack` shows a back arrow (a panel opened from another).
 * Escape is caught on window in the capture phase: react-native-web's TextInput stops keydown from
 * bubbling, so a bubble-phase listener would miss Escape typed in the panel's own text fields.
 * Inside <PanelDock> (the desktop accounts page, design §3.6) the same panel is a column docked
 * beside the page instead: no scrim, not modal, the page stays usable. While a card opened from
 * it sits on top (`covered`: 移到…, 编辑, 打开桌面) the docked panel leaves Escape to that card,
 * which closes the card only. Shared skeleton file.
 */
import { ArrowLeft, X } from "lucide-react-native";
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLayoutMode } from "../layout";
import { t } from "../strings";
import { color, radius } from "../theme";

export interface PanelProps {
  title: string;
  onClose: () => void;
  onBack?: () => void;
  /** Extra header actions (⋯ menus) left of the close button. */
  headerRight?: ReactNode;
  wide?: boolean;
  /** Phone: take the full sheet height (92%) even when the content is short (task and account
   * details, design §3.4 「手机全高面板」), instead of a sheet that grows with its content. */
  full?: boolean;
  /** Content that should not scroll with the body (a composer, sticky actions). */
  footer?: ReactNode;
  children: ReactNode;
}

const DockContext = createContext<{ docked: boolean; covered: boolean }>({
  docked: false,
  covered: false,
});

/** Panels rendered inside are docked columns (the desktop accounts page's account detail);
 * `covered`: a card sits over the dock, so Escape is that card's. */
export function PanelDock({ covered, children }: { covered: boolean; children: ReactNode }) {
  const value = useMemo(() => ({ docked: true, covered }), [covered]);
  return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}

export function Panel({
  title,
  onClose,
  onBack,
  headerRight,
  wide,
  full,
  footer,
  children,
}: PanelProps) {
  const layout = useLayoutMode();
  const insets = useSafeAreaInsets();
  const { docked, covered } = useContext(DockContext);
  const sheet = layout.panel === "sheet";
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || covered) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, covered]);
  const head = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: 52,
        paddingVertical: 8,
        paddingLeft: onBack ? 8 : 16,
        paddingRight: 8,
        borderBottomWidth: 1,
        borderBottomColor: color.line,
      }}
    >
      {onBack && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.common.back}
          onPress={onBack}
          style={{ width: 38, height: 38, alignItems: "center", justifyContent: "center" }}
        >
          <ArrowLeft size={18} color={color.fg} />
        </Pressable>
      )}
      <Text
        numberOfLines={1}
        accessibilityRole="header"
        style={{ flex: 1, fontSize: 16, fontWeight: "700", color: color.fg }}
      >
        {title}
      </Text>
      {headerRight}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.common.close}
        onPress={onClose}
        style={{ width: 38, height: 38, alignItems: "center", justifyContent: "center" }}
      >
        <X size={18} color={color.fg} />
      </Pressable>
    </View>
  );
  const body = (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 20,
        gap: 12,
      }}
    >
      {children}
    </ScrollView>
  );
  if (docked)
    return (
      <View
        accessibilityLabel={title}
        style={{ flex: 1, minHeight: 0, backgroundColor: color.surface }}
      >
        {head}
        {body}
        {footer}
      </View>
    );
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
        justifyContent: sheet ? "flex-end" : "center",
        alignItems: "center",
        padding: sheet ? 0 : 24,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.common.close}
        onPress={onClose}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: color.scrim,
        }}
      />
      <View
        accessibilityViewIsModal
        accessibilityLabel={title}
        style={{
          width: "100%",
          maxWidth: sheet ? undefined : wide ? 860 : layout.panelMaxWidth,
          maxHeight: sheet ? "92%" : "88%",
          height: sheet && full ? "92%" : undefined,
          backgroundColor: color.surface,
          borderTopLeftRadius: sheet ? radius.sheet : 14,
          borderTopRightRadius: sheet ? radius.sheet : 14,
          borderBottomLeftRadius: sheet ? 0 : 14,
          borderBottomRightRadius: sheet ? 0 : 14,
          overflow: "hidden",
          paddingBottom: sheet ? Math.max(insets.bottom, 0) : 0,
          shadowColor: color.shadow,
          shadowOpacity: 0.16,
          shadowRadius: 32,
          shadowOffset: { width: 0, height: 12 },
          elevation: 8,
        }}
      >
        {head}
        {body}
        {footer}
      </View>
    </View>
  );
}
