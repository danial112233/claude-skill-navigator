import type { EngineInterface, Register, SessionMessage } from 'claude-code'

// Навигатор: перед каждой задачей дешёвая Haiku смотрит список установленных скиллов
// и команд и выбирает один (редко два), который нужен под задачу. Claude получает
// указание сразу запустить его сам, а не предлагать пользователю. Чтобы короткое
// «закрепи» или «открой вкладку» не цеплялось за слова, Haiku видит и конец разговора.

type Entry = { name: string; description: string }

const S = {
  catalog: [] as Entry[],
  builtAt: 0,
  isOff: false,
}

const REFRESH_MS = 10 * 60 * 1000
const OWN = new Set(['nav'])
// Встроенные скиллы Claude Code приходят с пометкой builtin вместе с командами интерфейса
// (/clear, /model, /usage…). Берём только те, что делают работу.
const BUILTIN_SKILLS = new Set([
  'plugin-authoring', 'run', 'verify', 'code-review', 'simplify', 'security-review', 'init',
  'dataviz', 'artifact-design', 'artifact-diagramming', 'artifact-capabilities',
  'claude-api', 'workflow-authoring', 'update-config', 'keybindings-help', 'fewer-permission-prompts',
  'schedule', 'loop',
])
const RECENT_ROWS = 4
const SKIP = /^(да|ок|окей|ага|давай|продолжай|дальше|делай|го|норм|хорошо|верно|нет|стоп|спасибо|yes|ok|go|continue|\+)[\s!.,]*$/iu

const INSTRUCTIONS = `You decide which installed Claude Code skill, if any, Claude must run before it answers the user's latest message.
Whatever you name is run at once, with no confirmation, so a wrong pick derails the work. Naming nothing is safe: Claude still sees every skill and can run one itself.

CATALOG lists the entries one per line as "name — description".
RECENT CONVERSATION is what was said just before the latest message. Use it to understand what the latest message asks for and what it refers to; never pick an entry only because of an earlier topic.

Pick an entry only when its description covers the job the latest message asks Claude to do now.
- A shared word, name or topic is not enough: the entry must be for the job itself, not for something the message merely mentions.
- A short follow-up, a correction, a confirmation, an answer to Claude's question or the next step of work already under way gets NONE, unless that step is itself exactly the job of an entry.
- Making or changing something takes the entry for that kind of thing, not one that only shares a word with it.
- If several entries fit, take the most specific. Take a second only when the message clearly asks for two different jobs.
- If you hesitate between an entry and NONE, answer NONE.

Answer in this form and nothing else:
TASK: <the job the latest message asks for, in at most ten words>
then the entry names, one per line, exactly as written in the catalog, or the single line NONE.`

// Список живой: берётся из того, что реально установлено, и обновляется раз в 10 минут.
async function catalog($: EngineInterface): Promise<Entry[]> {
  const now = await $.clock.now()
  if (S.catalog.length > 0 && now - S.builtAt < REFRESH_MS) return S.catalog
  const all = await $.command.list()
  S.catalog = all
    .filter(one => one.source === 'plugin' || one.source === 'user' || (one.source === 'builtin' && BUILTIN_SKILLS.has(one.name)))
    .filter(one => !OWN.has(one.name))
    .map(one => ({ name: one.name, description: one.description.replace(/\s+/g, ' ').slice(0, 160) }))
  S.builtAt = now
  return S.catalog
}

// Конец разговора перед запросом: последние реплики без служебных вставок и ответов инструментов.
// У Claude важен конец ответа (там вопрос или следующий шаг), у пользователя начало.
function recent(rows: readonly SessionMessage[], text: string): string {
  const said = rows
    .map(one => ({ role: one.role, text: one.text.replace(/\s+/g, ' ').trim() }))
    .filter(one => one.text !== '' && !one.text.startsWith('<'))
  const last = said[said.length - 1]
  if (last?.role === 'user' && last.text === text.replace(/\s+/g, ' ').trim()) said.pop()
  if (said.length === 0) return 'none: this is the first message of the conversation.'
  return said
    .slice(-RECENT_ROWS)
    .map(one => `${one.role}: ${one.role === 'assistant' && one.text.length > 400 ? `…${one.text.slice(-400)}` : one.text.slice(0, 300)}`)
    .join('\n')
}

// Скиллы, которые Claude уже запускал в этом разговоре: второй раз их навязывать незачем.
// Claude зовёт скилл то с приставкой плагина (anthropic-skills:computer-use), то без неё.
function alreadyRun(rows: readonly SessionMessage[]): string[] {
  return rows.flatMap(one => one.toolUses)
    .filter(use => use.tool === 'Skill' && typeof use.input.skill === 'string')
    .map(use => String(use.input.skill).toLowerCase())
}

function sameSkill(a: string, b: string): boolean {
  return a === b || (!a.includes(':') && b.endsWith(`:${a}`)) || (!b.includes(':') && a.endsWith(`:${b}`))
}

async function pick($: EngineInterface, text: string, entries: readonly Entry[], conversation = recent([], text)): Promise<Entry[]> {
  if (entries.length === 0) return []
  const list = entries.map(one => `${one.name} — ${one.description}`).join('\n')
  const reply = await $.model.complete({
    model: 'haiku',
    system: INSTRUCTIONS,
    // Каталог одинаковый от запроса к запросу: держим его в кэше, платим только за разговор и запрос.
    prompt: [
      { text: `CATALOG:\n${list}`, cache: true },
      { text: `\n\nRECENT CONVERSATION:\n${conversation}\n\nLATEST MESSAGE:\n${text.slice(0, 2000)}` },
    ],
    // Строка TASK перед выбором заметно точнее на живой Haiku: сначала дело, потом скилл.
    maxTokens: 120,
    timeoutMs: 8000,
  })
  if (!reply.isAnswered) return []

  const byName = new Map(entries.map(one => [one.name.toLowerCase(), one]))
  const found: Entry[] = []
  for (const line of reply.text.split('\n')) {
    const name = line.trim().replace(/^[-*•\d.)\s/]+/, '').replace(/[`"']/g, '').toLowerCase()
    const entry = byName.get(name)
    if (entry && !found.includes(entry)) found.push(entry)
    if (found.length === 2) break
  }
  return found
}

function hint(picks: readonly Entry[]): string {
  const calls = picks.map(one => `Skill(skill: "${one.name}")`).join(', затем ')
  return 'Навигатор плагинов выбрал под этот запрос:\n' +
    picks.map(one => `- ${one.name}: ${one.description}`).join('\n') +
    `\nПервым действием запусти сам: ${calls}, и работай по нему. ` +
    'Не предлагай его пользователю и не спрашивай, запускать ли: просто запусти. ' +
    'Пользователю одной короткой строкой скажи, какой скилл взял. ' +
    'Если после запуска окажется, что скилл явно не про эту задачу, оставь его и делай без него.'
}

// Сводка установленного: плагин и сколько у него скиллов, с примерами.
function grouped(entries: readonly Entry[]): string {
  const groups = new Map<string, string[]>()
  for (const one of entries) {
    const [plugin, skill] = one.name.includes(':') ? one.name.split(':', 2) : ['свои', one.name]
    const list = groups.get(plugin ?? 'свои') ?? []
    list.push(skill ?? one.name)
    groups.set(plugin ?? 'свои', list)
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([plugin, skills]) => `• ${plugin} (${skills.length}): ${skills.slice(0, 5).join(', ')}${skills.length > 5 ? ', …' : ''}`)
    .join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    S.isOff = (await $.store.get('off')) === true
    await $.command.register({
      name: 'nav',
      description: 'Навигатор: /nav <задача> — какой скилл взять · /nav список · /nav выкл · /nav вкл',
      argumentHint: '<задача>',
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta || S.isOff) return next(e)
    // Набрано, пока Claude работает: это поправка по ходу, а не новая задача.
    if (e.turnId !== undefined && !e.wait) return next(e)
    const text = e.text.trim()
    if (text.length < 12 || text.startsWith('/') || SKIP.test(text)) return next(e)

    let rows: SessionMessage[] = []
    try {
      rows = await $.session.messages()
    } catch {
      rows = []
    }

    let picks: Entry[]
    try {
      const done = alreadyRun(rows)
      picks = (await pick($, text, await catalog($), recent(rows, text)))
        .filter(one => !done.some(name => sameSkill(name, one.name.toLowerCase())))
    } catch {
      return next(e)
    }
    if (picks.length === 0) return next(e)

    $.ui.toast(`🧭 Беру: ${picks.map(one => `/${one.name}`).join(', ')}`)
    return next({ ...e, context: [...(e.context ?? []), hint(picks)] })
  })

  on('command.run', { command: 'nav' }, async ($, e) => {
    const arg = e.args.trim()
    const word = arg.toLowerCase()

    if (word === 'выкл' || word === 'off') {
      S.isOff = true
      await $.store.set('off', true)
      return { text: 'Навигатор выключен. Включить: /nav вкл' }
    }
    if (word === 'вкл' || word === 'on') {
      S.isOff = false
      await $.store.set('off', false)
      return { text: 'Навигатор включён: перед каждой задачей подбирает скилл, и Claude сразу его запускает.' }
    }
    if (word === 'список' || word === 'list') {
      S.builtAt = 0
      const entries = await catalog($)
      return { text: `Установлено скиллов и команд: ${entries.length}\n${grouped(entries)}` }
    }
    if (arg === '') {
      return {
        text: [
          `Навигатор ${S.isOff ? 'выключен' : 'включён'}.`,
          'Сам подбирает скилл под каждую задачу, и Claude сразу его запускает.',
          '/nav <задача> — просто показать, какой скилл подойдёт, ничего не запуская',
          '/nav список — что установлено · /nav выкл · /nav вкл',
        ].join('\n'),
      }
    }

    const picks = await pick($, arg, await catalog($))
    if (picks.length === 0) return { text: `Для «${arg}» подходящего скилла не нашёл — Claude справится и без него.` }
    return {
      text: `Для «${arg}» навигатор возьмёт:\n` +
        picks.map(one => `/${one.name} — ${one.description}`).join('\n') +
        '\nПросто напиши задачу, и Claude сам запустит этот скилл.',
    }
  })
}
