import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Alkaline",
  description: "A loop-based music workstation in the spirit of Sony ACID.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
