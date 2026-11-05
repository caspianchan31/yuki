/**
 * The small building blocks every shell surface uses, styled after the
 * prototype (.btn, .linkbtn, .sec-h, .kv, .field, .err). Shared skeleton file: complete, owned by
 * nobody; a unit that needs another primitive builds it in its own files.
 */
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { serverText } from "../strings";
import { color, font, radius, space } from "../theme";

export const ui = StyleSheet.create({
  text: { color: color.fg, fontSize: font.body, lineHeight: 21 },
  muted: { color: color.muted, fontSize: font.meta, lineHeight: 19 },
  faint: { color: color.faint, fontSize: font.small, lineHeight: 17 },
  small: { color: color.muted, fontSize: font.small, lineHeight: 17 },
  strong: { fontWeight: "700" },
  mono: { fontFamily: Platform.OS === "web" ? "ui-monospace, Menlo, monospace" : font.mono },
  row: { flexDirection: "row", alignItems: "center" },
  wrap: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  card: {
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surface,
    borderRadius: radius.card,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    gap: space.sm,
  },
  divider: { height: 1, backgroundColor: color.line },
});

export type BtnVariant = "default" | "primary" | "ghost" | "danger" | "dangerText";

/** The prototype's .btn: bordered, radius 8; `small` = .btn.sm. */
export function Btn({
  children,
  onPress,
  variant = "default",
  small,
  icon: Icon,
  disabled,
  busy,
  label,
  style,
}: {
  children: ReactNode;
  onPress: () => void;
  variant?: BtnVariant;
  small?: boolean;
  icon?: LucideIcon;
  disabled?: boolean;
  busy?: boolean;
  /** Accessible name when the children are not plain text. */
  label?: string;
  style?: ViewStyle;
}) {
  const fg =
    variant === "primary"
      ? color.surface
      : variant === "danger"
        ? color.onRed
        : variant === "dangerText"
          ? color.red
          : variant === "ghost"
            ? color.muted
            : color.fg;
  const bg =
    variant === "primary"
      ? color.fg
      : variant === "danger"
        ? color.red
        : variant === "ghost" || variant === "dangerText"
          ? "transparent"
          : color.surface;
  const border =
    variant === "primary"
      ? color.fg
      : variant === "danger"
        ? color.red
        : variant === "default"
          ? color.line2
          : "transparent";
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? (typeof children === "string" ? children : undefined)}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        ui.row,
        {
          gap: 6,
          justifyContent: "center",
          borderWidth: 1,
          borderColor: border,
          backgroundColor: pressed && variant === "default" ? color.surface2 : bg,
          borderRadius: radius.md,
          minHeight: small ? 28 : 34,
          paddingHorizontal: small ? 10 : 12,
          paddingVertical: small ? 3 : 6,
          opacity: off ? 0.5 : 1,
          alignSelf: "flex-start",
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : Icon ? (
        <Icon size={15} color={fg} />
      ) : null}
      <Text style={{ color: fg, fontSize: small ? 12.5 : 13, fontWeight: "600" }}>{children}</Text>
    </Pressable>
  );
}

/** The prototype's .linkbtn: bold text, underline on press. */
export function LinkBtn({
  children,
  onPress,
  label,
  style,
  textStyle,
}: {
  children: ReactNode;
  onPress: () => void;
  label?: string;
  style?: ViewStyle;
  textStyle?: TextStyle;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? (typeof children === "string" ? children : undefined)}
      onPress={onPress}
      hitSlop={6}
      style={style}
    >
      {({ pressed }) => (
        <Text
          style={[
            { color: color.fg, fontWeight: "600", fontSize: 13 },
            pressed && { textDecorationLine: "underline" },
            textStyle,
          ]}
        >
          {children}
        </Text>
      )}
    </Pressable>
  );
}

/** A rail / panel section heading (.sec-h): small bold muted caps with an optional action. */
export function SectionHeader({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <View style={[ui.row, { justifyContent: "space-between", gap: space.md }]}>
      <Text
        style={{
          fontSize: font.heading,
          fontWeight: "700",
          letterSpacing: 0.6,
          color: color.muted,
        }}
      >
        {title}
      </Text>
      {right}
    </View>
  );
}

/** A key / value line (.kv): faint key column, value, optional trailing action. */
export function KV({ k, children, right }: { k: string; children: ReactNode; right?: ReactNode }) {
  return (
    <View style={[ui.row, { gap: space.md, paddingVertical: 2, alignItems: "flex-start" }]}>
      <Text style={[ui.faint, { width: 40, paddingTop: 2 }]}>{k}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof children === "string" ? <Text style={ui.text}>{children}</Text> : children}
      </View>
      {right}
    </View>
  );
}

/** A red error line (.err); renders nothing for an empty message. */
export function ErrorLine({ error }: { error?: string | null }) {
  return error ? (
    <Text accessibilityRole="alert" style={{ color: color.red, fontSize: 12.5, lineHeight: 18 }}>
      {serverText(error)}
    </Text>
  ) : null;
}

/** A labelled input (.field). */
export function FieldInput({
  label,
  hint,
  error,
  style,
  ...props
}: TextInputProps & { label: string; hint?: string; error?: string }) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={{ fontWeight: "600", fontSize: 13, color: color.fg }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={color.faint}
        {...props}
        style={[
          {
            borderWidth: 1,
            borderColor: color.line2,
            borderRadius: radius.md,
            paddingHorizontal: 10,
            paddingVertical: 8,
            fontSize: 13.5,
            color: color.fg,
            backgroundColor: color.surface,
          },
          props.multiline && { minHeight: 84, textAlignVertical: "top" },
          style,
        ]}
      />
      {!!hint && <Text style={ui.small}>{hint}</Text>}
      <ErrorLine error={error} />
    </View>
  );
}

/** A thin bordered block inside a panel (.block): heading + content. */
export function Block({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: color.line, paddingTop: 10, gap: 6 }}>
      {title ? <SectionHeader title={title} /> : null}
      {children}
    </View>
  );
}
