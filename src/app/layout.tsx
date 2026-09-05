import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rebound — revenue operations",
  description: "An incident-aware, approval-first revenue recovery workspace."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
