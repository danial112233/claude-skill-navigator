import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const COMMANDS = [
  { name: 'remotion:remotion-create', description: 'Create a new Remotion video', source: 'plugin' as const, plugin: 'remotion' },
  { name: 'social-media-skills:reels-script', description: 'Write a script for Instagram Reels', source: 'plugin' as const },
  { name: 'frontend-design:frontend-design', description: 'Frontend design skill for UI/UX', source: 'plugin' as const },
  { name: 'compact', description: 'Compact the conversation', source: 'builtin' as const },
  { name: 'clear', description: 'Start a new session with empty context', source: 'builtin' as const },
  { name: 'plugin-authoring', description: "Make a mod: a change to Claude's own interface or behaviour", source: 'builtin' as const },
  { name: 'skill-creator', description: 'Create new skills, modify and improve existing skills', source: 'user' as const },
  { name: 'computer-use', description: "Do something in an app on the person's own computer", source: 'user' as const },
  { name: 'team-chat', description: 'Написать в командный чат или прочитать его', source: 'user' as const },
  { name: 'built-in-browser', description: 'Read this skill before the first step that uses the built-in browser', source: 'user' as const },
]

type Seen = {
  contexts: (readonly string[] | undefined)[]
  toasts: string[]
  asked: number
  prompts: string[]
  systems: (string | undefined)[]
  firstBlocks: unknown[]
}

type Row = { role: 'user' | 'assistant'; text: string; toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown> }[] }

function world(on: On, answer: string, messages: Row[] = []): Seen {
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  const seen: Seen = { contexts: [], toasts: [], asked: 0, prompts: [], systems: [], firstBlocks: [] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: COMMANDS }))
  on('session.messages', () => ({ value: messages }))
  on('ui.toast', ($, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('model.complete', ($, e) => {
    seen.asked += 1
    seen.prompts.push(e.prompt)
    seen.systems.push(e.system)
    seen.firstBlocks.push(e.promptBlocks?.[0])
    return { value: { isAnswered: true as const, text: answer, usage: USAGE } }
  })
  on('prompt.submit', ($, e) => { seen.contexts.push(e.context); return { text: e.text } })
  return seen
}

const said = (role: Row['role'], text: string, skill?: string): Row => ({
  role,
  text,
  toolUses: skill === undefined ? [] : [{ tool_use_id: `t-${skill}`, tool: 'Skill', input: { skill } }],
})

// Разговор, в котором сегодня промахнулся навигатор: бот уже сделан через управление компьютером.
const BOT_MADE = [
  said('user', 'Включил управление компьютером, создавай бота'),
  said('assistant', 'Беру управление компьютером.', 'computer-use'),
  said('assistant', 'Бот создан в BotFather: @my_claude_bot, токен сохранён.'),
]

test('подбирает скиллы и передаёт Claude подсказку', async ($, on) => {
  const seen = world(on, 'remotion:remotion-create\nsocial-media-skills:reels-script')
  await $.prompt.submit({ text: 'сделай рилс про новые роллы с субтитрами' } as never)
  expect(seen.asked).toBe(1)
  expect(seen.toasts[0]).toContain('/remotion:remotion-create')
  expect(seen.contexts[0]?.[0]).toContain('social-media-skills:reels-script')
})

test('велит Claude запустить скилл самому, а не предлагать', async ($, on) => {
  const seen = world(on, 'remotion:remotion-create')
  await $.prompt.submit({ text: 'смонтируй ролик из этих кадров' } as never)
  const told = seen.contexts[0]?.[0] ?? ''
  expect(told).toContain('Skill(skill: "remotion:remotion-create")')
  expect(told).toContain('не спрашивай')
  expect(seen.toasts[0]).toBe('🧭 Беру: /remotion:remotion-create')
})

test('берёт не больше двух скиллов', async ($, on) => {
  const seen = world(on, 'remotion:remotion-create\nsocial-media-skills:reels-script\nfrontend-design:frontend-design')
  await $.prompt.submit({ text: 'сделай рилс и страницу для него' } as never)
  expect(seen.toasts[0]).toBe('🧭 Беру: /remotion:remotion-create, /social-media-skills:reels-script')
})

test('встроенные команды в каталог не попадают', async ($, on) => {
  const seen = world(on, 'NONE')
  await $.prompt.submit({ text: 'сожми разговор, он слишком длинный' } as never)
  expect(seen.prompts[0]).not.toContain('compact —')
  expect(seen.contexts[0]).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('выдуманные моделью названия отбрасываются', async ($, on) => {
  const seen = world(on, '- fake:skill\n- frontend-design:frontend-design')
  await $.prompt.submit({ text: 'сверстай красивый лендинг для кофейни' } as never)
  expect(seen.toasts[0]).toBe('🧭 Беру: /frontend-design:frontend-design')
})

test('короткие ответы и команды не трогает', async ($, on) => {
  const seen = world(on, 'remotion:remotion-create')
  await $.prompt.submit({ text: 'да' } as never)
  await $.prompt.submit({ text: 'продолжай' } as never)
  expect(seen.asked).toBe(0)
})

test('/nav задача показывает команду, /nav выкл отключает', async ($, on) => {
  const seen = world(on, 'remotion:remotion-create')
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
  const shown = await $.command.run({ command: 'nav', args: 'смонтировать видео' } as never)
  expect(JSON.stringify(shown)).toContain('/remotion:remotion-create')
  await $.command.run({ command: 'nav', args: 'выкл' } as never)
  await $.prompt.submit({ text: 'сделай рилс про новые роллы с субтитрами' } as never)
  expect(seen.asked).toBe(1)
})

test('/nav список группирует по плагинам', async ($, on) => {
  world(on, 'NONE')
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
  const list = await $.command.run({ command: 'nav', args: 'список' } as never)
  expect(JSON.stringify(list)).toContain('remotion (1)')
})

// Промахи 16.10: «займись навигатором» → skill-creator, хотя это мод. plugin-authoring встроенный,
// и раньше в каталог не попадал вовсе.
test('встроенные скиллы Claude Code в каталоге, команды интерфейса нет', async ($, on) => {
  const seen = world(on, 'plugin-authoring')
  await $.prompt.submit({ text: 'займись навигатором, чтобы точнее выбирал скиллы' } as never)
  expect(seen.prompts[0]).toContain('plugin-authoring —')
  expect(seen.prompts[0]).not.toContain('clear —')
  expect(seen.prompts[0]).not.toContain('compact —')
  expect(seen.toasts[0]).toBe('🧭 Беру: /plugin-authoring')
})

// Промах «закрепи нового бота в Telegram вместо Work Chat» → team-chat: Haiku не знала, о чём разговор.
test('передаёт Haiku последние реплики разговора', async ($, on) => {
  const seen = world(on, 'NONE', BOT_MADE)
  await $.prompt.submit({ text: 'закрепи нового бота в Telegram вместо Work Chat' } as never)
  const prompt = seen.prompts[0] ?? ''
  expect(prompt).toContain('RECENT CONVERSATION:')
  expect(prompt).toContain('assistant: Бот создан в BotFather')
  expect(prompt).toContain('LATEST MESSAGE:\nзакрепи нового бота в Telegram вместо Work Chat')
  expect(prompt.indexOf('RECENT CONVERSATION:')).toBeLessThan(prompt.indexOf('LATEST MESSAGE:'))
  expect(seen.contexts[0]).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('каталог идёт первым и остаётся в кэше, разговор после него', async ($, on) => {
  const seen = world(on, 'NONE', BOT_MADE)
  await $.prompt.submit({ text: 'придумай название и аватарку, закрепи' } as never)
  const first = seen.firstBlocks[0] as { text: string; cache?: boolean }
  expect(first.cache).toBe(true)
  expect(first.text.startsWith('CATALOG:\n')).toBe(true)
  expect(first.text).not.toContain('Бот создан')
})

test('в начале разговора так и говорит Haiku', async ($, on) => {
  const seen = world(on, 'NONE')
  await $.prompt.submit({ text: 'сверстай красивый лендинг для кофейни' } as never)
  expect(seen.prompts[0]).toContain('first message of the conversation')
})

test('служебные строки и ответы инструментов в разговор не попадают', async ($, on) => {
  const seen = world(on, 'NONE', [
    said('user', 'сделай бота'),
    said('user', '<system-reminder>служебное</system-reminder>'),
    said('user', ''),
    said('assistant', 'Готово, бот есть.'),
  ])
  await $.prompt.submit({ text: 'можешь вместо рабочий чат закрепить' } as never)
  expect(seen.prompts[0]).toContain('user: сделай бота')
  expect(seen.prompts[0]).not.toContain('служебное')
  expect(seen.prompts[0]).not.toContain('user: \n')
})

test('длинные реплики режет, конец ответа Claude оставляет', async ($, on) => {
  const seen = world(on, 'NONE', [said('user', 'объясни'), said('assistant', `${'слово '.repeat(2000)}ВОПРОС В КОНЦЕ?`)])
  await $.prompt.submit({ text: 'Открой мне эту вкладку, где это проходить' } as never)
  const prompt = seen.prompts[0] ?? ''
  const recent = prompt.slice(prompt.indexOf('RECENT CONVERSATION:'), prompt.indexOf('LATEST MESSAGE:'))
  expect(recent).toContain('ВОПРОС В КОНЦЕ?')
  expect(recent.length).toBeLessThan(2000)
})

// «можешь вместо рабочий чат закрепить» посреди работы через управление компьютером:
// повторно тот же скилл запускать незачем, он уже в разговоре.
test('скилл, уже запущенный в этом разговоре, второй раз не берёт', async ($, on) => {
  const seen = world(on, 'computer-use', BOT_MADE)
  await $.prompt.submit({ text: 'можешь вместо рабочий чат закрепить' } as never)
  expect(seen.asked).toBe(1)
  expect(seen.contexts[0]).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('реплику, набранную, пока Claude работает, не трогает', async ($, on) => {
  const seen = world(on, 'built-in-browser')
  await $.prompt.submit({ text: 'Открой мне эту вкладку, где это проходить', turnId: 'turn-1', wait: false } as never)
  expect(seen.asked).toBe(0)
  expect(seen.contexts[0]).toBeUndefined()
})

test('задачу, поставленную в очередь, разбирает как обычную', async ($, on) => {
  const seen = world(on, 'built-in-browser')
  await $.prompt.submit({ text: 'открой в браузере сайт кофейни и проверь форму', turnId: 'turn-1', wait: true } as never)
  expect(seen.asked).toBe(1)
  expect(seen.toasts[0]).toBe('🧭 Беру: /built-in-browser')
})

test('инструкция требует совпадения с делом, а не со словом, и при сомнении NONE', async ($, on) => {
  const seen = world(on, 'NONE')
  await $.prompt.submit({ text: 'открой мне эту вкладку' } as never)
  const system = seen.systems[0] ?? ''
  expect(system).toContain('job the latest message asks Claude to do now')
  expect(system).toContain('A shared word, name or topic is not enough')
  expect(system).toContain('follow-up')
  expect(system).toContain('If you hesitate between an entry and NONE, answer NONE')
})

// Сначала Haiku одной строкой называет дело, потом скилл: на живой Haiku так точнее.
test('просит у Haiku строку TASK перед выбором и разбирает такой ответ', async ($, on) => {
  const seen = world(on, 'TASK: смонтировать рилс с субтитрами\nremotion:remotion-create')
  await $.prompt.submit({ text: 'сделай рилс про новые роллы с субтитрами' } as never)
  expect(seen.systems[0]).toContain('TASK: <the job the latest message asks for')
  expect(seen.toasts[0]).toBe('🧭 Беру: /remotion:remotion-create')
})

test('ответ TASK и NONE ничего не запускает', async ($, on) => {
  const seen = world(on, 'TASK: закрепить чат с ботом в Telegram\nNONE')
  await $.prompt.submit({ text: 'закрепи нового бота в Telegram вместо Work Chat' } as never)
  expect(seen.contexts[0]).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

// Верные выборы из той же сессии должны остаться.
test('«Включил управление компьютером, создавай бота» по-прежнему берёт computer-use', async ($, on) => {
  const seen = world(on, 'computer-use', [said('assistant', 'Могу создать бота сам через управление компьютером, включи его.')])
  await $.prompt.submit({ text: 'Включил управление компьютером, создавай бота' } as never)
  expect(seen.toasts[0]).toBe('🧭 Беру: /computer-use')
  expect(seen.contexts[0]?.[0]).toContain('Skill(skill: "computer-use")')
})

test('узнаёт уже запущенный скилл и с приставкой плагина', async ($, on) => {
  const seen = world(on, 'computer-use', [said('assistant', 'Беру управление компьютером.', 'anthropic-skills:computer-use')])
  await $.prompt.submit({ text: 'закрепи нового бота в Telegram вместо Work Chat' } as never)
  expect(seen.toasts).toEqual([])
})
