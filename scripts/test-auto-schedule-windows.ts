import { WINDOWS, randomTimeInWindow } from '../src/lib/instagram/auto-schedule'

let failed = 0

function check(name: string, cond: boolean) {
  if (cond) {
    console.log('ok', name)
  } else {
    console.error('FAIL', name)
    failed++
  }
}

// Windows exist, are ordered, and don't overlap.
check('has 3 windows', WINDOWS.length === 3)
for (let i = 0; i < WINDOWS.length; i++) {
  check(`window ${i} (${WINDOWS[i].label}) start < end`, WINDOWS[i].startHour < WINDOWS[i].endHour)
  if (i > 0) {
    check(
      `window ${i} (${WINDOWS[i].label}) starts after window ${i - 1} (${WINDOWS[i - 1].label}) ends`,
      WINDOWS[i].startHour >= WINDOWS[i - 1].endHour,
    )
  }
}

// randomTimeInWindow: every sample lands inside [startHour, endHour) on the given day,
// and repeated calls actually vary (not a constant/broken RNG).
const day = new Date('2026-08-15T00:00:00')
for (const window of WINDOWS) {
  const samples: number[] = []
  for (let i = 0; i < 200; i++) {
    const t = randomTimeInWindow(day, window)
    samples.push(t.getTime())

    const inRange = t.getHours() >= window.startHour && t.getHours() < window.endHour
    if (!inRange) {
      console.error('FAIL', window.label, 'sample out of range:', t.toString())
      failed++
    }
    const sameDay = t.getFullYear() === day.getFullYear()
      && t.getMonth() === day.getMonth()
      && t.getDate() === day.getDate()
    if (!sameDay) {
      console.error('FAIL', window.label, 'sample rolled onto a different day:', t.toString())
      failed++
    }
  }
  const unique = new Set(samples).size
  check(`${window.label}: 200 samples land in range, day unchanged, and vary (${unique} unique)`, unique > 1)
}

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
