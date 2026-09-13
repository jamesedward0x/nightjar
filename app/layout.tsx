import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Nightjar - 7x24 tokenized US equity research desk",
  description:
    "Nightjar researches Bitget tokenized US equities (rTokens) through the hours when the market that prices them is closed. Read-only. It never trades; a human decides.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
