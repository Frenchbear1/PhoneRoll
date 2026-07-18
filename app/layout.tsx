import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PhoneRoll",
  description: "An offline engineering prototype for measuring distance with quarter-turn phone rolls.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/favicon.svg", apple: "/favicon.svg" },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "PhoneRoll" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
