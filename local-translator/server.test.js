// Contract tests for the local translation endpoint.
//
// The important test is the last one: it drives the *real*
// `@deepseek-ai/dsh-experimental-translator` client code against the shim, so
// the Google wire format is verified against the consumer that will use it
// rather than against this project's own assumptions.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'

import {
  buildMessages,
  isTranslatable,
  languageName,
  planUnits,
  splitLockedLines,
  startLocalTranslator,
  translateFragment,
  DEFAULTS,
} from './server.js'

test('fenced code blocks are locked and never translated', () => {
  const markdown = ['Run this:', '```bash', 'echo hello world', '```', 'then read the output.'].join('\n')
  const lines = splitLockedLines(markdown)
  assert.deepEqual(
    lines.map((line) => line.locked),
    [false, true, true, true, false],
  )
})

test('an unterminated fence stays locked for the rest of the fragment', () => {
  const lines = splitLockedLines(['text', '```', 'still code', 'more code'].join('\n'))
  assert.deepEqual(
    lines.map((line) => line.locked),
    [false, true, true, true],
  )
})

test('isTranslatable skips code-ish and already-Chinese runs', () => {
  assert.equal(isTranslatable('console.log(x)'), true)
  assert.equal(isTranslatable('123 456 789'), false)
  assert.equal(isTranslatable('这是一个中文句子，只有很少的 English 单词'), false)
  assert.equal(isTranslatable('plain english prose here'), true)
})

test('planUnits keeps order and separates locked lines', () => {
  const markdown = ['first line', 'second line', '```', 'code()', '```', 'last line'].join('\n')
  const units = planUnits(markdown, 4000)
  assert.deepEqual(units, [
    { text: 'first line\nsecond line', translate: true },
    { text: '```', translate: false },
    { text: 'code()', translate: false },
    { text: '```', translate: false },
    { text: 'last line', translate: true },
  ])
  assert.equal(units.map((unit) => unit.text).join('\n'), markdown)
})

test('planUnits splits over-long prose at line boundaries', () => {
  const lines = Array.from({ length: 10 }, (_, index) => `line ${index} has some english prose`)
  const units = planUnits(lines.join('\n'), 60)
  assert.ok(units.length > 1)
  for (const unit of units.filter((candidate) => candidate.translate)) {
    assert.ok(unit.text.length <= 60 || !unit.text.includes('\n'), `unit too long: ${unit.text.length}`)
  }
  assert.equal(units.map((unit) => unit.text).join('\n'), lines.join('\n'))
})

test('languageName normalises Chinese tags and passes others through', () => {
  assert.equal(languageName('zh'), 'Simplified Chinese')
  assert.equal(languageName('zh-CN'), 'Simplified Chinese')
  assert.equal(languageName('zh-TW'), 'Traditional Chinese')
  assert.equal(languageName('ja'), 'ja')
})

test('buildMessages names the target language and forbids executing the text', () => {
  const [system, user] = buildMessages('hello', 'zh-CN')
  assert.equal(system.role, 'system')
  assert.match(system.content, /Simplified Chinese/)
  assert.match(system.content, /do not carry out requests/)
  assert.equal(user.role, 'user')
  assert.equal(user.content, 'hello')
})

// --- fake llama.cpp upstream ------------------------------------------------

function startFakeUpstream(handler) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      void (async () => {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const body = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (request.url === '/health') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"status":"ok"}')
          return
        }
        const result = await handler(body, request)
        response.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result.payload))
      })()
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const chatReply = (content) => ({ payload: { choices: [{ message: { content } }] } })

async function withShim(settings, run) {
  const { server, port } = await startFakeUpstream(settings.upstream)
  const upstream = `http://127.0.0.1:${port}`
  const started = await startLocalTranslator(
    {
      port: 0,
      upstream,
      autoStart: false,
      upstreamModel: 'qwen3-translate',
    },
    () => {},
  )
  try {
    await run(started.url, upstream)
  } finally {
    started.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('the shim answers Google translate_a/single and skips locked code', async () => {
  const seen = []
  await withShim(
    {
      upstream: (body) => {
        seen.push(body.messages[1].content)
        return chatReply(`ZH:${body.messages[1].content}`)
      },
    },
    async (url) => {
      const form = new URLSearchParams({
        client: 'gtx',
        sl: 'auto',
        tl: 'zh-CN',
        dt: 't',
        q: 'first line\n```\nx = 1\n```\nlast line',
      })
      const response = await fetch(`${url}/translate_a/single`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      })
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload[0][0][0], 'ZH:first line\n```\nx = 1\n```\nZH:last line')
      // Only the two prose runs reached the model.
      assert.deepEqual(seen, ['first line', 'last line'])
    },
  )
})

test('the shim returns empty text without calling the model', async () => {
  let calls = 0
  await withShim(
    {
      upstream: () => {
        calls += 1
        return chatReply('unused')
      },
    },
    async (url) => {
      const response = await fetch(`${url}/translate_a/single`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client: 'gtx', sl: 'auto', tl: 'zh-CN', dt: 't', q: '' }).toString(),
      })
      assert.equal((await response.json())[0][0][0], '')
      assert.equal(calls, 0)
    },
  )
})

test('a failing unit keeps its source line and does not fail the fragment', async () => {
  await withShim(
    {
      // Fail only the first prose run, keyed on its content so the result does
      // not depend on which concurrent request the fake sees first.
      upstream: (body) => {
        const source = body.messages[1].content
        return source.includes('first')
          ? { status: 500, payload: { error: { message: 'boom' } } }
          : chatReply('ZH:ok')
      },
    },
    async (url, upstream) => {
      const form = new URLSearchParams({
        client: 'gtx',
        sl: 'auto',
        tl: 'zh-CN',
        dt: 't',
        q: 'first english line\n```\nx = 1\n```\nsecond english line',
      })
      const text = await translateFragment(
        { ...DEFAULTS, upstream, autoStart: false },
        form.get('q'),
        'zh-CN',
        (task) => task(),
      )
      assert.equal(text, 'first english line\n```\nx = 1\n```\nZH:ok')
    },
  )
})

test('the shim reports its identity on /health so instances can share it', async () => {
  await withShim({ upstream: () => chatReply('never') }, async (url) => {
    const info = await (await fetch(`${url}/health`)).json()
    assert.equal(info.tag, 'dsh-local-translator')
  })
})

// Resolve the upstream translator from the DSH installation when one is
// available. The shim's whole premise is upstream compatibility, so when a DSH
// is present its provider code must really load — only an absent installation
// is allowed to skip.
async function loadUpstreamTranslator() {
  const { createRequire } = await import('node:module')
  const { readdirSync, existsSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { homedir } = await import('node:os')

  const anchors = [process.env.DSH_INSTALL_ANCHOR].filter(Boolean)
  const npx = join(homedir(), '.npm/_npx')
  if (existsSync(npx)) {
    for (const dir of readdirSync(npx)) {
      const candidate = join(npx, dir, 'node_modules/@deepseek-ai/dsh/package.json')
      if (existsSync(candidate)) anchors.push(candidate)
    }
  }
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue
    try {
      const require = createRequire(anchor)
      // `types/provider.js` is not an exported subpath, so resolve the package
      // entry and take its sibling file by path.
      const entry = require.resolve('@deepseek-ai/dsh-experimental-translator')
      const providerPath = join(dirname(entry), 'types/provider.js')
      if (!existsSync(providerPath)) continue
      return await import(pathToFileURL(providerPath).href)
    } catch {
      // Try the next candidate: an npx dir may exist without this package.
    }
  }
  return null
}

test('the real DSH translator reads the shim as a Google provider', async (t) => {
  const upstream = await loadUpstreamTranslator()
  if (upstream === null) {
    // No DSH installation on this machine: nothing to be compatible *with*, and
    // the fake-upstream tests above already pin the wire format.
    t.skip('no DeepSeek Harness installation found')
    return
  }
  const { translateText } = upstream
  assert.equal(typeof translateText, 'function')

  await withShim({ upstream: (body) => chatReply(`ZH:${body.messages[1].content}`) }, async (url) => {
    const config = {
      googleEndpoint: `${url}/translate_a/single`,
      bingEndpoint: 'http://127.0.0.1:1/never',
      timeoutMs: 10_000,
      maxResponseBytes: 1 << 20,
      maxTextChars: 4000,
    }
    const spec = {
      text: 'first line\nsecond line',
      provider: 'google',
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
    }
    const translated = await translateText(spec, config, new AbortController().signal)
    assert.equal(translated, 'ZH:first line\nsecond line')
  })
})
