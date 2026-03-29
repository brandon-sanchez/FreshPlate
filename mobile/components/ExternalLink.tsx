import { Link } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { Platform } from 'react-native';

// Opens external URLs. On web it behaves like a normal link.
// On iOS/Android it opens an in-app browser instead of leaving the app.
export function ExternalLink(
  props: Omit<React.ComponentProps<typeof Link>, 'href'> & { href: string }
) {
  return (
    <Link
      target="_blank"
      {...props}
      // @ts-expect-error: External URLs are not typed by Expo Router.
      href={props.href}
      onPress={(e) => {
        if (Platform.OS !== 'web') {
          e.preventDefault(); // don't open in the system browser
          WebBrowser.openBrowserAsync(props.href as string); // open in-app instead
        }
      }}
    />
  );
}
