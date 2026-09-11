#!/usr/bin/env node
// Regression check for the effort-scaled phase-1 window (bootstrapMaxTokensByEffort).
// Run: node tools/check-bootstrap-window.mjs
import { apply } from '../presets/two-stage-promotion/tool-bootstrap.mjs'

function harness (config) {
  const handlers = new Map()
  const logs = []
  const ctx = {
    logger: { warn: (...a) => logs.push(a.join(' ')), info () {}, debug () {}, error () {} },
    on (name, fn) { const l = handlers.get(name) ?? []; l.push(fn); handlers.set(name, l); return () => {} },
    emit () {},
    tools: {},
  }
  apply(ctx, config)
  const req = handlers.get('agent/request')
  if (req === undefined || req.length !== 1) throw new Error('agent/request hook not registered')
  return { handler: req[0], logs }
}

function makeAgent (events = []) {
  const emitted = []
  const session = { id: 'test-session', events, header: { cwd: '/tmp/ws' } }
  const noop = () => ({})
  const tools = new Proxy({ presentAs: noop }, { get: (t, k) => (k in t ? t[k] : noop) })
  const agent = { session, ctx: { emit: (n, p) => emitted.push([n, p]), tools, logger: { warn () {} } } }
  return { agent, emitted, session }
}

let pass = 0; let fail = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++; else fail++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  actual=' + JSON.stringify(actual) + (ok ? '' : '  expected=' + JSON.stringify(expected)))
}

const CONFIG = {
  shellTools: ['bash'],
  commonTools: [],
  messageSources: ['user', 'goal'],
  anchorGate: true,
  maxBootstrapSteps: 4,
  promoteAfterFirstResponse: true,
  bootstrapMaxTokens: 1024,
  bootstrapMaxTokensByEffort: { max: 2048 },
  compactionTools: ['read', 'write', 'edit', 'glob', 'grep'],
  deferredSources: ['agent-instructions', 'skill-catalog'],
  deferredGraceSteps: 1,
  promotedPresentation: 'ptc',
}

// 1. phase-1 window per resolved reasoning effort
{
  const { handler } = harness(CONFIG)
  const call = async resolved => handler({ agent: makeAgent().agent }, async () => resolved)
  check('phase1 max -> 2048', (await call({ reasoningEffort: 'max', maxTokens: 256000 })).maxTokens, 2048)
  check('phase1 high -> 1024', (await call({ reasoningEffort: 'high', maxTokens: 256000 })).maxTokens, 1024)
  check('phase1 low -> 1024', (await call({ reasoningEffort: 'low', maxTokens: 256000 })).maxTokens, 1024)
  check('phase1 off -> 1024', (await call({ reasoningEffort: 'off', maxTokens: 256000 })).maxTokens, 1024)
  check('phase1 no effort -> 1024', (await call({ maxTokens: 256000 })).maxTokens, 1024)
  check('phase1 unknown effort -> 1024', (await call({ reasoningEffort: 'turbo', maxTokens: 256000 })).maxTokens, 1024)
  check('phase1 keeps other fields', (await call({ reasoningEffort: 'max', model: 'deepseek-flash' })).model, 'deepseek-flash')
  check('phase1 does not touch effort', (await call({ reasoningEffort: 'max' })).reasoningEffort, 'max')
}

// 2. map without the scalar fallback
{
  const { handler } = harness({ ...CONFIG, bootstrapMaxTokens: undefined, bootstrapMaxTokensByEffort: { max: 2048 } })
  const call = async resolved => handler({ agent: makeAgent().agent }, async () => resolved)
  check('map-only max -> 2048', (await call({ reasoningEffort: 'max', maxTokens: 256000 })).maxTokens, 2048)
  check('map-only high -> uncapped', (await call({ reasoningEffort: 'high', maxTokens: 256000 })).maxTokens, 256000)
}

// 3. config validation
for (const [tag, value] of [['array', [1]], ['string', 'x'], ['non-integer', { max: 1.5 }], ['zero', { max: 0 }], ['empty key', { '': 1024 }]]) {
  let err = null
  try { harness({ ...CONFIG, bootstrapMaxTokensByEffort: value }) } catch (e) { err = e }
  check('rejects ' + tag, err !== null && /bootstrapMaxTokensByEffort/.test(String(err.message)), true)
}

// 4. promotion strips the whole applied set (anchorGate off: first tool/call promotes)
{
  const { handler } = harness({ ...CONFIG, anchorGate: false })
  const { agent } = makeAgent([{ type: 'tool/call', data: { turn: 1 } }])
  const call = async resolved => handler({ agent }, async () => resolved)
  check('promoted strips 2048', 'maxTokens' in (await call({ reasoningEffort: 'max', maxTokens: 2048 })), false)
  check('promoted strips 1024', 'maxTokens' in (await call({ reasoningEffort: 'high', maxTokens: 1024 })), false)
  check('promoted keeps foreign value', (await call({ reasoningEffort: 'high', maxTokens: 12345 })).maxTokens, 12345)
}

// 5. anchor gate: anchored first block + tool call promotes and strips
{
  const { handler } = harness(CONFIG)
  const events = [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'we need the shell' }] } } },
    { type: 'tool/call', data: { turn: 1 } },
  ]
  const { agent } = makeAgent(events)
  check('anchored+toolcall strips 2048', 'maxTokens' in (await handler({ agent }, async () => ({ reasoningEffort: 'max', maxTokens: 2048 }))), false)
}

// 6. judge untouched: a censored first turn (reasoning only, max-tokens) is released by
//    branch 4 (responded + turn end + promoteAfterFirstResponse) on the next assembly,
//    so the promoted request is no longer capped and the cap is not soldered in.
{
  const { handler } = harness(CONFIG)
  const events = [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'let me figure out where I am and what tools exist' }] }, usage: { outputTokens: 1024, reasoningTokens: 1024 } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } },
  ]
  const { agent } = makeAgent(events)
  const r = await handler({ agent }, async () => ({ reasoningEffort: 'max', maxTokens: 256000 }))
  check('censored turn -> released, uncapped', r.maxTokens, 256000)
}

// 7. anchor gate still holds: non-anchored first block, one tool call, turn still open
{
  const { handler } = harness(CONFIG)
  const events = [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'let me inspect the repository first' }] } } },
    { type: 'tool/call', data: { turn: 1 } },
  ]
  const { agent } = makeAgent(events)
  const r = await handler({ agent }, async () => ({ reasoningEffort: 'max', maxTokens: 256000 }))
  check('gate holds: still capped', r.maxTokens, 2048)
}

// 8. step fallback: not anchored but maxBootstrapSteps reached -> promoted
{
  const { handler } = harness(CONFIG)
  const events = [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'let me inspect the repository first' }] } } },
    { type: 'tool/call', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1 } },
  ]
  const { agent } = makeAgent(events)
  const r = await handler({ agent }, async () => ({ reasoningEffort: 'max', maxTokens: 2048 }))
  check('fallback promotes + strips', 'maxTokens' in r, false)
}

console.log('')
console.log('passed ' + pass + ', failed ' + fail)
process.exit(fail === 0 ? 0 : 1)
