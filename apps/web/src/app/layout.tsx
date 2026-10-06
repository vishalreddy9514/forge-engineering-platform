import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Forge', template: '%s · Forge' },
  description: 'AI-assisted engineering issue and project management',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Reading the request makes every page render per request, which the CSP nonce requires: a
  // page prerendered at build time would carry scripts without this response's nonce.
  await headers();
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
