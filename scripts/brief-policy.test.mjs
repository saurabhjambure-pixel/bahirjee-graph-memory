/**
 * Brief attestation tests.
 *
 * The load-bearing one is the LAST block: every gate must be provably able to fail. That
 * property test is the only reason G6 (`insight_grounding`) was ever caught — it read a
 * brief that did not exist at `verify` time and therefore reported `pass` on every report
 * ever produced, for months, while looking like a working check. B1, B3 and B5 have
 * exactly that failure mode, so they get the same treatment.
 *
 * Run: npm run test:brief-policy
 */
import assert from 'node:assert/strict'
import { attestBrief, resolveBriefPolicyMode } from '../src/services/agents/policies/briefPolicy.js'
import { normalizeBrief, ADVICE_PHRASES } from '../src/services/briefSchema.js'
import { PROMPTS } from '../src/services/promptUtils.js'
import { PIPELINE_STEP_LABELS } from '../src/services/pipelineSteps.js'
import { BRIEF_POLICY_VERSION, GRAPH_VERSION, currentVersions } from '../src/services/pipelineVersions.js'
import { GRAPH_VERSION as REGISTRY_GRAPH_VERSION, agentForStep } from '../src/services/agents/registry.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`) }
}

const signalsFor = (n, host = 'src') =>
  Array.from({ length: n }, (_, i) => ({
    source_url: `https://${host}${i}.test/p${i}`,
    source_class: ['news', 'filing', 'review'][i % 3],
    the_move: `Move ${i}`,
    relevance_score: 100 - i,
  }))

/** A brief that passes every gate, built the way the pipeline builds one. */
const cleanBrief = (tier = 'full', signals = signalsFor(14)) => {
  const b = normalizeBrief(
    {
      bahirjee_observation: 'The market is consolidating around two players.',
      // B6 requires this. A brief that omits it is not "clean" — a live company brief
      // shipped with why_it_matters: "" and every other gate passed it.
      why_it_matters: 'Both remaining players now compete for the same mid-market accounts you sell into.',
      what_could_change_our_view: [
        { text: 'A third entrant raising a large round.' },
        { text: 'Either incumbent losing a flagship account.' },
      ],
      what_to_consider: [{ text: 'Speed and margin trade against each other here.' }],
    },
    { kind: 'company', signals, tier }
  )
  b.depth_gaps = tier === 'shallow' ? ['A full run reads roughly three times more sources.'] : []
  return b
}

// ── Mode resolution ─────────────────────────────────────────────────────────────
check('defaults to report, not enforce', () => {
  // Unlike the signal verifier. The only enforcing action available here would be
  // withholding a brief the founder already paid a full run for.
  assert.equal(resolveBriefPolicyMode({}), 'report')
  assert.equal(resolveBriefPolicyMode({ BRIEF_POLICY_MODE: 'enforce' }), 'enforce')
  assert.equal(resolveBriefPolicyMode({ BRIEF_POLICY_MODE: 'off' }), 'off')
  assert.equal(resolveBriefPolicyMode({ BRIEF_POLICY_MODE: 'nonsense' }), 'report')
})

// ── The step is where it has to be ──────────────────────────────────────────────
check('attest runs after summary and before persist', () => {
  const order = PIPELINE_STEP_LABELS.map(s => s.name)
  const at = (n) => order.indexOf(n)
  assert.ok(at('attest') > -1, 'attest is not registered in the pipeline')
  assert.ok(at('verify') < at('summary'), 'the signal gate must precede the brief')
  assert.ok(at('summary') < at('attest'), 'there is no brief to attest before summary — this is the G6 trap')
  assert.ok(at('attest') < at('persist'), 'attesting after persist would check a brief already published')
  // It corrects confidence in place, so everything downstream must see the correction.
  assert.equal(at('attest'), at('summary') + 1, 'attest must sit immediately after summary')
})

check('adding the step bumped BOTH graph versions, including the one with teeth', () => {
  // There are two exports named GRAPH_VERSION. `pipelineVersions` records the step list for
  // attribution and gates nothing; `agents/registry` is the one checkGraphCompatibility
  // compares a checkpoint against, so it is the one that actually stops a v2 checkpoint
  // from resuming into a pipeline whose brief is now attested. Bumping only the first
  // looks right and changes nothing.
  assert.notEqual(GRAPH_VERSION, 'v1', 'the step list changed without bumping pipelineVersions.GRAPH_VERSION')
  assert.notEqual(
    REGISTRY_GRAPH_VERSION, 'v2',
    'agents/registry.GRAPH_VERSION is still v2 — a checkpoint from before `attest` would resume '
    + 'and publish a brief that was never checked against its evidence'
  )
  assert.equal(currentVersions().brief_policy_version, BRIEF_POLICY_VERSION)
})

check('attest is owned by exactly one agent, and reaches no tools', () => {
  // A step with no owner fails the registry's structural check; a step that reaches a tool
  // its agent was not granted fails at runtime under strict enforcement. `attest` is a pure
  // policy pass, so the correct answer to "which tools" is none.
  const owner = agentForStep('attest')
  assert.ok(owner, 'attest has no owning agent')
  assert.ok(
    owner.steps.includes('summary'),
    'attest should sit with the agent that wrote the brief — any other owner splits a '
    + 'contiguous step range, which the registry rejects'
  )
})

// ── Individual gates ────────────────────────────────────────────────────────────
check('a clean brief passes every gate', () => {
  const r = attestBrief({ brief: cleanBrief(), signals: signalsFor(14), tier: 'full' }, { mode: 'enforce' })
  assert.equal(r.report.verdict, 'pass', JSON.stringify(r.report.gates.filter(g => g.status !== 'pass')))
  assert.equal(r.changed, false, 'a calibrated brief must not be rewritten')
})

check('B2 downgrades confidence the evidence does not support, and says so', () => {
  const brief = cleanBrief('full')
  brief.confidence = { level: 'High', basis: 'trust me' }
  const r = attestBrief({ brief, signals: signalsFor(2), tier: 'full' }, { mode: 'report' })
  assert.equal(r.brief.confidence.level, 'Low')
  assert.equal(r.brief.confidence.claimed, 'High', 'the overreach is recorded')
  assert.match(r.brief.confidence.basis, /Downgraded from High/)
  assert.equal(r.changed, true)
})

check('B2 caps a shallow run below High even on broad evidence — the paywall', () => {
  const signals = signalsFor(70)
  const brief = cleanBrief('shallow', signals)
  brief.confidence = { level: 'High', basis: 'claimed' }
  const r = attestBrief({ brief, signals, tier: 'shallow' }, { mode: 'report' })
  assert.equal(r.brief.confidence.level, 'Medium', 'a shallow run must never publish High confidence')
  // The same evidence at full depth may.
  const full = cleanBrief('full', signals)
  assert.equal(attestBrief({ brief: full, signals, tier: 'full' }, { mode: 'report' }).brief.confidence.level, 'High')
})

check('B4 detects advice but never rewrites it', () => {
  const brief = cleanBrief()
  brief.our_read = 'You should raise a Series A before the window closes.'
  const r = attestBrief({ brief, signals: signalsFor(14), tier: 'full' }, { mode: 'enforce' })
  const gate = r.report.gates.find(g => g.id === 'advice_leakage')
  assert.equal(gate.status, 'warn')
  assert.match(gate.detail, /you should/i)
  assert.equal(
    r.brief.our_read, brief.our_read,
    'the words must survive — rewriting them would delete the evidence that the prompt regressed'
  )
})

check('the prompts ban every phrase the B4 gate detects', () => {
  // These two lists were maintained separately and drifted. The prompt banned 10 phrases
  // while auditBriefVoice checked 16; "you must" was in the detector and not the prompt,
  // so a real brief shipped "you must invest heavily to keep pace with a dominant
  // competitor" in our_read — advice, in the field the product promises is judgment.
  //
  // B4 deliberately warns without rewriting, so the prompt is the ONLY thing that can
  // prevent the sentence existing. A prompt that bans less than the gate detects will
  // eventually ship the difference. Both must be generated from ADVICE_PHRASES.
  const rendered = [
    ['buildSummary', PROMPTS.buildSummary({ company_name: 'X', industry: 'y' }, [{ signal_headline: 's' }], {})],
    ['generateDecisionBrief', PROMPTS.generateDecisionBrief(
      { company_name: 'X', industry: 'y' }, { question: 'q' }, [{ signal_headline: 's' }], {}
    )],
  ]
  for (const [name, prompt] of rendered) {
    const missing = ADVICE_PHRASES.filter(phrase => !prompt.includes(`"${phrase}"`))
    assert.deepEqual(
      missing, [],
      `${name} does not ban ${missing.join(', ')} — the B4 gate flags these, so the prompt `
      + 'must forbid them. Derive the list from ADVICE_PHRASES rather than retyping it.'
    )
  }
})

check('the ban reaches our_read, not only the weighings', () => {
  // The leak shipped in bahirjee_observation (persisted as our_read), whose field spec
  // carried no constraint while the ALLOWED/BANNED block read as governing what_to_consider.
  const prompt = PROMPTS.buildSummary({ company_name: 'X', industry: 'y' }, [{ signal_headline: 's' }], {})
  assert.match(
    prompt, /governs EVERY field/,
    'the banned list must state that it applies to every field, not just the weighings'
  )
  assert.match(
    prompt.split('"bahirjee_observation"')[1]?.slice(0, 400) ?? '', /BANNED list above/,
    'bahirjee_observation is what ships as our_read — its field spec must carry the constraint'
  )
})

check('a non-object brief is blocked, not quietly passed', () => {
  // The G6 shape: reporting a verdict over something that was never there.
  for (const bad of [null, undefined, 'a string', 42]) {
    const r = attestBrief({ brief: bad, signals: signalsFor(5), tier: 'full' }, { mode: 'report' })
    assert.equal(r.report.verdict, 'blocked', `attesting ${JSON.stringify(bad)} must not pass`)
  }
})

check('the verdict is recorded separately from the signal verdict', () => {
  const r = attestBrief({ brief: cleanBrief(), signals: signalsFor(14), tier: 'full' }, { mode: 'report' })
  assert.equal(r.report.policy_version, BRIEF_POLICY_VERSION)
  assert.ok(r.report.counts && typeof r.report.counts.falsifiers === 'number')
})

// ── The property that catches a dead gate ───────────────────────────────────────
check('every gate can actually fail — none reports a verdict it did not compute', () => {
  const baselineSignals = signalsFor(14)
  const baseline = attestBrief({ brief: cleanBrief('full', baselineSignals), signals: baselineSignals, tier: 'full' }, { mode: 'enforce' })
  assert.equal(baseline.report.verdict, 'pass', 'the baseline fixture must itself be clean')

  // Taken from a live attestation rather than a list maintained here, so a newly added
  // gate is covered the moment it ships.
  const gateIds = baseline.report.gates.map(g => g.id)
  assert.ok(gateIds.length >= 5, `the policy reported suspiciously few gates: ${gateIds.join(', ')}`)

  const TRIP_FIXTURES = [
    {
      name: 'a stated change citing a source from no observation in this run',
      input: () => {
        const b = cleanBrief()
        b.what_changed = [{ text: 'Something happened.', evidence_refs: ['https://nowhere.invalid/x'] }]
        return { brief: b, signals: signalsFor(14), tier: 'full' }
      },
    },
    {
      name: 'confidence claimed above what the evidence supports',
      input: () => {
        const b = cleanBrief()
        b.confidence = { level: 'High', basis: 'claimed' }
        return { brief: b, signals: signalsFor(2), tier: 'full' }
      },
    },
    {
      name: 'a read with nothing that would overturn it',
      input: () => {
        const b = cleanBrief()
        b.what_could_change_our_view = []
        return { brief: b, signals: signalsFor(14), tier: 'full' }
      },
    },
    {
      name: 'a required narrative field the model returned empty',
      input: () => {
        // The exact live defect: the summary call omitted why_it_matters, clean(undefined)
        // produced '', and every other gate passed the brief — B4 finds no advice in an
        // empty string, B3 counts falsifiers, B2 counts signals.
        const b = cleanBrief()
        b.why_it_matters = ''
        return { brief: b, signals: signalsFor(14), tier: 'full' }
      },
    },
    {
      name: 'instructional language in the judgment',
      input: () => {
        const b = cleanBrief()
        b.what_to_consider = [{ text: 'You need to cut pricing immediately.' }]
        return { brief: b, signals: signalsFor(14), tier: 'full' }
      },
    },
    {
      name: 'a shallow run that discloses nothing',
      input: () => {
        const b = cleanBrief('shallow')
        b.depth_gaps = []
        return { brief: b, signals: signalsFor(14), tier: 'shallow' }
      },
    },
    {
      name: 'a brief that states no changes at all',
      input: () => {
        const b = cleanBrief()
        b.what_changed = []
        return { brief: b, signals: signalsFor(14), tier: 'full' }
      },
    },
  ]

  const trippedBy = new Map()
  for (const { name, input } of TRIP_FIXTURES) {
    for (const g of attestBrief(input(), { mode: 'enforce' }).report.gates) {
      if (g.status !== 'pass' && !trippedBy.has(g.id)) trippedBy.set(g.id, name)
    }
  }

  for (const id of gateIds) {
    assert.ok(
      trippedBy.has(id),
      `gate "${id}" cannot be made to fail by any defect this step can actually be handed. `
      + 'Either it reads something the call site never supplies — which is how '
      + '`insight_grounding` reported `pass` on every report ever produced — or this fixture '
      + 'list needs the case that trips it. Do not keep a gate that passes without checking.'
    )
  }
})

if (failures) {
  console.error(`\n${failures} brief policy check(s) failed.`)
  process.exit(1)
}
console.log('\nbrief policy tests passed')
