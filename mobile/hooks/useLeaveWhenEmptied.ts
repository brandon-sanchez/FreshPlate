import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";

/**
 * Goes back once a screen that had content this visit loses it, and returns
 * true from then on so the screen can render blank while it leaves. Waits
 * while another screen is on top, such as the batch editor whose delete
 * emptied this one, and leaves when this screen is shown again.
 *
 * @param hasContent - Whether the screen has anything to show right now.
 */
export function useLeaveWhenEmptied(hasContent: boolean): boolean {
  const router = useRouter();
  const isFocused = useIsFocused();
  const [hadContent, setHadContent] = useState(false);
  if (hasContent && !hadContent) setHadContent(true);
  const emptied = hadContent && !hasContent;

  useEffect(() => {
    if (emptied && isFocused) router.back();
  }, [emptied, isFocused, router]);

  return emptied;
}
