import Link from 'next/link'
import { Zap } from 'lucide-react'

export const metadata = {
  title: 'Terms of Service — XXmachine',
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

export default function TermsPage() {
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
            <h1 className="font-display text-4xl font-bold text-foreground mb-2">Terms of Service</h1>
            <p className="text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>
          </div>

          <div className="glass-card rounded-2xl p-8 sm:p-10">

            <Section title="1. Acceptance of Terms">
              <p>
                By accessing or using XXmachine ("the Service"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, you may not access or use the Service.
              </p>
              <p>
                These Terms constitute a legally binding agreement between you and the operators of XXmachine.
              </p>
            </Section>

            <Section title="2. Access and Accounts">
              <p>Access to XXmachine is by invitation only. You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account.</p>
              <p>You must notify an administrator immediately of any unauthorised use of your account. We are not liable for losses arising from unauthorised account access caused by your failure to protect your credentials.</p>
              <p>Accounts are non-transferable. Creating multiple accounts for the same individual is not permitted without explicit administrator approval.</p>
            </Section>

            <Section title="3. Permitted Use">
              <p>You may use XXmachine solely for lawful business purposes related to social media content management and automation. You agree not to:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Use the Service to publish illegal, harmful, deceptive, or abusive content</li>
                <li>Violate the terms of service of any connected platform (Instagram, Threads, TikTok, Twitter/X)</li>
                <li>Attempt to gain unauthorised access to any system, account, or data</li>
                <li>Use the Service to spam, harass, or engage in mass unsolicited messaging</li>
                <li>Reverse-engineer, decompile, or attempt to extract the source code of the Service</li>
                <li>Use the Service in any way that could damage, disable, or impair its operation</li>
              </ul>
            </Section>

            <Section title="4. Connected Platform Compliance">
              <p>When you connect third-party platforms (Instagram, Threads, TikTok, Twitter/X), you remain solely responsible for ensuring your use of those platforms complies with their respective terms of service and community guidelines.</p>
              <p>XXmachine provides automation tooling only. We are not responsible for account suspensions, bans, or penalties imposed by third-party platforms as a result of your content or posting behaviour.</p>
            </Section>

            <Section title="5. Content Responsibility">
              <p>You retain ownership of all content you create, upload, or publish through the Service. By using the Service to publish content, you represent and warrant that:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>You own or have the necessary rights to the content</li>
                <li>The content does not infringe the intellectual property rights of any third party</li>
                <li>The content complies with all applicable laws and regulations</li>
              </ul>
              <p>We reserve the right to suspend accounts that publish content we determine, in our sole discretion, to be harmful, illegal, or in violation of these Terms.</p>
            </Section>

            <Section title="6. AI-Generated Content">
              <p>XXmachine uses third-party AI APIs (including xAI Grok, Anthropic Claude, and Google Gemini) to generate images, captions, and fan interaction suggestions. You acknowledge that:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>AI-generated content may be inaccurate, incomplete, or inappropriate</li>
                <li>You are responsible for reviewing and approving all AI-generated content before publication</li>
                <li>Ownership and licensing of AI-generated content is subject to the terms of the respective AI provider</li>
              </ul>
            </Section>

            <Section title="7. Service Availability">
              <p>We strive to maintain high availability but do not guarantee uninterrupted access to the Service. We may suspend or discontinue the Service at any time with or without notice for maintenance, security, or operational reasons.</p>
              <p>We are not liable for any loss of data, missed publishing schedules, or business losses arising from Service downtime or interruptions.</p>
            </Section>

            <Section title="8. Limitation of Liability">
              <p>To the fullest extent permitted by law, XXmachine and its operators shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of revenue, loss of data, or loss of business opportunities, arising from your use of or inability to use the Service.</p>
              <p>Our total liability to you for any claim arising from these Terms or your use of the Service shall not exceed the amount paid by you for the Service in the twelve months preceding the claim.</p>
            </Section>

            <Section title="9. Termination">
              <p>We may suspend or terminate your account at any time, with or without cause, at our sole discretion. You may request account termination at any time by contacting an administrator.</p>
              <p>Upon termination, your access to the Service will cease and we may delete your data in accordance with our Privacy Policy and data retention schedules.</p>
            </Section>

            <Section title="10. Modifications to Terms">
              <p>We reserve the right to modify these Terms at any time. The "Last updated" date at the top of this page indicates when the Terms were last revised. Continued use of the Service after changes constitutes your acceptance of the revised Terms.</p>
            </Section>

            <Section title="11. Governing Law">
              <p>These Terms are governed by and construed in accordance with applicable law. Any disputes arising from these Terms shall be resolved through good-faith negotiation before pursuing any formal legal remedy.</p>
            </Section>

            <Section title="12. Contact">
              <p>If you have questions about these Terms, contact the platform administrator through your account dashboard or via the contact information provided during onboarding.</p>
              <p>XXmachine, 30 N Gould St Ste R, Sheridan, WY 82801 · +1 (254) 550-2084</p>
            </Section>

          </div>

          <div className="mt-8 flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground transition-colors">← Home</Link>
            <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy Policy →</Link>
          </div>
        </div>
      </main>
    </div>
  )
}
