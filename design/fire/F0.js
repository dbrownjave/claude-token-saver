/* F0: the shipped bursts (register.js shadeCell + burstsAt), knob removed. The baseline every fire option is measured against. */
window.FIRE_OPTIONS.push({
  id: 'F0',
  name: 'Shipped bursts, no knob',
  note: 'The shader in register.js today. Bursts race out from the head in every direction, and nothing is white-hot. Needs the shipped shader, so it is blank when the page is opened from a file.',
  frame(bar, t) {
    if (!bar.lib) return null
    const row = { id: 'ctx' + bar.seed, state: bar.inkName, live: bar.live, shown: bar.shown, settledAt: 0 }
    const seed = bar.lib.rowSeed(row)
    return { row, seed, bursts: bar.lib.burstsAt(row, t, seed) }
  },
  shade(cx, cy, bar, t, s) {
    if (!s) return null
    return bar.lib.shadeCell(s.row, cx, cy, bar.cols, bar.rows, t, s.bursts, s.seed, bar.pitch, bar.W)
  },
})
