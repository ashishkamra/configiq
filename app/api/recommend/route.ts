import { NextRequest, NextResponse } from 'next/server'
import { RecommendRequestSchema } from '@/lib/api/schemas'
import { callRecommend, generateRequestId, incrementalRecommend, type RecommendProgressEvent } from '@/lib/api/recommend'
import { gatewayTimeoutSeconds } from '@/lib/api/timeout'
import { recordErrorCode, recordModelRequest } from '@/lib/otel-metrics'

const ERROR_STATUS_MAP: Record<string, number> = {
  INVALID_REQUEST: 400,
  AISIM_NOT_CONFIGURED: 503,
  AISIM_UNAVAILABLE: 502,
  AISIM_TIMEOUT: 504,
  AISIM_INVALID_RESPONSE: 502,
  AISIM_NO_CONFIGURATION: 422,
  INTERNAL_ERROR: 500,
}

async function proxyToGateway(body: Record<string, unknown>, include: string, model: unknown): Promise<NextResponse> {
  const baseUrl = process.env.AISIMULATORS_GATEWAY_URL
  const timeoutSeconds = gatewayTimeoutSeconds()

  if (!baseUrl) {
    recordErrorCode('/api/recommend', 'AISIM_NOT_CONFIGURED', 503, model)
    return NextResponse.json(
      { status: 'failed', error: { code: 'AISIM_NOT_CONFIGURED', message: 'AISimulators API URL is not configured' } },
      { status: 503 },
    )
  }

  try {
    const res = await fetch(`${baseUrl}/recommend?include=${encodeURIComponent(include)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    })

    const text = await res.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      recordErrorCode('/api/recommend', 'AISIM_INVALID_RESPONSE', 502, model)
      return NextResponse.json(
        { status: 'failed', error: { code: 'AISIM_INVALID_RESPONSE', message: 'AISimulators returned non-JSON response' } },
        { status: 502 },
      )
    }
    if (!res.ok) {
      const error = data && typeof data === 'object' && 'error' in data
        ? (data as { error?: { code?: unknown } }).error
        : undefined
      recordErrorCode(
        '/api/recommend',
        typeof error?.code === 'string' ? error.code : 'AISIM_UNAVAILABLE',
        res.status,
        model,
      )
    }
    return NextResponse.json(data, {
      status: res.ok ? 200 : res.status,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      recordErrorCode('/api/recommend', 'AISIM_TIMEOUT', 504, model)
      return NextResponse.json(
        { status: 'failed', error: { code: 'AISIM_TIMEOUT', message: 'AISimulators API timed out' } },
        { status: 504 },
      )
    }
    recordErrorCode('/api/recommend', 'AISIM_UNAVAILABLE', 502, model)
    return NextResponse.json(
      { status: 'failed', error: { code: 'AISIM_UNAVAILABLE', message: 'AISimulators API is unreachable' } },
      { status: 502 },
    )
  }
}

function streamRecommendation(
  request: ReturnType<typeof RecommendRequestSchema.parse>,
  requestSignal: AbortSignal,
): NextResponse {
  const encoder = new TextEncoder()
  const abortController = new AbortController()
  if (requestSignal.aborted) abortController.abort()
  let closed = false
  const abort = () => abortController.abort()
  requestSignal.addEventListener('abort', abort, { once: true })
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: RecommendProgressEvent) => {
        if (closed) return
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      }

      const finish = () => {
        if (closed) return
        closed = true
        controller.close()
      }

      try {
        for await (const event of incrementalRecommend(request, abortController.signal)) send(event)
        finish()
      } catch (err: unknown) {
        if (!abortController.signal.aborted) {
          recordErrorCode('/api/recommend', 'INTERNAL_ERROR', 200, request.model_path)
          send({
            type: 'completed',
            response: {
              requestId: generateRequestId(),
              status: 'failed',
              error: {
                code: 'INTERNAL_ERROR',
                message: err instanceof Error ? err.message : 'An unexpected error occurred',
              },
            },
          })
        }
        finish()
      } finally {
        requestSignal.removeEventListener('abort', abort)
      }
    },
    cancel() {
      closed = true
      abortController.abort()
      requestSignal.removeEventListener('abort', abort)
    },
  })

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Cache-Control': 'no-cache, no-store',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  })
}

export async function POST(req: NextRequest) {
  let modelRequestRecorded = false
  let model: unknown
  try {
    const body = await req.json()
    model = body && typeof body === 'object' && 'model_path' in body
      ? (body as { model_path?: unknown }).model_path
      : undefined
    recordModelRequest('recommend', model)
    modelRequestRecorded = true
    const include = req.nextUrl.searchParams.get('include')

    if (include) {
      return proxyToGateway(body, include, model)
    }

    const validated = RecommendRequestSchema.parse(body)
    if (req.headers.get('accept')?.includes('text/event-stream')) {
      return streamRecommendation(validated, req.signal)
    }
    const result = await callRecommend(validated)

    if (result.status === 'failed') {
      const httpStatus = ERROR_STATUS_MAP[result.error.code] ?? 500
      recordErrorCode('/api/recommend', result.error.code, httpStatus, validated.model_path)
      return NextResponse.json(result, { status: httpStatus })
    }

    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err: unknown) {
    if (!modelRequestRecorded) recordModelRequest('recommend', 'unknown')
    const requestId = generateRequestId()

    if (err instanceof Error && err.constructor.name === 'ZodError') {
      recordErrorCode('/api/recommend', 'INVALID_REQUEST', 400, model)
      const zodErr = err as Error & { issues: unknown[] }
      return NextResponse.json(
        {
          requestId,
          status: 'failed',
          error: {
            code: 'INVALID_REQUEST',
            message: 'Request validation failed',
            details: zodErr.issues,
          },
        },
        { status: 400 }
      )
    }

    recordErrorCode('/api/recommend', 'INTERNAL_ERROR', 500, model)
    return NextResponse.json(
      {
        requestId,
        status: 'failed',
        error: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'An unexpected error occurred',
        },
      },
      { status: 500 }
    )
  }
}


export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}
