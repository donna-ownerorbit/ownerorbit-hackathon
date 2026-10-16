import type { BrowserContext, Page } from 'playwright'

/**
 * Stage mode: makes the automation legible to an audience. Injected into every page load:
 *  - a caption bar showing the iMessage being executed and the current step,
 *  - a ripple + outline on every element the agent clicks or types into.
 */
const OVERLAY = `(() => {
  if (window.__orbit) return
  const css = document.createElement('style')
  css.textContent = \`
    #orbit-bar{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483647;max-width:min(860px,90vw);
      background:rgba(17,17,24,.92);color:#fff;font:600 15px/1.35 -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;
      border-radius:18px;padding:12px 18px 12px 14px;display:flex;gap:12px;align-items:center;box-shadow:0 12px 40px rgba(0,0,0,.35);
      backdrop-filter:blur(8px);transition:opacity .25s;pointer-events:none}
    #orbit-bar .bubble{background:#0a84ff;border-radius:16px;padding:6px 12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%}
    #orbit-bar .step{opacity:.92;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #orbit-bar .dot{width:10px;height:10px;border-radius:50%;background:#30d158;flex:none;box-shadow:0 0 0 0 rgba(48,209,88,.7);animation:orbit-pulse 1.2s infinite}
    #orbit-bar.ok .dot{background:#30d158;animation:none}#orbit-bar.fail .dot{background:#ff453a;animation:none}
    @keyframes orbit-pulse{0%{box-shadow:0 0 0 0 rgba(48,209,88,.7)}70%{box-shadow:0 0 0 10px rgba(48,209,88,0)}100%{box-shadow:0 0 0 0 rgba(48,209,88,0)}}
    .orbit-ripple{position:fixed;z-index:2147483646;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;pointer-events:none;
      background:rgba(10,132,255,.55);animation:orbit-r .6s ease-out forwards}
    @keyframes orbit-r{to{transform:scale(5);opacity:0}}
    .orbit-focus{outline:3px solid #0a84ff !important;outline-offset:2px !important;transition:outline-color .3s}\`
  document.documentElement.appendChild(css)
  const flash = (el) => { if (!(el instanceof Element)) return; el.classList.add('orbit-focus'); setTimeout(() => el.classList.remove('orbit-focus'), 700) }
  addEventListener('mousedown', (e) => {
    const r = document.createElement('div'); r.className = 'orbit-ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'
    document.documentElement.appendChild(r); setTimeout(() => r.remove(), 650)
    flash(e.target.closest('button,a,input,textarea,select,.item-row,.mod-card,[role=switch]') || e.target)
  }, true)
  addEventListener('focusin', (e) => flash(e.target), true)
  window.__orbit = {
    caption(msg, step, state) {
      let bar = document.getElementById('orbit-bar')
      if (!bar) { bar = document.createElement('div'); bar.id = 'orbit-bar'; bar.innerHTML = '<span class="dot"></span><span class="bubble"></span><span class="step"></span>'; document.documentElement.appendChild(bar) }
      bar.className = state || ''
      bar.style.opacity = msg || step ? '1' : '0'
      bar.querySelector('.bubble').textContent = msg || ''
      bar.querySelector('.bubble').style.display = msg ? '' : 'none'
      bar.querySelector('.step').textContent = step || ''
    },
  }
  const saved = sessionStorage.getItem('__orbit_caption')
  if (saved) { const c = JSON.parse(saved); addEventListener('DOMContentLoaded', () => window.__orbit.caption(c.msg, c.step, c.state)) }
})()`

export async function installStage(ctx: BrowserContext) {
  await ctx.addInitScript(OVERLAY)
}

export async function caption(page: Page, msg: string, step: string, state: '' | 'ok' | 'fail' = '') {
  try {
    await page.evaluate(([m, s, st]) => {
      sessionStorage.setItem('__orbit_caption', JSON.stringify({ msg: m, step: s, state: st }))
      ;(window as unknown as { __orbit?: { caption: (a: string, b: string, c: string) => void } }).__orbit?.caption(m, s, st)
    }, [msg, step, state] as const)
  } catch { /* page navigating */ }
}
