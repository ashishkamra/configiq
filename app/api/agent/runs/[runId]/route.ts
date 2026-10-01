import { NextRequest } from 'next/server'
import { runDetailRoute } from '@/lib/agent/routes'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export function GET(request: NextRequest, { params }: { params: { runId: string } }) { return runDetailRoute(request, params.runId) }
export function DELETE(request: NextRequest, { params }: { params: { runId: string } }) { return runDetailRoute(request, params.runId) }
