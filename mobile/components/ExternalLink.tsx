import { Link, type ExternalPathString } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { Platform } from 'react-native';

/** Opens external URLs as a normal link on web and an in-app browser on mobile. */
export function ExternalLink(
  props: Omit<React.ComponentProps<typeof Link>, 'href'> & { href: ExternalPathString }
) {
  return (
    <Link
      target="_blank"
      {...props}
      href={props.href}
      onPress={(e) => {
        if (Platform.OS !== 'web') {
          e.preventDefault(); // don't open in the system browser
          WebBrowser.openBrowserAsync(props.href); // open in-app instead
        }
      }}
    />
  );
}
