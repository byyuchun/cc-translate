import { expect, test } from 'claude-code/testing'

const pane = {
  plugin: 'cc-translate',
  component: 'Pane',
  requestId: 'translate',
  props: {
    title: '翻译',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the pane draws on the desktop with no endpoint configured', async $ => {
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })

  const header = await ui.find({ type: 'Text', text: /未配置翻译端点/ })
  expect(header?.text).toContain('未配置翻译端点')

  const field = await ui.find({ type: 'Input' })
  expect(field).toBeTruthy()

  await ui.unmount()
})

test('the pane draws on the terminal and the vscode surface', async $ => {
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...pane, surface })
    expect(await ui.find({ type: 'Text', text: /未配置翻译端点/ })).toBeTruthy()
    await ui.unmount()
  }
})
