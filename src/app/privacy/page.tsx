import Link from 'next/link'
import { Zap } from 'lucide-react'

export const metadata = {
  title: 'Privacy Policy — XXmachine',
}

const LAST_UPDATED = 'June 25, 2026'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold text-foreground mb-3">{title}</h2>
      <div className="text-sm text-muted-foreground leading-relaxed space-y-3">{children}</div>
    </section>
  )
}

export default function PrivacyPage() {
  return (
    <div className="relative min-h-screen">
      {/* Nav */}
      <nav className="fixed top-0 inset-x-0 z-50 border-b border-white/8 bg-background/70 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/15 border border-primary/25">
              <Zap className="w-3.5 h-3.5 text-primary" />
            </div>
            <span className="font-display font-bold text-base tracking-tight text-foreground">XXmachine</span>
          </Link>
          <Link href="/login" className="text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity px-4 py-1.5 rounded-lg">
            Sign in
          </Link>
        </div>
      </nav>

      <main className="pt-28 pb-24 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="mb-10">
            <h1 className="font-display text-4xl font-bold text-foreground mb-2">Privacy Policy</h1>
            <p className="text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>
          </div>

          <div className="glass-card rounded-2xl p-8 sm:p-10">

            <Section title="1. Introduction">
              <p>
                XXmachine ("we", "us", or "our") operates as a private content automation platform for social media agencies. This Privacy Policy explains how we collect, use, and protect information when you use our service.
              </p>
              <p>
                By accessing XXmachine, you agree to the data practices described in this policy. If you do not agree, please discontinue use of the service.
              </p>
            </Section>

            <Section title="2. Information We Collect">
              <p><strong className="text-foreground">Account information:</strong> When you register, we collect your email address, display name, and a hashed password. We never store passwords in plain text.</p>
              <p><strong className="text-foreground">Platform credentials:</strong> To enable posting and analytics, we store OAuth access tokens for platforms you connect (Instagram, Threads). For username-based tracking (Twitter/X, TikTok), we store only the public username.</p>
              <p><strong className="text-foreground">Content data:</strong> We store metadata about posts you schedule (captions, image URLs, publish status, timestamps). We do not store media files directly — these remain in your connected Google Drive or external CDN.</p>
              <p><strong className="text-foreground">Usage data:</strong> Session identifiers (stored as signed cookies), IP address, and browser user-agent are logged for security and session management purposes.</p>
              <p><strong className="text-foreground">Analytics data:</strong> Platform statistics (follower counts, view counts) fetched from connected accounts are cached in our database for dashboard display.</p>
            </Section>

            <Section title="3. How We Use Your Information">
              <p>We use the information we collect to:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Authenticate you and maintain your session</li>
                <li>Publish content to connected social media platforms on your behalf</li>
                <li>Display analytics and performance data in your dashboard</li>
                <li>Run scheduled automation (cron jobs for publishing, token refresh)</li>
                <li>Provide fan management and messaging features</li>
              </ul>
              <p>We do not sell, rent, or share your personal information with third parties for marketing purposes.</p>
            </Section>

            <Section title="4. Third-Party Services">
              <p>XXmachine integrates with the following third-party services. Their privacy policies govern their data handling:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li><strong className="text-foreground">Meta (Instagram, Threads):</strong> OAuth authentication and content publishing via the Graph API</li>
                <li><strong className="text-foreground">Apify:</strong> Used to scrape public profile statistics from Twitter/X, TikTok, and Instagram where official APIs are unavailable</li>
                <li><strong className="text-foreground">Google Drive:</strong> Optional storage for generated media content via service account credentials</li>
                <li><strong className="text-foreground">Supabase / PostgreSQL:</strong> Database hosting for all application data</li>
                <li><strong className="text-foreground">xAI Grok / Anthropic / Google Gemini:</strong> AI APIs used for content generation and fan profile analysis</li>
              </ul>
            </Section>

            <Section title="5. Data Retention">
              <p>We retain your data for as long as your account is active. You may request deletion of your account and associated data at any time by contacting an administrator.</p>
              <p>Platform stats snapshots (analytics history) are retained for up to 90 days. Session records are deleted upon logout or after 30 days of inactivity.</p>
            </Section>

            <Section title="6. Security">
              <p>We take reasonable technical measures to protect your data, including:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>HMAC-SHA256 signed session cookies</li>
                <li>bcrypt password hashing</li>
                <li>TLS encryption in transit</li>
                <li>SSL-secured database connections</li>
              </ul>
              <p>No method of transmission over the internet is 100% secure. We cannot guarantee absolute security of your data.</p>
            </Section>

            <Section title="7. Your Rights (GDPR)">
              <p>If you are located in the European Economic Area, you have the following rights:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li><strong className="text-foreground">Access:</strong> Request a copy of personal data we hold about you</li>
                <li><strong className="text-foreground">Rectification:</strong> Request correction of inaccurate data</li>
                <li><strong className="text-foreground">Erasure:</strong> Request deletion of your personal data</li>
                <li><strong className="text-foreground">Restriction:</strong> Request that we limit processing of your data</li>
                <li><strong className="text-foreground">Portability:</strong> Request your data in a structured, machine-readable format</li>
              </ul>
              <p>To exercise these rights, contact your platform administrator.</p>
            </Section>

            <Section title="8. Cookies">
              <p>We use a single, strictly necessary session cookie (<code className="text-primary font-mono text-xs">xm_sid</code>) to maintain your authenticated session. This cookie is HttpOnly and does not track you across other websites. We do not use advertising or analytics cookies.</p>
            </Section>

            <Section title="9. Changes to This Policy">
              <p>We may update this Privacy Policy from time to time. The "Last updated" date at the top of this page reflects the most recent revision. Continued use of the service after changes constitutes acceptance of the updated policy.</p>
            </Section>

            <Section title="10. Contact">
              <p>For privacy-related questions or data requests, contact the platform administrator through your account dashboard or via the contact information provided during onboarding.</p>
            </Section>

          </div>

          <div className="mt-8 flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground transition-colors">← Home</Link>
            <Link href="/terms" className="hover:text-foreground transition-colors">Terms of Service →</Link>
          </div>
        </div>
      </main>
    </div>
  )
}
