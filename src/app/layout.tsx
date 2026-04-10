import type { Metadata } from "next";
import { IBM_Plex_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const plusJakartaSans = Plus_Jakarta_Sans({
  variable: "--font-plus-jakarta-sans",
  subsets: ["latin"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Furniture Taxi | Premium Moving Quote Assistant",
  description: "A polished concierge-style interface for instant furniture moving quotes.",
};

const htmlClassName = [
  plusJakartaSans.variable,
  ibmPlexMono.variable,
  "h-full antialiased",
].join(" ");

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={htmlClassName}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
