// ---------- Build the waveform bars ----------
const barsEl = document.getElementById('bars');
const BAR_COUNT = 64;
const bars = [];

for (let i = 0; i < BAR_COUNT; i++) {
  const bar = document.createElement('div');
  bar.className = 'bar idle';
  // roughly every 3rd-4th bar carries "voice" — sparser than the noise
  const isVoice = i % 4 === 0 || i % 7 === 0;
  if (isVoice) bar.classList.add('is-voice');
  bar.dataset.voice = isVoice ? '1' : '0';

  const h1 = (0.2 + Math.random() * 0.35).toFixed(2);
  const h2 = (0.5 + Math.random() * 0.5).toFixed(2);
  const dur = (0.6 + Math.random() * 0.8).toFixed(2);
  const delay = (Math.random() * 0.8).toFixed(2);

  bar.style.setProperty('--h1', h1);
  bar.style.setProperty('--h2', h2);
  bar.style.setProperty('--dur', dur + 's');
  bar.style.setProperty('--delay', delay + 's');

  barsEl.appendChild(bar);
  bars.push(bar);
}

// ---------- Master timeline ----------
const blade = document.getElementById('blade');
const stage = document.querySelector('.hero-stage');
const wordmarkLetters = document.querySelectorAll('#wordmark span');
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function shatterBar(bar) {
  const barRect = bar.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const bw = barRect.width;
  const bh = barRect.height * Math.max(0.05, getComputedScale(bar)); // visible height after scaleY

  const originX = barRect.left - stageRect.left;
  const originY = barRect.top - stageRect.top + (barRect.height - bh);

  const fragCount = 3 + Math.floor(Math.random() * 2); // 3-4 shards
  const pieceH = bh / fragCount;

  bar.style.opacity = '0'; // hide the original instantly, shards take over

  for (let i = 0; i < fragCount; i++) {
    const shard = document.createElement('div');
    shard.className = 'shard';
    shard.style.width = bw + 'px';
    shard.style.height = Math.max(2, pieceH - 1) + 'px';
    shard.style.left = originX + 'px';
    shard.style.top = originY + i * pieceH + 'px';
    stage.appendChild(shard);

    const dir = Math.random() < 0.5 ? -1 : 1;
    gsap.to(shard, {
      x: dir * (20 + Math.random() * 60),
      y: 50 + Math.random() * 90,
      rotation: dir * (120 + Math.random() * 300),
      opacity: 0,
      duration: 0.55 + Math.random() * 0.35,
      ease: 'power2.in',
      onComplete: () => shard.remove(),
    });
  }
}

function getComputedScale(el) {
  const t = getComputedStyle(el).transform;
  if (t === 'none') return 1;
  const m = new DOMMatrix(t);
  return Math.abs(m.d) || 1;
}

function runIntro() {
  if (prefersReducedMotion) {
    // skip straight to the settled state, no motion
    bars.forEach((bar) => {
      bar.classList.remove('idle');
      if (bar.dataset.voice === '1') {
        gsap.set(bar, { scaleY: 0.6 });
      } else {
        gsap.set(bar, { scaleY: 0, opacity: 0 });
      }
    });
    gsap.set(wordmarkLetters, { opacity: 1, y: 0 });
    gsap.set(['#tagline', '#hero-actions', '#scroll-cue'], { opacity: 1 });
    return;
  }

  const tl = gsap.timeline({ delay: 0.3 });

  // let the chaotic waveform breathe for a moment
  tl.to({}, { duration: 1.1 });

  // sweep the blade left -> right
  tl.set(blade, { opacity: 1 });
  tl.to(blade, {
    left: '105%',
    duration: 1.3,
    ease: 'power2.inOut',
    onUpdate: function () {
      const progress = this.progress();
      const stageWidth = barsEl.getBoundingClientRect().width;
      const bladeX = -0.05 * stageWidth + progress * (1.10 * stageWidth);
      const containerLeft = barsEl.getBoundingClientRect().left;

      bars.forEach((bar) => {
        if (bar.dataset.cut === '1') return;
        const rect = bar.getBoundingClientRect();
        const barX = rect.left - containerLeft;
        if (barX <= bladeX) {
          bar.dataset.cut = '1';
          bar.classList.remove('idle');
          if (bar.dataset.voice === '1') {
            // voice survives: settle to a clean, steady height
            gsap.to(bar, {
              scaleY: 0.55 + Math.random() * 0.15,
              duration: 0.35,
              ease: 'back.out(2)',
            });
          } else {
            // noise gets smashed apart into falling shards
            shatterBar(bar);
          }
        }
      });
    },
  });

  tl.to(blade, { opacity: 0, duration: 0.25 }, '-=0.1');

  tl.addLabel('reveal');

  // wordmark letters rise into place, voice-colored letters (U, V) already styled via CSS
  tl.to(
    wordmarkLetters,
    {
      opacity: 1,
      y: 0,
      duration: 0.55,
      ease: 'back.out(1.7)',
      stagger: 0.045,
    },
    'reveal'
  );

  tl.to('#tagline', { opacity: 1, duration: 0.6, ease: 'power1.out' }, 'reveal+=0.2');
  tl.to('#hero-actions', { opacity: 1, duration: 0.6, ease: 'power1.out' }, 'reveal+=0.35');
  tl.to('#scroll-cue', { opacity: 1, duration: 0.6 }, 'reveal+=0.35');

  // finally, split what's left of the voice row apart — left half slides left, right half slides right
  // starts at the SAME instant PUREVOX begins appearing, not after
  const survivors = bars.filter((b) => b.dataset.voice === '1');
  const mid = survivors.length / 2;
  const leftHalf = survivors.slice(0, Math.ceil(mid));
  const rightHalf = survivors.slice(Math.ceil(mid));

  tl.to(
    leftHalf,
    { x: '-=140', opacity: 0, duration: 0.7, ease: 'power2.in', stagger: 0.015 },
    'reveal'
  );
  tl.to(
    rightHalf,
    { x: '+=140', opacity: 0, duration: 0.7, ease: 'power2.in', stagger: -0.015 },
    'reveal'
  );

  return tl;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runIntro);
} else {
  runIntro();
}

// ---------- Fade the scroll cue once the user actually scrolls ----------
window.addEventListener(
  'scroll',
  () => {
    gsap.to('#scroll-cue', { opacity: 0, duration: 0.3 });
  },
  { once: true }
);

// ---------- Smart download: detect OS (and Mac chip) to recommend a file ----------
(function () {
  const REL = 'https://github.com/meko568/purevox/releases/latest/download/';

  function detectAppleSilicon() {
    // Apple Silicon Macs expose an "Apple M#" / "Apple GPU" WebGL renderer string;
    // Intel Macs report an Intel/AMD/Nvidia string instead. Best-effort, not 100%,
    // but the full list below covers anyone this guesses wrong for.
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      if (renderer && /Apple (M\d|GPU)/i.test(renderer)) return true;
    } catch (e) {}
    return false;
  }

  function detect() {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';

    if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
      const isAppleSilicon = detectAppleSilicon();
      return {
        label: 'Recommended for macOS' + (isAppleSilicon ? ' (Apple Silicon)' : ' (Intel)'),
        file: isAppleSilicon ? 'PureVox_aarch64.dmg' : 'PureVox_x64.dmg',
        sub: isAppleSilicon ? 'For M1/M2/M3/M4 Macs' : 'For Intel Macs',
      };
    }
    if (/Win/i.test(platform) || /Windows/i.test(ua)) {
      return {
        label: 'Recommended for Windows',
        file: 'PureVox_x64-setup.exe',
        sub: '64-bit installer',
      };
    }
    if (/Linux/i.test(platform) || /Linux/i.test(ua)) {
      return {
        label: 'Recommended for Linux',
        file: 'PureVox_amd64.AppImage',
        sub: 'Runs on most distros, no install needed',
      };
    }
    return null;
  }

  function applySmartDownload() {
    const box = document.getElementById('smart-download');
    if (!box) return;
    const labelEl = document.getElementById('sd-label');
    const fileEl = document.getElementById('sd-file');
    const subEl = document.getElementById('sd-sub');
    const btnEl = document.getElementById('sd-btn');

    const result = detect();
    if (!result) {
      box.style.display = 'none';
      return;
    }
    labelEl.textContent = result.label;
    fileEl.textContent = result.file;
    subEl.textContent = result.sub;
    btnEl.href = REL + result.file;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applySmartDownload);
  } else {
    applySmartDownload();
  }
})();

// ---------- Low-RAM warning: nudge toward CLI on weak devices ----------
(function () {
  function checkRam() {
    // navigator.deviceMemory is Chrome/Edge/Android only (rounded, capped at 8).
    // Unsupported browsers (Safari/Firefox) just won't see this warning.
    const ram = navigator.deviceMemory;
    if (typeof ram !== 'number') return;
    if (ram < 8) {
      const box = document.getElementById('ram-warning');
      if (box) box.style.display = 'flex';
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkRam);
  } else {
    checkRam();
  }
})();

// ---------- Mobile detection: swap desktop download grid for Colab notebook ----------
(function () {
  function isMobile() {
    const ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobi/i.test(ua)) return true;
    // iPadOS 13+ reports as Mac but has touch support
    if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;
    return false;
  }

  function applyMobileView() {
    if (!isMobile()) return;
    const smart = document.getElementById('smart-download');
    const all = document.getElementById('all-downloads');
    const colab = document.getElementById('mobile-colab');
    const ramWarn = document.getElementById('ram-warning');
    if (smart) smart.style.display = 'none';
    if (all) all.style.display = 'none';
    if (ramWarn) ramWarn.style.display = 'none'; // desktop RAM advice is irrelevant on mobile
    if (colab) colab.style.display = 'block';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyMobileView);
  } else {
    applyMobileView();
  }
})();

// ---------- CLI script: force download instead of opening raw text in the tab ----------
// raw.githubusercontent.com serves the file as text/plain, so a plain <a> just
// displays it. Fetch it ourselves and save it as a Blob instead.
(function () {
  const btn = document.getElementById('cli-download-btn');
  if (!btn) return;

  btn.addEventListener('click', async function (e) {
    e.preventDefault();
    const url = btn.getAttribute('href');
    const originalText = btn.textContent;
    btn.textContent = 'Downloading…';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const blob = new Blob([text], { type: 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = 'purevox';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      // Network hiccup or CORS block — fall back to opening it directly
      window.open(url, '_blank', 'noopener');
    } finally {
      btn.textContent = originalText;
    }
  });
})();
