import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useTheme } from "@/hooks/useTheme";
import {
  MAX_KITCHEN_BASICS,
  MAX_KITCHEN_BASIC_NAME_LENGTH,
  useAddKitchenBasic,
  useKitchenBasics,
  useRemoveKitchenBasic,
} from "@/hooks/useKitchenBasics";

/**
 * Lists the household's kitchen basics as removable pills, with a field to add
 * one. Reads and writes through the `useKitchenBasics` hooks.
 */
export default function KitchenBasicsEditor() {
  const { colors, fonts } = useTheme();
  const basics = useKitchenBasics();
  const add = useAddKitchenBasic();
  const remove = useRemoveKitchenBasic();
  const [draft, setDraft] = useState("");

  const list = basics.data ?? [];
  const full = list.length >= MAX_KITCHEN_BASICS;

  const submit = () => {
    const name = draft.trim();
    if (!name || add.isPending) return;
    add.mutate(name, { onSuccess: () => setDraft("") });
  };

  const note = (text: string) => (
    <Text
      style={{
        marginTop: 10,
        fontFamily: fonts.body,
        fontSize: 11.5,
        color: colors.textSubtle,
      }}
    >
      {text}
    </Text>
  );

  if (basics.isError) return note("Couldn't load your basics.");

  return (
    <View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {list.map((basic) => (
          <View
            key={basic.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              paddingLeft: 12,
              paddingRight: 6,
              paddingVertical: 6,
              borderRadius: 100,
              backgroundColor: colors.accentSoft,
            }}
          >
            <Text
              style={{
                fontFamily: fonts.bodyStrong,
                fontSize: 12,
                color: colors.accent,
                letterSpacing: -0.1,
              }}
            >
              {basic.name}
            </Text>
            <Pressable
              onPress={() => remove.mutate(basic)}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${basic.name}`}
              hitSlop={8}
              style={{ padding: 2 }}
            >
              <Feather name="x" size={12} color={colors.accent} />
            </Pressable>
          </View>
        ))}
      </View>
      {full ? (
        note("Remove one to add another.")
      ) : (
        <View
          style={{
            marginTop: 12,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
          }}
        >
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            placeholder="Add a basic, like butter"
            placeholderTextColor={colors.textSubtle}
            accessibilityLabel="New kitchen basic"
            maxLength={MAX_KITCHEN_BASIC_NAME_LENGTH}
            returnKeyType="done"
            autoCapitalize="sentences"
            style={{
              flex: 1,
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 100,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surfaceAlt,
              fontFamily: fonts.body,
              fontSize: 13,
              color: colors.text,
            }}
          />
          <Pressable
            onPress={submit}
            disabled={!draft.trim() || add.isPending}
            accessibilityRole="button"
            accessibilityLabel="Add kitchen basic"
            style={({ pressed }) => ({
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 100,
              backgroundColor: colors.accent,
              opacity: !draft.trim() ? 0.4 : pressed ? 0.7 : 1,
            })}
          >
            <Text
              style={{
                fontFamily: fonts.bodyStrong,
                fontSize: 12.5,
                color: colors.accentInk,
              }}
            >
              Add
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
