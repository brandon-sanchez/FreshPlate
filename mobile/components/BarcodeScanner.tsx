import { useCallback, useEffect, useRef, useState } from "react";
import {
  InputAccessoryView,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import {
  BarcodeScanningResult,
  CameraView,
  useCameraPermissions,
} from "expo-camera";
import { useRouter } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { isValidBarcode } from "@/hooks/useBarcodeLookup";
import ScanViewfinder from "@/components/ScanViewfinder";

const SUPPORTED_BARCODES = ["ean13", "ean8", "upc_a", "upc_e"] as const;
const BARCODE_INPUT_ACCESSORY_ID = "barcode-edit-done";
const TILE_MAX_WIDTH = 360;
const TILE_ASPECT = 0.62; // height / width — gentle 8:5 box, comfortable barcode aim

function BarcodeScanner() {
  const { colors, fonts, card } = useTheme();
  const router = useRouter();
  const { width: screenWidth } = useWindowDimensions();
  const [permission, requestPermission] = useCameraPermissions();
  const [torchOn, setTorchOn] = useState(false);
  const [scannedCode, setScannedCode] = useState<string | null>(null);
  /* Prevents expo-camera from firing `onBarcodeScanned` repeatedly for the
   * same code while it remains in the viewfinder. */
  const handlingRef = useRef(false);

  useEffect(() => {
    return () => {
      handlingRef.current = false;
    };
  }, []);

  const handleBarcodeScanned = useCallback((result: BarcodeScanningResult) => {
    if (handlingRef.current) return;
    handlingRef.current = true;
    setScannedCode(result.data);
  }, []);

  const handleReArm = useCallback(() => {
    Keyboard.dismiss();
    handlingRef.current = false;
    setScannedCode(null);
  }, []);

  const handleContinue = useCallback(() => {
    if (!scannedCode) return;
    Keyboard.dismiss();
    router.push({
      pathname: "/scan-review",
      params: { barcode: scannedCode },
    });
  }, [router, scannedCode]);

  if (!permission) {
    return (
      <View
        style={{
          flex: 1,
          paddingHorizontal: 16,
          paddingVertical: 24,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: colors.textMuted, fontFamily: fonts.body }}>
          Checking camera permission…
        </Text>
      </View>
    );
  }

  if (!permission.granted) {
    const isDenied = permission.status === "denied" && !permission.canAskAgain;
    return (
      <View
        style={{ flex: 1, paddingHorizontal: 16, justifyContent: "center" }}
      >
        <View
          style={{
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 16,
            padding: 24,
            alignItems: "center",
            gap: 12,
            shadowColor: card.shadowColor,
            shadowOffset: card.shadowOffset,
            shadowOpacity: card.shadowOpacity,
            shadowRadius: card.shadowRadius,
            elevation: card.elevation,
          }}
        >
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: colors.accentSoft,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <FontAwesome name="camera" size={24} color={colors.accent} />
          </View>
          <Text
            style={{
              fontFamily: fonts.display,
              fontSize: 17,
              color: colors.text,
              textAlign: "center",
              letterSpacing: -0.3,
            }}
          >
            {isDenied ? "Camera access blocked" : "Scan barcodes with your camera"}
          </Text>
          <Text
            style={{
              fontFamily: fonts.body,
              fontSize: 13,
              color: colors.textMuted,
              textAlign: "center",
              lineHeight: 18,
              maxWidth: 280,
            }}
          >
            {isDenied
              ? "Enable camera access in Settings to scan product barcodes."
              : "We'll auto-fill the details from the product label."}
          </Text>
          <Pressable
            onPress={
              isDenied
                ? () => Linking.openSettings()
                : () => requestPermission()
            }
            style={{
              backgroundColor: colors.accent,
              paddingHorizontal: 20,
              paddingVertical: 12,
              borderRadius: 100,
              marginTop: 4,
            }}
          >
            <Text
              style={{
                color: colors.accentInk,
                fontFamily: fonts.bodyStrong,
                fontSize: 14,
                letterSpacing: -0.1,
              }}
            >
              {isDenied ? "Open Settings" : "Allow camera"}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const scanned = scannedCode !== null;
  const isCodeValid = isValidBarcode(scannedCode);
  const tileWidth = Math.min(screenWidth - 32, TILE_MAX_WIDTH);
  const tileHeight = Math.round(tileWidth * TILE_ASPECT);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 24,
        alignItems: "center",
      }}
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={() => Keyboard.dismiss()}
    >
      {/* Camera tile — sized to the viewfinder, not the whole screen */}
      <View
        style={{
          width: tileWidth,
          height: tileHeight,
          position: "relative",
        }}
      >
        {/* Camera feed clipped to the rounded tile */}
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius: 18,
            overflow: "hidden",
            backgroundColor: "#0A0A0A",
          }}
        >
          {!scanned ? (
            <CameraView
              style={{ flex: 1 }}
              enableTorch={torchOn}
              barcodeScannerSettings={{ barcodeTypes: [...SUPPORTED_BARCODES] }}
              onBarcodeScanned={handleBarcodeScanned}
            />
          ) : (
            <View
              style={{
                flex: 1,
                backgroundColor: "#0A0A0A",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <FontAwesome
                name="check-circle"
                size={36}
                color={colors.accent}
              />
            </View>
          )}
        </View>

        {/* Corner brackets + scan line overlay — corners protrude by 3px outside the tile */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ScanViewfinder
            width={tileWidth}
            height={tileHeight}
            scanning={!scanned}
          />
        </View>

        {/* Status pill + flash overlay */}
        <View
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            right: 10,
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <View
            style={{
              backgroundColor: "rgba(0,0,0,0.55)",
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 100,
            }}
          >
            <Text
              style={{
                color: "#FFFFFF",
                fontFamily: fonts.bodyStrong,
                fontSize: 11.5,
                letterSpacing: -0.1,
              }}
            >
              {scanned ? "Found" : "Aligning barcode…"}
            </Text>
          </View>
          {!scanned ? (
            <Pressable
              onPress={() => setTorchOn((t) => !t)}
              hitSlop={8}
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: torchOn
                  ? "rgba(255,255,255,0.85)"
                  : "rgba(255,255,255,0.18)",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <FontAwesome
                name="flash"
                size={14}
                color={torchOn ? "#0A0A0A" : "#FFFFFF"}
              />
            </Pressable>
          ) : null}
        </View>
      </View>

      {!scanned ? (
        <Text
          style={{
            marginTop: 20,
            textAlign: "center",
            color: colors.textMuted,
            fontFamily: fonts.body,
            fontSize: 13,
          }}
        >
          Hold steady. We'll auto-fill the details.
        </Text>
      ) : (
        <View style={{ width: "100%", marginTop: 16 }}>
          <View
            style={{
              backgroundColor: colors.surface,
              borderRadius: 16,
              padding: 16,
              shadowColor: card.shadowColor,
              shadowOffset: card.shadowOffset,
              shadowOpacity: card.shadowOpacity,
              shadowRadius: card.shadowRadius,
              elevation: card.elevation,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text
              style={{
                fontFamily: fonts.bodyStrong,
                fontSize: 11,
                color: colors.textMuted,
                textTransform: "uppercase",
                letterSpacing: 0.7,
                marginBottom: 6,
              }}
            >
              Scanned barcode
            </Text>
            <TextInput
              value={scannedCode ?? ""}
              onChangeText={(text) =>
                setScannedCode(text.replace(/\D/g, "").slice(0, 14))
              }
              keyboardType="number-pad"
              maxLength={14}
              autoCorrect={false}
              selectTextOnFocus
              inputAccessoryViewID={
                Platform.OS === "ios" ? BARCODE_INPUT_ACCESSORY_ID : undefined
              }
              style={{
                fontFamily: fonts.display,
                fontSize: 22,
                color: colors.text,
                letterSpacing: -0.4,
                paddingVertical: 4,
                paddingHorizontal: 0,
                borderBottomWidth: 1,
                borderBottomColor: isCodeValid ? colors.border : colors.crit,
              }}
            />
            <Text
              style={{
                fontFamily: fonts.body,
                fontSize: 13,
                color: isCodeValid ? colors.textMuted : colors.crit,
                marginTop: 8,
                lineHeight: 18,
              }}
            >
              {isCodeValid
                ? "Tap the number to correct it, or re-scan if it's totally wrong."
                : "Barcode must be 8–14 digits."}
            </Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
              <Pressable
                onPress={handleReArm}
                style={{
                  flex: 1,
                  height: 48,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{
                    color: colors.text,
                    fontFamily: fonts.bodyStrong,
                    fontSize: 14,
                  }}
                >
                  Re-scan
                </Text>
              </Pressable>
              <Pressable
                onPress={handleContinue}
                disabled={!isCodeValid}
                style={{
                  flex: 1,
                  height: 48,
                  borderRadius: 12,
                  backgroundColor: colors.accent,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: isCodeValid ? 1 : 0.5,
                }}
              >
                <Text
                  style={{
                    color: colors.accentInk,
                    fontFamily: fonts.bodyStrong,
                    fontSize: 14,
                  }}
                >
                  Continue
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      {Platform.OS === "ios" ? (
        <InputAccessoryView nativeID={BARCODE_INPUT_ACCESSORY_ID}>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "flex-end",
              alignItems: "center",
              paddingHorizontal: 12,
              paddingVertical: 8,
              backgroundColor: colors.surfaceAlt,
              borderTopWidth: 1,
              borderTopColor: colors.border,
            }}
          >
            <Pressable
              onPress={() => Keyboard.dismiss()}
              hitSlop={8}
              style={{ paddingHorizontal: 12, paddingVertical: 6 }}
            >
              <Text
                style={{
                  color: colors.accent,
                  fontFamily: fonts.bodyStrong,
                  fontSize: 16,
                  letterSpacing: -0.1,
                }}
              >
                Done
              </Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
    </ScrollView>
  );
}

export default BarcodeScanner;
