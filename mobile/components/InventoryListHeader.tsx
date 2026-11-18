import { memo, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useTheme } from "@/hooks/useTheme";

type InventoryListHeaderProps = {
  /** How many foods the household has. */
  itemCount: number;
  /** How many foods have an expired batch. */
  expiredCount: number;
  /** Opens Review expired, from the subtitle while anything has expired. */
  onReview: () => void;
  /** The search text the field starts with when it mounts. */
  initialQuery: string;
  /** Called with the search text as it changes. */
  onQueryChange: (text: string) => void;
};

/**
 * The top of the inventory list, above the pinned controls: the title, a
 * count of foods and expired foods that links to Review expired, and the
 * search bar.
 */
export const InventoryListHeader = memo(function InventoryListHeader({
  itemCount,
  expiredCount,
  onReview,
  initialQuery,
  onQueryChange,
}: InventoryListHeaderProps) {
  const { colors, fonts } = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 }}>
      <TopBar
        title="Inventory"
        subtitle={
          <>
            {`${itemCount} item${itemCount === 1 ? "" : "s"} · `}
            <Text style={expiredCount > 0 ? { color: colors.crit } : undefined}>
              {`${expiredCount} expired`}
            </Text>
          </>
        }
        onSubtitlePress={expiredCount > 0 ? onReview : undefined}
        subtitleLabel={`${expiredCount} expired. Review expired batches`}
        colors={colors}
        fonts={fonts}
        padded={false}
      />
      <SearchField initialValue={initialQuery} onChange={onQueryChange} />
    </View>
  );
});

/**
 * The search bar. It leaves its text uncontrolled because a `value` prop forces
 * the native text to match it, so a slow list render would write a stale value
 * back over fast typing. `initialValue` restores the search when the field
 * remounts, such as after an error screen.
 */
function SearchField({
  initialValue,
  onChange,
}: {
  initialValue: string;
  onChange: (text: string) => void;
}) {
  const { colors, fonts } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        marginTop: 12,
        height: 44,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: colors.surfaceAlt,
      }}
    >
      <FontAwesome name="search" size={14} color={colors.textMuted} />
      <TextInput
        defaultValue={initialValue}
        onChangeText={onChange}
        placeholder="Search your fridge"
        placeholderTextColor={colors.textSubtle}
        accessibilityLabel="Search your fridge"
        returnKeyType="search"
        clearButtonMode="while-editing"
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          flex: 1,
          height: "100%",
          fontFamily: fonts.body,
          fontSize: 14,
          color: colors.text,
        }}
      />
    </View>
  );
}

/** The line shown when no food matches the search and filters. */
export function NoMatches({
  onClear,
}: {
  /** Offers a Clear filters link that calls this. Without it, the line suggests adding food. */
  onClear?: () => void;
}) {
  const { colors, fonts } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "center",
        gap: 4,
        paddingVertical: 48,
      }}
    >
      <Text
        style={{
          fontFamily: fonts.body,
          fontSize: 13,
          color: colors.textMuted,
        }}
      >
        {onClear ? "No matches." : "No matches. Tap + to add one."}
      </Text>
      {onClear ? (
        <Pressable onPress={onClear} hitSlop={12} accessibilityRole="button">
          <Text
            style={{
              fontFamily: fonts.bodyStrong,
              fontSize: 13,
              color: colors.accent,
            }}
          >
            Clear filters
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The screen title with an optional subtitle, which becomes a link with a
 * chevron when `onSubtitlePress` is set.
 */
export function TopBar({
  title,
  subtitle,
  onSubtitlePress,
  subtitleLabel,
  colors,
  fonts,
  padded = true,
}: {
  /** The screen title. */
  title: string;
  /** Text under the title. */
  subtitle?: ReactNode;
  /** Makes the subtitle a link, with a chevron after it. */
  onSubtitlePress?: () => void;
  /** The subtitle link's screen-reader label. */
  subtitleLabel?: string;
  /** The theme colors. */
  colors: ReturnType<typeof useTheme>["colors"];
  /** The theme fonts. */
  fonts: ReturnType<typeof useTheme>["fonts"];
  /** Whether to add the screen's side and top padding. Defaults to true. */
  padded?: boolean;
}) {
  const subtitleText = subtitle ? (
    <Text
      style={{
        fontFamily: fonts.body,
        fontSize: 13,
        color: colors.textMuted,
      }}
    >
      {subtitle}
    </Text>
  ) : null;
  return (
    <View
      style={{
        paddingHorizontal: padded ? 16 : 0,
        paddingTop: padded ? 12 : 0,
      }}
    >
      <Text
        style={{
          fontFamily: fonts.display,
          fontSize: 26,
          letterSpacing: -0.5,
          color: colors.text,
        }}
      >
        {title}
      </Text>
      {subtitleText && onSubtitlePress ? (
        <Pressable
          onPress={onSubtitlePress}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          accessibilityRole="link"
          accessibilityLabel={subtitleLabel}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            alignSelf: "flex-start",
            gap: 5,
            marginTop: 2,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          {subtitleText}
          <FontAwesome name="angle-right" size={13} color={colors.crit} />
        </Pressable>
      ) : subtitleText ? (
        <View style={{ marginTop: 2 }}>{subtitleText}</View>
      ) : null}
    </View>
  );
}

