import { expect, test } from 'claude-code/testing'

const options = { base_url: 'https://translate.example.com', token: 't', model: 'm' }

const questions = [
  {
    question: 'Which library should we use?',
    header: 'Library',
    multiSelect: false,
    options: [
      { label: 'Day.js', description: 'Small and fast' },
      { label: 'Luxon', description: 'Rich time zones' },
    ],
  },
]

const reply = (text: string) => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({ content: [{ type: 'text', text }] }),
})

/** A fake endpoint: dialog strings become `中:<s>`, anything else `EN(<s>)`. */
function fakeEndpoint(on: any): { ready: Promise<void> } {
  let done = (): void => {}
  const ready = new Promise<void>(resolve => {
    done = resolve
  })
  on('session.messages', async () => ({ value: [] }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('http.fetch', async (_$: unknown, e: { init?: { body?: string } }) => {
    const body = JSON.parse(e.init?.body ?? '{}')
    const user: string = body.messages[0].content
    if (String(body.system).includes('JSON array of strings')) {
      const strings = JSON.parse(user) as string[]
      setTimeout(done, 0)
      return { value: reply(JSON.stringify(strings.map(s => `中:${s}`))) }
    }
    return { value: reply(`EN(${user})`) }
  })
  return { ready }
}

const turnOn = ($: any) =>
  $.command.run({
    command: 'zh',
    args: '',
    origin: { kind: 'user' },
    presentation: 'pane',
  }).catch(() => undefined)

test('the dialog draws its options in Chinese', { options }, async ($, on) => {
  const endpoint = fakeEndpoint(on)
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    await endpoint.ready
    return { result: { questions, answers: { 'Which library should we use?': 'Luxon' } } }
  })
  let drawn: any
  on('ui.render', { component: 'AskUserQuestion' }, async ($$: any, e: any) => {
    drawn = e.props.questions
    return { type: "engine", ref: 1 } as any
  })
  await turnOn($)
  await $.tool.call({ tool: 'AskUserQuestion', questions } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cc-translate',
      surface,
      component: 'AskUserQuestion',
      // The dialog's props need not match the tool input key for key.
      props: { tool: 'AskUserQuestion', questions: questions.map(q => ({ ...q, kind: 'choice' })) },
    } as any)
    expect(drawn[0].question).toBe('中:Which library should we use?')
    expect(drawn[0].options[1].label).toBe('中:Luxon')
    expect(drawn[0].options[1].description).toBe('中:Rich time zones')
    expect(drawn[0].multiSelect).toBe(false)
    await ui.unmount()
  }
})

test('a translated pick and a typed answer reach Claude in English', { options }, async ($, on) => {
  const endpoint = fakeEndpoint(on)
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    await endpoint.ready
    return {
      result: {
        questions,
        answers: {
          '中:Which library should we use?': '中:Luxon, 自己写一个',
        },
        response: '都不要',
      },
    }
  })
  await turnOn($)
  const out: any = await $.tool.call({ tool: 'AskUserQuestion', questions } as any)
  expect(out.result.answers).toEqual({ 'Which library should we use?': 'Luxon, EN(自己写一个)' })
  expect(out.result.response).toBe('EN(都不要)')
})
