import Link from 'next/link'
import { Assistant } from '@/components/assistant/Assistant'
import { agentEnabled } from '@/lib/agent/config'

export const dynamic = 'force-dynamic'
export default function AssistantPage() {
  if (!agentEnabled()) return <section style={{ padding: 24 }}>
    <h1 style={{ fontSize: 26, fontFamily: 'var(--font-display)' }}>Ask ConfigIQ</h1>
    <p>The sizing assistant is not enabled on this deployment. <Link href="/recommend">Use Recommend sizing</Link>.</p>
  </section>
  return <Assistant />
}
