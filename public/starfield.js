// Decorative starfield with occasional shooting stars. Static when the user prefers reduced motion.
const STAR_DENSITY = 1 / 9000;
const MAX_STARS = 180;
const FRAME_MS = 40;
const SHOOT_MIN_MS = 6000;
const SHOOT_SPREAD_MS = 8000;
const SHOOT_LIFE_MS = 900;
const SHOOT_SPEED = 0.9;
const TAIL = 140;

export function startSky(canvas) {
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let stars = [];
  let shot = null;
  let nextShot = performance.now() + SHOOT_MIN_MS;
  let last = 0;
  let raf = 0;

  const color = () => getComputedStyle(document.documentElement).getPropertyValue('--color-star').trim() || '#fff3c4';

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(MAX_STARS, Math.round(window.innerWidth * window.innerHeight * STAR_DENSITY));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight,
      r: Math.random() * 1.3 + 0.3, phase: Math.random() * Math.PI * 2, speed: Math.random() * 0.0015 + 0.0005,
    }));
    draw(performance.now());
  }

  function spawnShot(now) {
    shot = { x: Math.random() * window.innerWidth * 0.7, y: Math.random() * window.innerHeight * 0.4, born: now };
    nextShot = now + SHOOT_MIN_MS + Math.random() * SHOOT_SPREAD_MS;
  }

  function drawShot(now) {
    const age = now - shot.born;
    if (age > SHOOT_LIFE_MS) { shot = null; return; }
    const x = shot.x + age * SHOOT_SPEED;
    const y = shot.y + age * SHOOT_SPEED * 0.5;
    const fade = 1 - age / SHOOT_LIFE_MS;
    const grad = ctx.createLinearGradient(x, y, x - TAIL, y - TAIL / 2);
    grad.addColorStop(0, color());
    grad.addColorStop(1, 'transparent');
    ctx.globalAlpha = fade;
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - TAIL, y - TAIL / 2);
    ctx.stroke();
  }

  function draw(now) {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.fillStyle = color();
    for (const s of stars) {
      ctx.globalAlpha = reduced.matches ? 0.45 : 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(now * s.speed + s.phase));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (shot) drawShot(now);
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < FRAME_MS) return;
    last = now;
    if (!shot && now > nextShot) spawnShot(now);
    draw(now);
  }

  function sync() {
    cancelAnimationFrame(raf);
    if (reduced.matches || document.hidden) draw(performance.now());
    else raf = requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
  resize();
  sync();
}
