import { ScrollViewStyleReset } from 'expo-router/html';

// Web-only: configures the root HTML for every page during static rendering.
// This runs in Node.js (not the browser), so no DOM or browser APIs are available.
// You can safely ignore this file — it only matters if you deploy as a web app.
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />

        {/* Disables body scrolling on web so ScrollView works like it does on native */}
        <ScrollViewStyleReset />

        {/* Inline CSS prevents dark-mode background flicker before JS loads */}
        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const responsiveBackground = `
body {
  background-color: #fff;
}
@media (prefers-color-scheme: dark) {
  body {
    background-color: #000;
  }
}`;
