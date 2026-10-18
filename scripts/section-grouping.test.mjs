/**
 * Section grouping guards — the nav count and the page content must be the same number.
 *
 * This exists because of a specific production failure: a live run showed "Competition 11"
 * in the sidebar and rendered a blank page. A section that promises content and delivers
 * none reads as broken, not as loading — it is strictly worse than showing nothing.
 *
 * The grouping used to be an inline IIFE inside ReportWorkspace, where it summed
 * `meta.count` from its inputs while separately concatenating `subsections`. Two numbers
 * derived independently can drift. Now the count IS the merged array's length, and these
 * assertions pin that they can never be computed apart again.
 *
 * Run: npm run test:section-grouping
 */
import assert from 'node:assert/strict'

import { groupSectionsForDisplay, SECTION_MAP, INTRO_SECTION } from '../src/services/signalTaxonomy.js'

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

const sig = (i) => ({ signal_headline: `S${i}`, source_url: `https://ex.com/${i}` })
const section = (category, title, n) => ({
  id: `sec-${category.toLowerCase()}`,
  title,
  category,
  meta: { count: n },
  subsections: Array.from({ length: n }, (_, i) => sig(`${category}-${i}`))
})

// The invariant, asserted everywhere rather than in one place.
const assertCountMatchesContent = (out, where) => {
  for (const s of out) {
    assert.equal(
      s.meta.count, s.subsections.length,
      `${where}: "${s.title}" claims ${s.meta.count} but holds ${s.subsections.length}`
    )
  }
}

console.log('\nSection grouping\n')

check('count equals rendered content for every grouped section', () => {
  const out = groupSectionsForDisplay([
    section('CompetitorFunding', 'Competitor Funding', 4),
    section('CompetitorLaunch', 'Competitor Launch', 7),
    section('DemandSignal', 'Demand Signal', 3)
  ])
  assertCountMatchesContent(out, 'grouped')
  const competition = out.find(s => s.title === 'Competition')
  assert.equal(competition.meta.count, 11, 'the two competitor categories merge into one count')
  assert.equal(competition.subsections.length, 11, 'and that many signals are actually there')
})

check('the exact production case: Competition 11 must not be empty', () => {
  // Reproduces the real run's category mix.
  const out = groupSectionsForDisplay([
    section('CompetitorFunding', 'Competitor Funding', 5),
    section('CompetitorHiring', 'Competitor Hiring', 3),
    section('CompetitorLayoff', 'Competitor Layoff', 1),
    section('CompetitorLaunch', 'Competitor Launch', 2)
  ])
  const competition = out.find(s => s.title === 'Competition')
  assert.equal(competition.meta.count, 11)
  assert.ok(competition.subsections.length > 0, 'a non-zero count must never render empty')
  assert.equal(competition.subsections.length, competition.meta.count)
})

check('categories with no SECTION_MAP home survive as their own sections', () => {
  // The model does emit these — both appeared in a real run and neither is in SECTION_MAP.
  const out = groupSectionsForDisplay([
    section('CompetitorAward', 'Competitor Award', 1),
    section('CompetitorProduct', 'Competitor Product', 1),
    section('DemandSignal', 'Demand Signal', 2)
  ])
  assertCountMatchesContent(out, 'passthrough')
  assert.ok(out.find(s => s.title === 'Competitor Award'), 'an unmapped category must not be dropped')
  assert.ok(out.find(s => s.title === 'Competitor Product'))
  const total = out.reduce((n, s) => n + s.subsections.length, 0)
  assert.equal(total, 4, 'no signal may be lost in grouping')
})

check('stays consistent as categories arrive one at a time (a live run)', () => {
  // The failure only showed up mid-run, so grow the input the way a run does.
  const all = [
    section('DemandSignal', 'Demand Signal', 2),
    section('CompetitorFunding', 'Competitor Funding', 3),
    section('RegulatoryChange', 'Regulatory Change', 1),
    section('CompetitorAward', 'Competitor Award', 1),
    section('CompetitorLaunch', 'Competitor Launch', 4)
  ]
  for (let n = 1; n <= all.length; n++) {
    const out = groupSectionsForDisplay(all.slice(0, n))
    assertCountMatchesContent(out, `after ${n} categories`)
    const total = out.reduce((acc, s) => acc + s.subsections.length, 0)
    const expected = all.slice(0, n).reduce((acc, s) => acc + s.subsections.length, 0)
    assert.equal(total, expected, `after ${n} categories, signals were lost`)
  }
})

check('section ids are stable as new categories appear', () => {
  // Index-derived ids renumbered on every arrival, so the founder's selected tab silently
  // started showing a different section's content.
  const a = groupSectionsForDisplay([section('CompetitorFunding', 'Competitor Funding', 1)])
  const b = groupSectionsForDisplay([
    section('DemandSignal', 'Demand Signal', 1),
    section('CompetitorFunding', 'Competitor Funding', 1),
    section('RegulatoryChange', 'Regulatory Change', 1)
  ])
  const idOf = (out) => out.find(s => s.title === 'Competition').id
  assert.equal(idOf(a), idOf(b), 'a section id must not depend on what else is present')
})

check('every SECTION_MAP category groups to its declared section', () => {
  for (const [display, categories] of Object.entries(SECTION_MAP)) {
    for (const cat of categories) {
      const out = groupSectionsForDisplay([section(cat, cat, 1)])
      assert.equal(out[0].title, display, `${cat} should group under ${display}`)
      assert.equal(out[0].subsections.length, 1)
    }
  }
})

check('degrades safely on malformed input rather than throwing', () => {
  assert.deepEqual(groupSectionsForDisplay([]), [])
  assert.deepEqual(groupSectionsForDisplay(null), [])
  assert.deepEqual(groupSectionsForDisplay(undefined), [])
  assert.doesNotThrow(() => groupSectionsForDisplay([null, undefined]))
  // A section with no subsections array must report zero, not a stale count.
  const out = groupSectionsForDisplay([{ category: 'CompetitorFunding', title: 'x', meta: { count: 9 } }])
  assert.equal(out[0].meta.count, 0, 'a count must never outlive the content it described')
})

check('the intro section passes through untouched', () => {
  const intro = { id: 'intro', title: INTRO_SECTION, type: 'intro', insights: [], meta: { count: 0 } }
  const out = groupSectionsForDisplay([intro, section('DemandSignal', 'Demand Signal', 1)])
  const found = out.find(s => s.id === 'intro')
  assert.ok(found, 'intro must survive grouping')
  assert.equal(found.type, 'intro')
  assert.equal(out[0].id, 'intro', 'and sort first')
})

console.log(`\n${passed} checks passed\n`)
