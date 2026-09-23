import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

type ConversationApi = {
  createConversationState: () => any
  applyConversationFrame: (state: any, frame: any) => any
  conversationWindow: (items: any[], start: number, end: number) => any
  conversationEntriesFromEvent: (event: any) => any[]
  conversationToolGroups: (items: any[]) => any[]
  prependConversationRecords: (state: any, records: any[], hasMore: boolean) => any
  markdownBlocks: (text: string) => any[]
}

function loadConversationApi(): ConversationApi {
  const html = readFileSync(resolve(process.cwd(), 'ui/index.html'), 'utf8')
  const start = html.indexOf('/* BEGIN conversation model */')
  const end = html.indexOf('/* END conversation model */')
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('conversation model test seam is missing')
  }

  const context: Record<string, unknown> = {}
  vm.runInNewContext(
    `${html.slice(start, end)}\nthis.__conversationApi = { createConversationState, applyConversationFrame, conversationWindow, conversationEntriesFromEvent, conversationToolGroups, prependConversationRecords, markdownBlocks }`,
    context,
  )
  return context.__conversationApi as ConversationApi
}

describe('conversation pane model', () => {
  it('keeps the full model while selecting a bounded render window', () => {
    const api = loadConversationApi()
    const items = Array.from({ length: 8 }, (_, index) => `item-${index}`)

    expect(api.conversationWindow(items, 2, 5)).toEqual({
      start: 2,
      end: 5,
      hiddenBefore: 2,
      hiddenAfter: 3,
      items: ['item-2', 'item-3', 'item-4'],
    })
  })

  it('starts a long snapshot at the latest window without dropping history', () => {
    const api = loadConversationApi()
    const state = api.createConversationState()
    const records = Array.from({ length: 200 }, (_, index) => ({
      type: 'event',
      event: { type: 'user-message', seq: index, data: { text: `history-${index}` } },
    }))

    api.applyConversationFrame(state, { type: 'snapshot', records })

    expect(state.items).toHaveLength(200)
    expect(state.renderStart).toBe(80)
    expect(state.renderEnd).toBe(200)
  })

  it('keeps the visible records anchored when an older page is prepended', () => {
    const api = loadConversationApi()
    const state = api.createConversationState()
    const records = Array.from({ length: 200 }, (_, index) => ({
      type: 'event',
      event: { type: 'user-message', seq: index, data: { text: `history-${index}` } },
    }))
    api.applyConversationFrame(state, { type: 'snapshot', records })

    api.prependConversationRecords(state, [{
      type: 'event',
      event: { type: 'user-message', seq: -1, data: { text: 'older' } },
    }], true)

    expect(state.items).toHaveLength(201)
    expect(state.renderStart).toBe(81)
    expect(state.renderEnd).toBe(201)
    expect(state.items[state.renderStart]!.text).toBe('history-80')
  })

  it('keeps real message roles and packed assistant chunks readable', () => {
    const api = loadConversationApi()
    const state = api.createConversationState()
    const records = [
      {
        type: 'event',
        event: {
          type: 'user/message',
          seq: 10,
          time: 1_700_000_000_000,
          data: { role: 'user', content: [{ type: 'text', text: '请继续' }] },
        },
      },
      {
        type: 'event',
        event: {
          type: 'assistant/message',
          seq: 11,
          time: 1_700_000_000_100,
          data: {
            turn: 3,
            step: 1,
            message: { role: 'assistant', content: [{ type: 'text', text: '好的，我继续。' }] },
          },
        },
      },
      {
        type: 'chunks',
        event: {
          type: 'chunkrow/text-chunks',
          seq: 12,
          time: 1_700_000_000_200,
          data: { texts: ['流', '式'] },
        },
      },
    ]

    api.applyConversationFrame(state, {
      type: 'snapshot',
      cursor: 12,
      hasMore: true,
      records,
    })

    expect(state.items.map((item: any) => ({
      kind: item.kind,
      text: item.text,
      eventType: item.eventType,
    }))).toEqual([
      { kind: 'user', text: '请继续', eventType: 'user/message' },
      { kind: 'assistant', text: '好的，我继续。', eventType: 'assistant/message' },
      { kind: 'assistant', text: '流式', eventType: 'chunkrow/text-chunks' },
    ])
    expect(state.hasMore).toBe(true)

    api.applyConversationFrame(state, { type: 'event', event: records[1]!.event })
    expect(state.items.filter((item: any) => item.eventType === 'assistant/message')).toHaveLength(1)

    state.items.push({ kind: 'user', text: '稍等', pending: true })
    api.applyConversationFrame(state, {
      type: 'event',
      event: {
        type: 'user/message',
        seq: 13,
        time: 1_700_000_000_400,
        data: { role: 'user', content: [{ type: 'text', text: '稍等' }] },
      },
    })
    expect(state.items.filter((item: any) => item.kind === 'user' && item.text === '稍等')).toHaveLength(1)
    expect(state.items.some((item: any) => item.pending === true)).toBe(false)
  })

  it('replaces a live assistant echo when the durable assistant message arrives', () => {
    const api = loadConversationApi()
    const state = api.createConversationState()

    api.applyConversationFrame(state, { type: 'assistant-stream', frame: { type: 'start' } })
    api.applyConversationFrame(state, { type: 'assistant-stream', frame: { type: 'chunk', chunk: { text: '答案' } } })
    api.applyConversationFrame(state, { type: 'assistant-stream', frame: { type: 'chunk', chunk: { delta: '已准备好' } } })
    expect(state.liveAssistant).toMatchObject({ text: '答案已准备好', active: true })

    api.applyConversationFrame(state, {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 21,
        time: 1_700_000_000_300,
        data: { message: { role: 'assistant', content: [{ type: 'text', text: '答案已准备好' }] } },
      },
    })

    expect(state.liveAssistant).toBeNull()
    expect(state.items.filter((item: any) => item.kind === 'assistant')).toHaveLength(1)
  })

  it('keeps the coordinator fake-node message shape readable during local smoke tests', () => {
    const api = loadConversationApi()
    const state = api.createConversationState()
    api.applyConversationFrame(state, {
      type: 'event',
      event: { type: 'user-message', seq: 1, time: 1, data: { text: '旧协议回显' } },
    })
    api.applyConversationFrame(state, {
      type: 'event',
      event: { type: 'assistant-message', seq: 2, time: 2, data: { text: '旧协议回答' } },
    })
    expect(state.items.map((item: any) => [item.kind, item.text])).toEqual([
      ['user', '旧协议回显'],
      ['assistant', '旧协议回答'],
    ])
  })

  it('keeps tool lifecycle records out of message bubbles and pairs them by call id', () => {
    const api = loadConversationApi()

    const assistantEntries = api.conversationEntriesFromEvent({
      type: 'assistant/message',
      seq: 10,
      data: {
        turn: 2,
        step: 0,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '我先查看文件。' },
            { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' },
          ],
        },
      },
    })
    const resultEntries = api.conversationEntriesFromEvent({
      type: 'tool/result',
      seq: 12,
      data: {
        turn: 2,
        step: 0,
        message: {
          role: 'user',
          source: { type: 'tool-result', callId: 'call-1' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'C:\\workspace' }],
            isError: false,
          }],
        },
      },
    })

    expect(assistantEntries.map((entry: any) => [entry.kind, entry.text])).toEqual([
      ['assistant', '我先查看文件。'],
    ])
    expect(api.conversationEntriesFromEvent({
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }],
        },
      },
    })).toEqual([])

    const callEntries = api.conversationEntriesFromEvent({
      type: 'tool/call',
      seq: 11,
      data: {
        turn: 2,
        step: 0,
        callId: 'call-1',
        name: 'bash',
        arguments: '{"command":"pwd"}',
      },
    })
    expect(callEntries).toHaveLength(1)
    expect(callEntries[0]).toMatchObject({
      kind: 'tool',
      phase: 'call',
      callId: 'call-1',
      name: 'bash',
      argsRaw: '{"command":"pwd"}',
    })
    expect(resultEntries).toHaveLength(1)
    expect(resultEntries[0]).toMatchObject({
      kind: 'tool',
      phase: 'result',
      callId: 'call-1',
      output: 'C:\\workspace',
      isError: false,
    })

    const groups = api.conversationToolGroups([
      ...assistantEntries,
      ...callEntries,
      ...resultEntries,
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      callId: 'call-1',
      name: 'bash',
      argsRaw: '{"command":"pwd"}',
      output: 'C:\\workspace',
      state: 'ok',
    })
  })

  it('projects failed tool results as error rows instead of user messages', () => {
    const api = loadConversationApi()
    const entries = api.conversationEntriesFromEvent({
      type: 'tool/result',
      seq: 20,
      data: {
        message: {
          role: 'user',
          source: { type: 'tool-result', callId: 'call-error' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-error',
            content: [{ type: 'text', text: 'permission denied\\nfull diagnostic' }],
            isError: true,
          }],
        },
      },
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'tool',
      phase: 'result',
      callId: 'call-error',
      output: 'permission denied\\nfull diagnostic',
      isError: true,
    })
    expect(api.conversationToolGroups(entries)[0]).toMatchObject({ state: 'error' })

    const errorEventEntries = api.conversationEntriesFromEvent({
      type: 'tool/error',
      seq: 21,
      data: {
        callId: 'call-error-event',
        name: 'bash',
        error: { name: 'ToolError', message: 'command failed' },
      },
    })
    expect(errorEventEntries).toHaveLength(1)
    expect(api.conversationToolGroups([
      { kind: 'tool', phase: 'call', callId: 'call-error-event', name: 'bash', argsRaw: '{}' },
      ...errorEventEntries,
    ])[0]).toMatchObject({ state: 'error', output: 'ToolError · command failed' })
  })

  it('splits markdown code fences into safe renderable blocks', () => {
    const api = loadConversationApi()

    expect(api.markdownBlocks('先看这里\n\n```ts\nconst answer = 42\n```\n结束')).toEqual([
      { kind: 'text', text: '先看这里' },
      { kind: 'code', language: 'ts', text: 'const answer = 42' },
      { kind: 'text', text: '结束' },
    ])
  })
})
