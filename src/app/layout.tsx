import type { Metadata } from 'next'
import { Inter, Space_Grotesk, Geist_Mono, Playfair_Display } from 'next/font/google'
import './globals.css'
import { Providers } from '@/components/providers'

const inter = Inter({ variable: '--font-sans', subsets: ['latin'] })
const spaceGrotesk = Space_Grotesk({
  variable: '--font-display',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })
const playfair = Playfair_Display({
  variable: '--font-caption',
  subsets: ['latin'],
  weight: ['700', '800', '900'],
})

export const metadata: Metadata = {
  title: 'XXmachine',
  description: 'AI Content Orchestrator',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${spaceGrotesk.variable} ${geistMono.variable} ${playfair.variable} h-full`}
    >
      <body className="h-full bg-background text-foreground antialiased font-sans">
        <div className="cosmic-orb cosmic-orb-primary" aria-hidden />
        <div className="cosmic-orb cosmic-orb-secondary" aria-hidden />
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
